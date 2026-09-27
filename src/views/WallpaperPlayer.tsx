import { useEffect, useState, useRef, useCallback, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Asset } from '../api/assets';
import { loadBlob, loadBlobUrl, loadThumb, revoke, appliesExifOrientation } from '../api/media';
import {
  thumbnailUrl,
  videoStreamUrl,
  originalUrl,
  originalStreamUrl,
  getAssetLocation,
  getAssetOrientation,
  getAssetPixels,
} from '../api/client';
import { Key, isBack, dirFromKey } from '../nav/keys';
import { duckMusic, takeClipWarmup, useMusic } from '../api/music';
import { keepAwake } from '../api/screensaver';
import { Icon } from '../components/Icon';
import type { PlaceOf } from '../components/PhotoGrid';
import {
  getLivePlay,
  setLivePlay,
  getVideoQuality,
  setVideoQuality,
  VideoQuality,
  getOverlayHidden,
} from '../settings';
import { aimAtFaces } from './faceCrop';
import { SeenStore } from './wallpaperSeen';

interface Props {
  assets: Asset[];
  // 'photos': the Slideshow page's show — shuffled, auto-advancing, landscape
  // stills face-cropped to fill the screen.
  // 'viewer': the photo viewer opened from a grid — starts PAUSED on
  // `startIndex` in list order and only runs as a slideshow once play is
  // pressed. Every photo is shown whole over a blurred fill, photos zoom with
  // the scroll wheel, Live Photos play their motion, and videos play with their
  // own sound and a seek bar. Any clip playing, in either mode, fades the
  // app's background music out first (see duckMusic).
  mode: 'photos' | 'viewer';
  startIndex?: number;
  // `shown` is the item on screen at exit, so the grid can refocus it
  onExit: (shown: Asset | null) => void;
  // called when nearing the end of the loaded list so more buckets can load
  onNearEnd?: () => void;
  // called when the user toggles shuffle. The feed randomizes its remaining
  // bucket order so shuffle spans the whole source, not just the loaded page.
  onShuffleChange?: (on: boolean) => void;
  // offer the Shuffle button: the Slideshow page and albums do, the all-photos
  // views don't
  canShuffle?: boolean;
  // what this source has already shown: shuffle skips these
  seen: SeenStore;
  // viewer opened from a grid: a photo's place in all of it, for the "12 / 340"
  // by its play button (else its place in the list the viewer walks)
  placeOf?: PlaceOf;
}

// The d-pad drives one group of controls at a time, stepped through with
// Down/Up in the order they sit on screen, top to bottom: 'nav' (Left/Right =
// previous/next item, the side arrows; always the default so the arrows never
// change meaning on their own), 'seek' (Left/Right jump the clip, the video
// transport above the bar; viewer videos only) and 'bar' (Left/Right walk the
// options bar along the bottom edge). The selected group's controls are ringed.
type Group = 'nav' | 'seek' | 'bar';

const HIDE_MS = 3000;
const VIEWER_HIDE_MS = 5000; // browsing: the overlay lingers a little longer
const BAR_IDLE_MS = 8000; // drop a picked control group (see Group) after this long idle
const CAPTION_DELAY_MS = 1000; // location/date animate in this long after a transition
const CAPTION_BROWSE_MS = 250; // ...or this long while paused and stepping by hand
const FADE_AUTO_MS = 900; // crossfade on an automatic advance
const FADE_MANUAL_MS = 500; // quicker crossfade when stepping with the remote
const SPEEDS = [
  { label: '5s', ms: 5000 },
  { label: '10s', ms: 10000 },
  { label: '15s', ms: 15000 },
];
const DEFAULT_MS = SPEEDS[0].ms; // dwell per still (5s)
const WINDOW = 2; // stills prefetched ahead (each holds a decoded bitmap in TV RAM)
const VIDEO_STALL_MS = 8000; // skip a video that hasn't produced a frame by now
const SEEK_STEP = 10; // seconds
const ZOOM_STEP = 1.2; // scale multiplier per scroll-wheel tick
const MAX_ZOOM = 6;
const PAN_KEY_STEP = 120; // px the d-pad nudges a zoomed photo
const MOTION_FADE_MS = 600; // Live Photo still fades out/in over this long
const WARMUP_MS = 1200; // a soundbar re-syncing to a new audio format misses about this much

// Stills are decoded off the main thread into an ImageBitmap and shown on a
// canvas where the TV supports it (see loadBitmapStill). Chromium 81+
// (appliesExifOrientation) also orients ImageBitmaps from EXIF; older sets
// keep the pre-decoded <img> path.
const canBitmap = appliesExifOrientation && typeof createImageBitmap === 'function';
// the screen in device pixels: originals up to this size are shown as they
// are, bigger ones as the preview (a 24MP original is ~100MB decoded)
const SCREEN_PX =
  Math.round((window.innerWidth || 1920) * (window.devicePixelRatio || 1)) *
  Math.round((window.innerHeight || 1080) * (window.devicePixelRatio || 1));

// a still's display element: a decoded <img>, or a canvas holding its bitmap
type Still = HTMLImageElement | HTMLCanvasElement;
const stillSize = (s: Still): [number, number] =>
  s instanceof HTMLCanvasElement ? [s.width, s.height] : [s.naturalWidth, s.naturalHeight];

interface Cached {
  src: string;
  isVideo: boolean;
  blob: boolean; // owns an object URL (still) that must be revoked
  // stills: ready === decoded === true once the blob resolves.
  // videos: ready (navigable) on `loadedmetadata` while only metadata is
  // buffered; decoded (safe to show) on `loadeddata`, after it promotes to
  // full buffering when it becomes current.
  ready: boolean;
  decoded: boolean;
  error?: boolean; // failed to load — advance past it
  gone?: boolean; // torn down: its element's late events are ignored
  el?: HTMLVideoElement; // for video: the buffering, reusable element
  q?: VideoQuality; // for video: which stream it's playing
  settled?: Promise<void>; // for video: resolves once ready (or failed for good)
  img?: Still; // for still: the fully-decoded, reusable <img>/canvas element
}

interface Frame {
  key: number;
  asset: Asset;
  src: string;
  el?: HTMLVideoElement;
  img?: Still;
}

// Keep a zoomed photo's pan within bounds so it can't be dragged fully off
// screen: at scale z the image overhangs the viewport by (z-1) on each axis,
// so the max offset is half of that overhang.
function clampPan(x: number, y: number, z: number): { x: number; y: number } {
  const maxX = ((z - 1) * window.innerWidth) / 2;
  const maxY = ((z - 1) * window.innerHeight) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, x)),
    y: Math.max(-maxY, Math.min(maxY, y)),
  };
}

// Fullscreen photo/video player, used both as the Slideshow page's show and as
// the viewer opened from a grid (see `mode`). Stills crossfade, pre-decoded
// (original quality when it fits the screen, else the preview); videos buffer
// in chunks (progressive range streaming, like the grid). Navigation (auto or
// d-pad) only moves to an item whose media is loaded — never onto a
// black/unready frame. The show loops. Owns its own key listener; the shell
// disables its remote handler while this is up.
export function WallpaperPlayer({
  assets: assetsProp,
  mode,
  startIndex = 0,
  onExit,
  onNearEnd,
  onShuffleChange,
  canShuffle = true,
  seen,
  placeOf,
}: Props) {
  const viewer = mode === 'viewer';
  const [i, setI] = useState(() => Math.max(0, Math.min(startIndex, assetsProp.length - 1)));
  // Play order: `order` is a permutation of indices into assetsProp; `assets`
  // (used everywhere below) is the sequenced list the show walks. The slideshow
  // starts shuffled (a random permutation); the viewer, and turning shuffle
  // off, use list order. Keeping playback consecutive over `assets` preserves
  // the prefetch window, eviction, and near-end paging unchanged — only the
  // mapping changes. The feed starts shuffled too, so the first batch is
  // already unseen items.
  const [shuffle, setShuffle] = useState(!viewer);
  const shuffleRef = useRef(!viewer);
  shuffleRef.current = shuffle;
  const [order, setOrder] = useState<number[]>(() => {
    const ids = assetsProp.map((_, k) => k);
    if (!viewer) weightedShuffle(ids, (k) => (assetsProp[k]?.isFavorite ? FAV_WEIGHT : 1));
    return ids;
  });
  const orderRef = useRef(order);
  orderRef.current = order;
  // bumped by the shuffle toggle so the show effect re-runs even when the
  // index keeps the same asset (the frame on screen is carried over)
  const [epoch, setEpoch] = useState(0);
  const assets = useMemo(() => order.map((k) => assetsProp[k]).filter(Boolean), [order, assetsProp]);
  // Two persistent crossfade layers (A/B), long-lived DOM nodes that media
  // elements are reparented into (never recreated, so no re-decode). Showing a
  // frame drops it into the currently-hidden layer and flips `showA`; the new
  // current layer snaps opaque UNDERNEATH while the outgoing layer fades OUT on
  // top (see the render map for why fade-out, not fade-in, on webOS Cr79).
  const [layers, setLayers] = useState<{ a: Frame | null; b: Frame | null }>({ a: null, b: null });
  const [showA, setShowA] = useState(true);
  const showARef = useRef(true);
  // false = the outgoing layer still COVERS (opaque, no transition); true = its
  // 1->0 fade is running. Flipped true two painted frames after each showFrame
  // so the incoming frame's raster stall happens while covered — starting the
  // fade in the same commit let a long raster (big 4K originals) eat the whole
  // 0.9s transition window (transitions are timestamp-based) and pop.
  const [fading, setFading] = useState(false);
  const fadeRaf = useRef(0);
  // length of the running crossfade: shorter when stepping by hand
  const [fadeMs, setFadeMs] = useState(FADE_AUTO_MS);
  const manualRef = useRef(false); // the pending frame change came from a key press
  // The viewer opens paused: it's for browsing, and Slideshow turns it into a show.
  const [paused, setPaused] = useState(viewer);
  // Viewer with "hide player overlay" set in the grid header: the chrome never
  // shows on its own. Read once at open; Down still brings up the controls.
  const overlayHidden = useRef(viewer && getOverlayHidden()).current;
  const [overlay, setOverlay] = useState(!overlayHidden);
  // which controls the d-pad drives (see Group). Back or idling drops to 'nav'.
  const [group, setGroupState] = useState<Group>('nav');
  const groupRef = useRef<Group>('nav');
  groupRef.current = group;
  const barRef = useRef<HTMLDivElement>(null);
  // caption (place + date) committed together so a switch animates it ONCE.
  // Date is on the asset immediately but the place is reverse-geocoded async;
  // setting them separately re-keyed the caption twice (date now, place later)
  // and it animated in twice. Commit both once the lookup resolves.
  const [meta, setMeta] = useState<{ loc: string | null; date: string }>({ loc: null, date: '' });
  const metaRef = useRef<{ loc: string | null; date: string }>({ loc: null, date: '' });
  metaRef.current = meta;
  // pre-geocoded results keyed by asset id so transitions can compare old vs new
  // meta before the new image shows, clearing the caption only when it changes.
  const geoCache = useRef(new Map<string, { loc: string | null; date: string }>());
  // the asset of the frame currently ON SCREEN (in the visible layer). The caption
  // keys off THIS, not the target index, so it only appears once the image has
  // actually loaded and been revealed — never over a still-loading frame.
  const [shownAsset, setShownAsset] = useState<Asset | null>(null);
  const shownAssetRef = useRef<Asset | null>(null);
  shownAssetRef.current = shownAsset;
  // viewer: id of the current item when it couldn't be loaded at all
  const [failed, setFailed] = useState<string | null>(null);
  // slideshow speed for stills (videos advance on their own end)
  const [intervalMs, setIntervalMs] = useState(DEFAULT_MS);
  const intervalRef = useRef(DEFAULT_MS);
  intervalRef.current = intervalMs;
  // the app's background music, steered from the sidebar
  const musicOn = useMusic().on;
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  // ---- viewer: video transport, zoom, Live Photos ----
  // The current video's own play state, apart from the show's `paused`:
  // browsing, a clip autoplays and OK pauses just the clip. vidHoldRef is true
  // once the user paused it (or it finished) so re-renders don't restart it.
  const vidHoldRef = useRef(false);
  const [vidPaused, setVidPaused] = useState(false);
  const [progress, setProgress] = useState({ cur: 0, dur: 0, buffered: 0 });
  const seekRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  // zoom scales the still on screen; pan offsets it (px). Both reset per photo.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const panDragRef = useRef({ on: false, x: 0, y: 0 });
  const [miniSrc, setMiniSrc] = useState<string | null>(null);
  // Live Photo: motionOn keeps the clip mounted; motionVisible fades the still
  // on top of it out. The clip mounts hidden under the still and is revealed
  // only once it has a decoded frame (no black buffering flash), and the still
  // fades back in when it ends, before the clip unmounts.
  // Persisted "live play" preference: whether Live Photos play their motion.
  const [livePlay, setLivePlayState] = useState(getLivePlay);
  const livePlayRef = useRef(livePlay);
  livePlayRef.current = livePlay;
  const [motionOn, setMotionOn] = useState(false);
  const [motionVisible, setMotionVisible] = useState(false);
  const motionRef = useRef<HTMLVideoElement>(null);
  const motionFadeTimer = useRef<number | undefined>(undefined);

  // hold off the TV screen saver while the show runs (no-op off webOS);
  // cleanup releases it. The viewer only holds it while playing.
  const awake = !viewer || !paused;
  useEffect(() => (awake ? keepAwake() : undefined), [awake]);

  const keyRef = useRef(0);
  // off-screen full-screen container used to lay out + raster a decoded still at
  // display size BEFORE it's shown, so the transition never hitches on a
  // first-composite resize (see fitOnStage / loadInto).
  const stageRef = useRef<HTMLDivElement>(null);
  const advanceTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const iRef = useRef(i);
  iRef.current = i;
  const pausedRef = useRef(viewer);
  pausedRef.current = paused;
  // latest "advance forward" fn, so video element listeners never go stale
  const advanceRef = useRef<() => void>(() => {});
  // latest exit fn, for the same reason
  const exitRef = useRef<() => void>(() => {});

  // The background music can't play alongside a clip on webOS (see duckMusic),
  // so each clip ducks it before playing and hands it back once it ends or is
  // left. Not when it's paused: the music coming back would take the TV's one
  // player away from the clip and blank its frame. The viewer ducks it even
  // before LOADING a clip (loadDuck): loading one, an original especially, can
  // already cut the music off mid-song.
  const musicDucks = useRef(new Map<HTMLVideoElement, ReturnType<typeof duckMusic>>());
  const unduck = useCallback((el: HTMLVideoElement) => {
    musicDucks.current.get(el)?.release();
    musicDucks.current.delete(el);
  }, []);
  const loadDuck = useRef<{ idx: number; duck: ReturnType<typeof duckMusic> } | null>(null);
  const duckForLoad = useCallback((idx: number) => {
    const prev = loadDuck.current;
    if (prev?.idx === idx) return prev.duck.faded;
    const duck = duckMusic();
    loadDuck.current = { idx, duck };
    prev?.duck.release();
    return duck.faded;
  }, []);
  const releaseLoadDuck = useCallback(() => {
    loadDuck.current?.duck.release();
    loadDuck.current = null;
  }, []);
  useEffect(
    () => () => {
      musicDucks.current.forEach((d) => d.release());
      musicDucks.current.clear();
      releaseLoadDuck();
    },
    [releaseLoadDuck],
  );

  // Warm the audio output up before a clip is heard (see takeClipWarmup): play
  // it muted under a black cover for WARMUP_MS once it's actually playing
  // (looping, so a short clip can't end meanwhile), then go back to where it
  // started and unmute. Pausing or leaving it cuts the warm-up short.
  const [warming, setWarming] = useState(false);
  const warmUp = useCallback((el: HTMLVideoElement) => {
    const at = el.currentTime;
    const loop = el.loop;
    el.muted = true;
    el.loop = true;
    setWarming(true);
    let timer = 0;
    let over = false;
    const done = () => {
      if (over) return;
      over = true;
      window.clearTimeout(timer);
      window.clearTimeout(guard);
      el.removeEventListener('playing', arm);
      el.removeEventListener('pause', done);
      el.muted = false;
      el.loop = loop;
      el.currentTime = at;
      setWarming(false);
    };
    const arm = () => {
      timer = window.setTimeout(done, WARMUP_MS);
    };
    // never leave the cover up on a clip that doesn't start
    const guard = window.setTimeout(done, VIDEO_STALL_MS);
    el.addEventListener('playing', arm, { once: true });
    el.addEventListener('pause', done);
  }, []);

  // play() once the music has faded out, with an autoplay-policy fallback: an
  // UNMUTED play can be rejected (desktop dev without a fresh gesture) —
  // degrade that clip to muted rather than letting it sit black until the
  // stall watchdog skips it.
  const playEl = useCallback((el: HTMLVideoElement) => {
    let duck = musicDucks.current.get(el);
    if (!duck) {
      duck = duckMusic();
      musicDucks.current.set(el, duck);
    }
    const mine = duck;
    void mine.faded.then(() => {
      if (musicDucks.current.get(el) !== mine) return; // handed back meanwhile
      if (cache.current.get(iRef.current)?.el !== el) return unduck(el); // moved on
      if (!wantPlay()) return; // paused during the fade: stays paused, music down
      if (el.paused && !el.muted && takeClipWarmup()) warmUp(el);
      void el.play().catch(() => {
        if (!el.muted) {
          el.muted = true;
          void el.play().catch(() => {});
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unduck, warmUp]);

  // Whether the current video should be playing: in the slideshow it follows
  // the show's pause; in the viewer the clip keeps its own play state.
  const wantPlay = useCallback(
    () => (viewer ? !vidHoldRef.current : !pausedRef.current),
    [viewer],
  );

  const asset = assets[i];

  // only a video has the seek group: moving on to anything else (the show
  // advancing past a clip) drops back to previous/next
  useEffect(() => {
    if (groupRef.current === 'seek' && !asset?.isVideo) {
      groupRef.current = 'nav';
      setGroupState('nav');
    }
  }, [asset?.id]);

  // Prefetch cache: index -> loaded item. Kept to a small sliding window so only
  // a handful of full-res stills / buffering videos live in TV memory at once.
  const cache = useRef<Map<number, Cached>>(new Map());

  // Reveal a frame: put it in the hidden layer and flip which layer is shown, so
  // the incoming layer crossfades in and the outgoing one fades out.
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const showFrame = useCallback((f: Frame) => {
    // GUARD: never re-show an element that's already in the VISIBLE layer.
    // Each media element exists once; mountLayer reparents with appendChild, so
    // putting the same element into the hidden layer would STEAL it from the
    // visible one — the screen goes black while the incoming layer fades up.
    const visible = showARef.current ? layersRef.current.a : layersRef.current.b;
    const el = f.el || f.img;
    if (el && visible && (visible.el || visible.img) === el) return;
    const toA = !showARef.current;
    // Flip commit: the incoming layer snaps visible underneath (attach + play
    // immediately — play() on a hidden/detached video blacks the TV's hardware
    // video plane) while the outgoing layer stays OPAQUE on top, covering the
    // incoming frame's first layout/raster. Two painted frames later, start the
    // outgoing 1->0 fade (see `fading`).
    window.cancelAnimationFrame(fadeRaf.current);
    setLayers((prev) => (toA ? { a: f, b: prev.b } : { a: prev.a, b: f }));
    showARef.current = toA;
    setShowA(toA);
    setFading(false);
    setFadeMs(manualRef.current ? FADE_MANUAL_MS : FADE_AUTO_MS);
    fadeRaf.current = requestAnimationFrame(() => {
      fadeRaf.current = requestAnimationFrame(() => setFading(true));
    });
  }, []);

  // Mount a decoded still into the off-screen full-screen stage so the browser
  // lays it out and RASTERS it at display size, then resolves after two frames
  // (one to lay out, one to paint). The element is later reparented into the
  // visible layer already fitted — the transition can't hitch on a resize. If
  // the stage isn't mounted yet (first render), resolve immediately.
  const fitOnStage = useCallback((img: Still, fit: 'cover' | 'contain'): Promise<void> => {
    return new Promise((res) => {
      const stage = stageRef.current;
      if (!stage) return res();
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = fit;
      if (img.parentElement !== stage) stage.appendChild(img);
      void img.offsetWidth; // force synchronous layout at full-screen size
      requestAnimationFrame(() => requestAnimationFrame(() => res()));
    });
  }, []);

  // Ready a decoded still for display. Portrait shots are shown WHOLE
  // (contain) over a blurred, dimmed copy of themselves filling the side bars
  // — a cover crop of a portrait on a 16:9 screen threw away over half the
  // photo. In the slideshow everything else keeps the face-aimed full-screen
  // cover crop; the viewer shows every photo whole, blurring whatever bars its
  // shape leaves.
  const prepStill = useCallback(
    async (img: Still, id: string): Promise<void> => {
      const [w, h] = stillSize(img);
      if (viewer) {
        const screen = (window.innerWidth || 1920) / (window.innerHeight || 1080);
        if (h > 0 && Math.abs(w / h - screen) > 0.02) await applyBlurBackdrop(img, id);
        await fitOnStage(img, 'contain');
      } else if (h > w) {
        await applyBlurBackdrop(img, id);
        await fitOnStage(img, 'contain');
      } else {
        await aimAtFaces(img, id); // aim the cover crop BEFORE the stage raster
        await fitOnStage(img, 'cover');
      }
    },
    [fitOnStage, viewer],
  );

  // Load a still as a canvas holding its decoded pixels. The bytes are decoded
  // OFF the main thread (createImageBitmap), then drawn into a 2D canvas the
  // cache holds, so showing it needs no decode at all. An <img> is only really
  // decoded when the compositor first draws it, and on the TV the main thread
  // then stalls at its next frame until that decode is done (100-500ms) —
  // every photo change froze the remote for that long. decode() doesn't
  // prevent it there: webOS 10 refuses it whenever its decode budget is short
  // and drops what it did decode before the photo comes up. A 2D canvas, not a
  // bitmaprenderer one: that kept every photo's ~11MB bitmap alive until the
  // next garbage collection, while a 2D canvas frees on teardown. The original
  // is used when it's no bigger than the screen, else the preview (also the
  // HEIC/RAW fallback).
  const loadBitmapStill = useCallback(
    async (a: Asset): Promise<Cached | null> => {
      const fits = await getAssetPixels(a.id)
        .then((px) => px > 0 && px <= SCREEN_PX)
        .catch(() => false);
      const preview = thumbnailUrl(a.id, 'preview');
      for (const url of fits ? [originalUrl(a.id), preview] : [preview]) {
        try {
          const bmp = await createImageBitmap(await loadBlob(url));
          const canvas = document.createElement('canvas');
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          canvas.getContext('2d')!.drawImage(bmp, 0, 0);
          bmp.close();
          await prepStill(canvas, a.id);
          return { src: url, isVideo: false, blob: false, ready: true, decoded: true, img: canvas };
        } catch {
          // undecodable (e.g. a HEIC/RAW original) — try the preview
        }
      }
      return null;
    },
    [prepStill],
  );

  // Point a video at the other stream (transcoded <-> original), resuming where
  // it was. The element stays the one on screen; only its source reloads.
  const switchSrc = useCallback(
    (e: Cached, id: string, q: VideoQuality) => {
      const el = e.el;
      if (!el) return;
      const at = el.currentTime || 0;
      e.q = q;
      e.src = q === 'original' ? originalStreamUrl(id) : videoStreamUrl(id);
      e.decoded = false;
      e.error = false;
      el.src = e.src;
      el.load();
      el.addEventListener('loadedmetadata', () => { if (at) el.currentTime = at; }, { once: true });
      el.addEventListener('loadeddata', () => { e.decoded = true; bump(); }, { once: true });
      if (wantPlay()) playEl(el);
      bump();
    },
    [bump, playEl, wantPlay],
  );

  // Load one item. Stills: see loadBitmapStill; on older sets, fetch the
  // original as a pre-decoded <img> (HEIC/RAW, or an original the TV won't
  // pre-decode, fall back to the preview JPEG). Videos: a hidden <video> that
  // buffers in chunks; ready on its first decoded frame (loadeddata). Caching
  // + dedup live in loadInto below.
  const loadFresh = useCallback(
    async (idx: number): Promise<Cached | null> => {
      const a = assets[idx];
      if (!a) return null;

      if (a.isVideo) {
        if (viewer) await duckForLoad(idx);
        const el = document.createElement('video');
        // the viewer streams the quality last picked; its clips play with their
        // own sound; the slideshow keeps them muted
        const q: VideoQuality = viewer ? getVideoQuality() : 'transcoded';
        el.src = q === 'original' ? originalStreamUrl(a.id) : videoStreamUrl(a.id);
        el.muted = !viewer;
        if (viewer) el.style.objectFit = 'contain'; // the whole frame, not a crop
        el.playsInline = true;
        // only metadata while it's a lookahead/behind; promoted to 'auto' when
        // it becomes the current clip (keeps at most one clip fully buffering).
        el.preload = 'metadata';
        el.setAttribute('playsinline', '');
        if (el.muted) el.setAttribute('muted', '');
        let settle = () => {};
        const e: Cached = {
          src: el.src,
          isVideo: true,
          blob: false,
          ready: false,
          decoded: false,
          el,
          q,
          settled: new Promise<void>((res) => (settle = res)),
        };
        // NOTE: no aimAtFaces on videos. webOS composites <video> on its own
        // hardware plane; a non-center object-position breaks the hole-punch
        // and the video renders black (fine on desktop). Face boxes for videos
        // are also detected on the thumbnail, so the data is unreliable anyway.
        el.addEventListener('loadedmetadata', () => { e.ready = true; settle(); bump(); }, { once: true });
        el.addEventListener('loadeddata', () => { e.decoded = true; bump(); }, { once: true });
        el.addEventListener('ended', () => {
          if (iRef.current !== idx) return;
          if (!pausedRef.current) advanceRef.current();
          // viewer, browsing: a finished clip goes back to the grid, as if Back
          // were pressed
          else if (viewer) exitRef.current();
          else vidHoldRef.current = true;
        });
        el.addEventListener('waiting', () => { if (wantPlay()) playEl(el); });
        el.addEventListener('ended', () => unduck(el));
        el.addEventListener('error', () => {
          if (e.gone) return;
          // viewer: a transcode the TV can't play falls back to the original once
          if (viewer && e.q === 'transcoded') return switchSrc(e, a.id, 'original');
          e.ready = true; // let nav move onto it so it can be skipped
          e.error = true;
          settle();
          bump();
          if (iRef.current === idx) advanceRef.current();
        });
        el.load();
        return e;
      }

      if (canBitmap) return loadBitmapStill(a);

      try {
        // On sets that don't auto-apply EXIF orientation (Chromium < 81, i.e.
        // webOS 4.x), an original carrying an orientation tag paints rotated.
        // Only those assets fall back to the preview, which Immich re-encodes
        // upright — everything else keeps full original resolution. The lookup
        // is free: /assets/{id} is already fetched and cached for the caption.
        let bakeRotation = false;
        if (!appliesExifOrientation) {
          bakeRotation = await getAssetOrientation(a.id)
            .then((o) => o !== 1)
            .catch(() => false); // unreachable info: keep today's behaviour
        }
        if (!bakeRotation && !skipOriginals) {
          const src = await loadBlobUrl(originalUrl(a.id));
          // Build and fully DECODE the actual <img> element before caching,
          // then reuse THAT element on screen (mounted via ref, like videos). A
          // still is "loaded" only once its real element can paint instantly.
          // Decoding a throwaway Image wasn't enough: the rendered element
          // re-decoded async and the fade reached full opacity over a
          // still-blank layer = black pop.
          let still: { img: HTMLImageElement; decoded: boolean };
          try {
            still = await decodeStill(src);
          } catch (decodeErr) {
            revoke(src); // undecodable original (e.g. HEIC/RAW) — drop it, try preview
            throw decodeErr;
          }
          if (still.decoded) {
            await prepStill(still.img, a.id); // lay out + raster at full-screen before it's eligible
            return { src, isVideo: false, blob: true, ready: true, decoded: true, img: still.img };
          }
          // Loaded, but the TV won't pre-decode an image this big. Show the
          // preview instead, and once that's happened twice stop downloading
          // originals at all — each was megabytes fetched only to be dropped.
          revoke(src);
          if (++undecodableOriginals >= 2) skipOriginals = true;
        }
      } catch {
        // undecodable original — the preview below
      }
      try {
        const src = await loadBlobUrl(thumbnailUrl(a.id, 'preview'));
        let img: HTMLImageElement;
        try {
          // preview is always a browser-decodable JPEG; a refused pre-decode
          // just means the compositor decodes it when it's shown, not a skip
          img = (await decodeStill(src)).img;
        } catch (decodeErr) {
          revoke(src);
          throw decodeErr;
        }
        await prepStill(img, a.id);
        return { src, isVideo: false, blob: true, ready: true, decoded: true, img };
      } catch {
        return null;
      }
    },
    [assets, bump, prepStill, loadBitmapStill, viewer, playEl, wantPlay, switchSrc, unduck, duckForLoad],
  );

  // Load one item into the cache. Concurrent calls for the same index share
  // one load: the auto-advance retry asks again every 400ms while the next
  // frame is still loading, and on the TV (where a load takes seconds) each
  // retry used to start another full download + decode of the same photo.
  // Loads started before the play order was rebuilt (clearCache) are dropped.
  const inflight = useRef<Map<number, Promise<Cached | null>>>(new Map());
  const cacheGen = useRef(0);
  const loadInto = useCallback(
    (idx: number): Promise<Cached | null> => {
      const hit = cache.current.get(idx);
      if (hit) return Promise.resolve(hit);
      let p = inflight.current.get(idx);
      if (!p) {
        const gen = cacheGen.current;
        p = loadFresh(idx).then(
          (e) => {
            if (cacheGen.current !== gen) {
              if (e) teardown(e); // the order was rebuilt meanwhile: idx means another asset now
              return null;
            }
            inflight.current.delete(idx);
            if (e) cache.current.set(idx, e);
            return e;
          },
          () => {
            if (cacheGen.current === gen) inflight.current.delete(idx);
            return null;
          },
        );
        inflight.current.set(idx, p);
      }
      return p;
    },
    [loadFresh],
  );

  // tear down a cached element (release the blob, stop buffering, drop the DOM node)
  const teardown = (e: Cached) => {
    e.gone = true;
    if (e.blob) revoke(e.src);
    if (e.el) {
      e.el.pause();
      e.el.removeAttribute('src');
      e.el.load();
      e.el.remove();
    }
    if (e.img) {
      e.img.remove(); // pull the still off the stage / frame layer
      // free the canvas's pixels now rather than whenever it's collected
      if (e.img instanceof HTMLCanvasElement) e.img.width = e.img.height = 0;
    }
  };

  // Drop cached items outside the [i-2, i+WINDOW] window. Two behind (not one)
  // so a couple of Left presses land instantly instead of re-fetching originals.
  const evict = useCallback((center: number) => {
    for (const [idx, e] of cache.current) {
      if (idx < center - 2 || idx > center + WINDOW) {
        teardown(e);
        cache.current.delete(idx);
      }
    }
  }, []);

  // drop every cached element (used when the play order is rebuilt — cache is
  // keyed by position in `assets`, which the reorder invalidates)
  const clearCache = useCallback(() => {
    for (const [, e] of cache.current) teardown(e);
    cache.current.clear();
    inflight.current.clear();
    cacheGen.current++;
  }, []);

  // Keep `order` covering every asset. onNearEnd appends to the live list, so
  // when it grows, tack the new indices on the end (when shuffle is on: minus
  // anything already shown, shuffled among themselves). Existing positions keep
  // their mapping — the cache and current index stay valid, no reload.
  const orderedUpTo = useRef(assetsProp.length); // assetsProp indices already placed
  useEffect(() => {
    const from = orderedUpTo.current;
    if (assetsProp.length <= from) return;
    orderedUpTo.current = assetsProp.length;
    let added: number[] = [];
    for (let k = from; k < assetsProp.length; k++) added.push(k);
    if (shuffleRef.current) {
      added = added.filter((k) => !seen.has(assetsProp[k].id));
      weightedShuffle(added, (k) => (assetsProp[k]?.isFavorite ? FAV_WEIGHT : 1));
    }
    if (added.length) setOrder((prev) => [...prev, ...added]);
  }, [assetsProp.length]);

  // Toggle shuffle: rebuild the whole order and reset the cache, carrying the
  // frame on screen (and its cache entry) over so the toggle doesn't cut away
  // from it. Shuffle puts it at the head of a fresh random order that skips
  // everything this source has already shown (remembered across sessions) —
  // and still plays when every loaded item has been seen (onNearEnd then pulls
  // unseen ones). Off goes back to list order, carrying on from that frame.
  const toggleShuffle = useCallback(() => {
    const next = !shuffleRef.current;
    const cur = orderRef.current[iRef.current];
    let ids = assetsProp.map((_, k) => k);
    let at = 0;
    if (next) {
      ids = ids.filter((k) => k !== cur && !seen.has(assetsProp[k].id));
      weightedShuffle(ids, (k) => (assetsProp[k]?.isFavorite ? FAV_WEIGHT : 1));
      if (cur !== undefined) ids.unshift(cur);
    } else if (cur !== undefined) {
      at = cur;
    }
    const keep = cur !== undefined ? cache.current.get(iRef.current) : undefined;
    cache.current.delete(iRef.current);
    clearCache();
    if (keep) cache.current.set(at, keep);
    orderedUpTo.current = assetsProp.length;
    setShuffle(next);
    setOrder(ids);
    setI(at);
    setEpoch((n) => n + 1);
    onShuffleChange?.(next); // widen the bound: feed randomizes remaining buckets
  }, [assetsProp, clearCache, onShuffleChange, seen]);

  // An index is navigable only once its media is loaded: a still's blob is ready,
  // or a video has its metadata (or failed, so it can be skipped).
  const isLoaded = useCallback(
    (idx: number) => {
      const a = assets[idx];
      if (!a) return false;
      const e = cache.current.get(idx);
      if (!e) return false;
      return e.isVideo ? e.ready : true;
    },
    [assets],
  );

  const targetIndex = useCallback(
    (delta: number, manual: boolean) => {
      const n = iRef.current + delta;
      // the viewer stops at either end when stepped by hand
      if (viewer && manual && (n < 0 || n >= assets.length)) return iRef.current;
      if (n < 0) return assets.length - 1; // wrap to last
      // wrap to first — except while shuffling: hold for the next unseen batch
      // (onNearEnd) rather than replay what was just shown
      if (n >= assets.length) return shuffleRef.current ? iRef.current : 0;
      return n;
    },
    [assets.length, viewer],
  );

  // Move by delta, but ONLY onto a loaded frame (never a black/unready one).
  // Auto-advance (manual=false): if the target isn't loaded, kick its load and
  // report false so the caller's retry loop polls again. Manual d-pad presses
  // (manual=true) FOLLOW THROUGH instead: remember the intent, show the
  // spinner, and jump as soon as the load lands — a press is never silently
  // dropped (that read as a dead remote on the TV, where an original takes
  // seconds to fetch + decode). A newer press supersedes a pending one.
  const navToken = useRef(0);
  const [navPending, setNavPending] = useState(false);
  const advance = useCallback(
    (delta: number, manual = false): boolean => {
      const n = targetIndex(delta, manual);
      // nowhere else to go (yet): leave the frame and timers alone; the auto
      // retry loop polls until onNearEnd has appended more
      if (n === iRef.current) return false;
      navToken.current++; // supersede any pending manual nav
      if (isLoaded(n)) {
        setNavPending(false);
        window.clearTimeout(advanceTimer.current);
        manualRef.current = manual;
        setI(n);
        return true;
      }
      if (!manual) {
        void loadInto(n);
        return false;
      }
      const token = navToken.current;
      setNavPending(true);
      // stop the auto-advance timer so a dwell tick can't steal this intent
      window.clearTimeout(advanceTimer.current);
      void loadInto(n)
        .then((e) => e?.settled) // a video: wait for its metadata
        .then(() => {
          if (navToken.current !== token) return; // a newer press took over
          setNavPending(false);
          if (isLoaded(n)) {
            manualRef.current = true;
            setI(n);
          } else if (viewer) {
            advance(delta + Math.sign(delta), true); // unloadable: step over it
          } else {
            advanceRef.current(); // unloadable target — resume the show
          }
        });
      return false;
    },
    [targetIndex, isLoaded, loadInto, viewer],
  );

  // Auto-advance: try to step forward; if the next frame isn't loaded yet, keep
  // retrying at a short interval rather than skipping or looping past it.
  const scheduleNext = useCallback(
    (ms: number) => {
      window.clearTimeout(advanceTimer.current);
      if (pausedRef.current) return;
      advanceTimer.current = window.setTimeout(() => {
        if (!advance(1)) scheduleNext(400);
      }, ms);
    },
    [advance],
  );
  advanceRef.current = () => scheduleNext(0);

  // A still's dwell: arm its advance timer and restart the edge line that
  // shows it running out (the viewer's slideshow). `n` re-keys the line so
  // every (re)start fills it from empty.
  const [dwell, setDwell] = useState({ n: 0, ms: 0 });
  const dwellOn = useCallback(
    (ms: number) => {
      scheduleNext(ms);
      setDwell((d) => ({ n: d.n + 1, ms }));
    },
    [scheduleNext],
  );

  const prefetchGeoFor = useCallback((a: Asset) => {
    if (geoCache.current.has(a.id)) return;
    const date = fmtDate(a.createdAt);
    getAssetLocation(a.id)
      .then((r) => {
        geoCache.current.set(a.id, { loc: fmtPlace(r), date });
      })
      .catch(() => { geoCache.current.set(a.id, { loc: null, date }); });
  }, []);

  // load + show the current asset, prefetch around it, evict the rest
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    const key = ++keyRef.current;
    let stallTimer: number | undefined;
    window.clearTimeout(advanceTimer.current);
    // headed somewhere else than the clip the music made way for
    if (loadDuck.current && loadDuck.current.idx !== i) releaseLoadDuck();
    // a new item: its clip (if any) starts in play intent, at zero
    vidHoldRef.current = false;
    setVidPaused(false);
    setProgress({ cur: 0, dur: 0, buffered: 0 });

    loadInto(i)
      .then((e) => {
        if (!alive) return;
        if (!e) {
          if (viewer) setFailed(asset.id);
          return scheduleNext(500); // unloadable still — skip quickly
        }
        if (!e.isVideo) {
          showFrame({ key, asset, src: e.src, img: e.img });
          dwellOn(intervalRef.current); // stills auto-advance on a timer
          return;
        }
        // Video: promote to full buffering now that it's current, and only
        // REVEAL it once it has a decoded frame — until then the previous frame
        // stays up (no black flash mid-crossfade). Advance is driven by 'ended'.
        const el = e.el!;
        el.preload = 'auto';
        if (e.error) return scheduleNext(0); // failed — advance past
        let revealed = false;
        const reveal = () => {
          if (revealed || !alive) return;
          revealed = true;
          // Attach + play IMMEDIATELY on the first decodable frame. webOS runs
          // <video> through a hardware pipeline that expects the element to be
          // in the DOM — deferring the reparent until after play() begins (an
          // earlier requestVideoFrameCallback/rAF scheme) left the TV's video
          // plane black. The earlier black frames this deferral chased were the
          // element-steal bug, fixed properly in showFrame/the show effect.
          if (wantPlay()) playEl(el); // takes over the load's duck
          releaseLoadDuck();
          showFrame({ key, asset, src: e.src, el });
        };
        if (e.decoded) reveal();
        else {
          el.addEventListener('loadeddata', reveal, { once: true });
          el.addEventListener('canplay', reveal, { once: true });
        }
        // watchdog: forward auto-advance rides on the 'ended' event, so a clip
        // that never starts OR freezes mid-playback (buffer stall) would hang the
        // show forever ('ended' never fires). Poll the playback position: while
        // playing, if it stops advancing for VIDEO_STALL_MS, skip to the next.
        let lastT = -1;
        let strikes = 0;
        const ticks = Math.max(1, Math.round(VIDEO_STALL_MS / 2000));
        stallTimer = window.setInterval(() => {
          if (!alive || iRef.current !== i) return;
          // don't skip a paused clip, or one the viewer is just showing
          if (pausedRef.current || !wantPlay()) { lastT = -1; return; }
          const t = el.currentTime || 0;
          if (t > lastT) { lastT = t; strikes = 0; return; }
          if (++strikes >= ticks) { window.clearInterval(stallTimer); scheduleNext(0); }
        }, 2000);
      })
      .catch(() => alive && scheduleNext(500))
      .then(prefetch);

    // Prefetch ONE AT A TIME, nearest first, once the current frame is in:
    // loading everything at once made the frames race each other for the TV's
    // bandwidth and decoder, so the one needed next landed last. The slideshow
    // fills the window ahead (all stills, but only the NEXT video — videos are
    // heavy to buffer). The viewer is stepped both ways, so it readies the one
    // behind too, and loads a video only once it's the one shown. Stops when
    // the show moves on; the next run resumes from cache.
    async function prefetch() {
      const ks: number[] = [];
      if (viewer) ks.push(i + 1, i - 1, i + 2);
      else for (let k = i + 1; k <= i + WINDOW; k++) ks.push(k);
      let vids = 0;
      for (const k of ks) {
        if (!alive) return;
        const a = assets[k];
        if (!a) continue;
        prefetchGeoFor(a);
        if (a.isVideo) {
          if (viewer || vids >= 1) continue;
          vids++;
        }
        await loadInto(k);
      }
    }
    evict(i);

    return () => {
      alive = false;
      window.clearInterval(stallTimer);
      // pause the outgoing video and demote it back to metadata-only so it stops
      // buffering while it's just a neighbour again
      const out = cache.current.get(i)?.el;
      if (out) {
        out.pause();
        unduck(out);
        out.preload = 'metadata';
      }
    };
    // NOTE: keyed on the index and the identity of the asset AT that index —
    // NOT assets.length. onNearEnd appends to the live list, and a length dep
    // re-ran this whole effect at the SAME index: the second showFrame moved
    // the already-visible element into the other layer (appendChild = steal),
    // blacking out the screen. Deterministically hit the same photos (the ones
    // on screen when a bucket load landed). asset?.id covers the one case a
    // re-run IS wanted: assets[i] itself changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, asset?.id, epoch]);

  // Page in more when nearing the end. Also re-checks when the live list grows
  // but the order didn't reach past the end (a small batch, or one whose items
  // shuffle filtered out as already seen), so the show never stalls there.
  useEffect(() => {
    if (onNearEnd && i >= assets.length - 3) onNearEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, assets.length, assetsProp.length]);

  // track which asset is actually on screen (the frame in the visible layer)
  useEffect(() => {
    const shown = showA ? layers.a : layers.b;
    if (shown) {
      setShownAsset(shown.asset);
      seen.add(shown.asset.id); // remembered so shuffle won't repeat it
    }
  }, [layers, showA]);

  // Reverse-geocode the SHOWN asset and commit place+date together, once BOTH
  // the lookup has resolved AND a short beat (CAPTION_DELAY_MS) has passed since
  // the image was revealed. Keying on the shown asset (not the target index)
  // guarantees the caption never fades in before its image is loaded. Committing
  // the pair as one metaKey means the caption is keyed on its content: identical
  // place+date reuses the DOM node and does NOT re-fade; only a genuine change
  // remounts and fades in.
  useEffect(() => {
    if (!shownAsset) return;
    let alive = true;
    const date = fmtDate(shownAsset.createdAt);
    const delay = pausedRef.current ? CAPTION_BROWSE_MS : CAPTION_DELAY_MS;

    const cached = geoCache.current.get(shownAsset.id);
    if (cached) {
      // We already know the new meta. Clear the old caption now only when the
      // content is actually changing — same place/date stays visible throughout.
      const newKey = `${cached.loc ?? ''}|${cached.date}`;
      const curKey = `${metaRef.current.loc ?? ''}|${metaRef.current.date}`;
      if (newKey !== curKey) setMeta({ loc: null, date: '' });
      const t = window.setTimeout(() => { if (alive) setMeta(cached); }, delay);
      return () => { alive = false; window.clearTimeout(t); };
    }

    // Not pre-geocoded yet — clear immediately (unknown whether same or different)
    // and run the lookup now, caching the result for future transitions.
    setMeta({ loc: null, date: '' });
    let loc: string | null = null;
    let resolved = false;
    let delayed = false;
    const commit = () => {
      if (alive && resolved && delayed) {
        const result = { loc, date };
        geoCache.current.set(shownAsset.id, result);
        setMeta(result);
      }
    };
    const t = window.setTimeout(() => { delayed = true; commit(); }, delay);
    getAssetLocation(shownAsset.id)
      .then((r) => { loc = fmtPlace(r); })
      .catch(() => { loc = null; })
      .finally(() => { resolved = true; commit(); });
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [shownAsset?.id]);

  // release everything held when the player unmounts
  useEffect(() => {
    const held = cache.current;
    return () => {
      window.clearTimeout(advanceTimer.current);
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(motionFadeTimer.current);
      for (const e of held.values()) teardown(e);
      held.clear();
      seen.flush();
    };
  }, []);

  // pause/resume: stop the timer (and in the slideshow the current video), or
  // resume playback/rotation. The viewer's clip keeps its own play state.
  useEffect(() => {
    const cur = cache.current.get(iRef.current);
    if (paused) {
      window.clearTimeout(advanceTimer.current);
      if (!viewer) cur?.el?.pause();
    } else if (cur?.isVideo) {
      if (cur.el?.ended) scheduleNext(0); // a clip that already finished: move on
      else if (cur.el) {
        vidHoldRef.current = false;
        playEl(cur.el);
      }
    } else {
      dwellOn(intervalRef.current);
    }
  }, [paused, scheduleNext, dwellOn, playEl]);

  // changing the speed while a still is showing restarts its timer at the new rate
  useEffect(() => {
    if (paused) return;
    if (!assets[iRef.current]?.isVideo) dwellOn(intervalMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  const poke = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    if (groupRef.current !== 'nav') {
      setOverlay(true);
      // a group picked but idle: after a longer window, hide the controls AND
      // drop back to previous/next, so hidden controls always mean the default
      hideTimer.current = window.setTimeout(() => {
        groupRef.current = 'nav';
        setGroupState('nav');
        (document.activeElement as HTMLElement | null)?.blur();
        setOverlay(false);
      }, BAR_IDLE_MS);
      return;
    }
    if (overlayHidden) {
      setOverlay(false);
      return;
    }
    setOverlay(true);
    hideTimer.current = window.setTimeout(() => setOverlay(false), viewer ? VIEWER_HIDE_MS : HIDE_MS);
  }, [overlayHidden, viewer]);

  // Move d-pad focus among the option-bar buttons by `delta` (live query — the
  // button set changes with the item shown). Wraps at both ends.
  const focusBarBtn = useCallback((delta: number) => {
    const btns = Array.from(barRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    if (!btns.length) return;
    const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
    btns[cur < 0 ? 0 : (cur + delta + btns.length) % btns.length].focus();
  }, []);

  // Pick the group the d-pad drives. The bar focuses its first button; the
  // others drop any bar focus. poke() then brings the controls up (even with
  // the overlay set hidden) and arms the idle drop back to 'nav'.
  const selectGroup = useCallback(
    (g: Group) => {
      groupRef.current = g; // sync: poke() below reads the ref, not state
      setGroupState(g);
      // focus after the overlay has painted
      if (g === 'bar') requestAnimationFrame(() => focusBarBtn(1));
      else (document.activeElement as HTMLElement | null)?.blur();
      poke();
    },
    [focusBarBtn, poke],
  );

  // Start or stop the show. Starting it drops any zoom so the photos come up
  // whole.
  const setPlaying = useCallback((on: boolean) => {
    if (on === !pausedRef.current) return;
    if (on) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
    setPaused(!on);
  }, []);

  const exit = useCallback(() => {
    onExit(shownAssetRef.current ?? assets[iRef.current] ?? null);
  }, [onExit, assets]);
  exitRef.current = exit;

  // cancel a pending fade kick-off when the player closes
  useEffect(() => () => window.cancelAnimationFrame(fadeRaf.current), []);

  // show the overlay briefly at start; afterwards it appears only on interaction
  // (key / pointer), never on an automatic photo change
  useEffect(() => {
    poke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- viewer: the frame on screen ----
  const visible = showA ? layers.a : layers.b;
  const visibleImg = viewer ? visible?.img ?? null : null;
  const visibleVid = viewer ? visible?.el ?? null : null;
  const liveId = viewer && visible && !visible.asset.isVideo ? visible.asset.livePhotoVideoId ?? null : null;

  // Video transport: follow the clip on screen.
  const readProgress = useCallback((v: HTMLVideoElement) => {
    let buffered = 0;
    try {
      for (let k = 0; k < v.buffered.length; k++) {
        if (v.currentTime >= v.buffered.start(k) && v.currentTime <= v.buffered.end(k)) {
          buffered = v.buffered.end(k);
          break;
        }
      }
    } catch {
      /* buffered not readable yet */
    }
    setProgress({ cur: v.currentTime, dur: v.duration || 0, buffered });
  }, []);
  const updateProgress = useCallback(() => {
    const v = cache.current.get(iRef.current)?.el;
    if (v) readProgress(v);
  }, [readProgress]);

  useEffect(() => {
    const v = visibleVid;
    if (!v) return;
    const update = () => readProgress(v);
    const onPlay = () => setVidPaused(false);
    // paused (by the user, or at the end): bring the transport up
    const onPause = () => {
      setVidPaused(true);
      update();
      poke();
    };
    const evs = ['timeupdate', 'progress', 'durationchange', 'loadedmetadata', 'seeked'];
    evs.forEach((n) => v.addEventListener(n, update));
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    setVidPaused(v.paused);
    update();
    return () => {
      evs.forEach((n) => v.removeEventListener(n, update));
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, [visibleVid, readProgress, poke]);

  const toggleVideo = useCallback(() => {
    const v = cache.current.get(iRef.current)?.el;
    if (!v) return;
    if (v.paused) {
      vidHoldRef.current = false;
      playEl(v);
    } else {
      vidHoldRef.current = true;
      v.pause();
      setPlaying(false); // pausing a clip mid-show stops the show too
    }
  }, [playEl, setPlaying]);

  const seek = useCallback(
    (delta: number) => {
      const v = cache.current.get(iRef.current)?.el;
      if (!v) return;
      v.currentTime = Math.max(0, Math.min(v.duration || 1e9, v.currentTime + delta));
      updateProgress();
    },
    [updateProgress],
  );

  // Pointer scrubbing on the seek bar — works for PC mouse and the LG
  // magic-remote pointer (both emit pointer events). Maps the x position within
  // the bar to a fraction of duration. Used for a single click (jump) and for
  // drag (scrub): pointermove updates while a drag is active.
  const seekToClientX = useCallback(
    (clientX: number) => {
      const v = cache.current.get(iRef.current)?.el;
      const bar = seekRef.current;
      if (!v || !bar || !v.duration) return;
      const rect = bar.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      v.currentTime = frac * v.duration;
      updateProgress();
    },
    [updateProgress],
  );
  const onSeekDown = useCallback(
    (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      seekToClientX(e.clientX);
      poke();
    },
    [seekToClientX, poke],
  );
  const onSeekMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      seekToClientX(e.clientX);
      poke();
    },
    [seekToClientX, poke],
  );
  const onSeekUp = useCallback((e: PointerEvent) => {
    draggingRef.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  const cycleQuality = useCallback(() => {
    const e = cache.current.get(iRef.current);
    const a = assets[iRef.current];
    if (!e?.el || !a) return;
    const next: VideoQuality = e.q === 'original' ? 'transcoded' : 'original';
    setVideoQuality(next); // remember for later videos + app restarts
    switchSrc(e, a.id, next);
    poke();
  }, [assets, switchSrc, poke]);

  // Zoom: scale the still on screen. The element lives outside Preact (it's
  // reparented from the cache), so the transform is set on it directly. A new
  // frame resets the zoom and clears the transform left on the old element.
  const zoomElRef = useRef<Still | null>(null);
  useEffect(() => {
    const prev = zoomElRef.current;
    if (prev !== visibleImg) {
      if (prev) prev.style.transform = '';
      zoomElRef.current = visibleImg;
      if (zoomRef.current !== 1) {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
      return;
    }
    if (visibleImg) {
      visibleImg.style.transform =
        zoom > 1 ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` : '';
    }
  }, [visibleImg, zoom, pan]);

  const zoomBy = useCallback((inward: boolean) => {
    const z = zoomRef.current;
    const next = Math.min(MAX_ZOOM, Math.max(1, inward ? z * ZOOM_STEP : z / ZOOM_STEP));
    setZoom(next);
    setPan((p) => (next <= 1.001 ? { x: 0, y: 0 } : clampPan(p.x, p.y, next)));
  }, []);

  // Scroll wheel (LG magic remote / mouse) zooms a still while browsing.
  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!visibleImg || !pausedRef.current) return;
      e.preventDefault();
      poke();
      zoomBy(e.deltaY < 0);
    },
    [visibleImg, poke, zoomBy],
  );

  // Pointer drag pans a zoomed photo (magic-remote pointer / mouse). Handlers
  // sit on the player root and fire via bubbling; presses on the controls are
  // left alone so they still click.
  const onImgDown = useCallback(
    (e: PointerEvent) => {
      if (zoomRef.current <= 1) return;
      if ((e.target as HTMLElement).closest('button, .wp-edge-progress')) return;
      e.preventDefault();
      panDragRef.current = { on: true, x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      poke();
    },
    [poke],
  );
  const onImgMove = useCallback(
    (e: PointerEvent) => {
      if (!panDragRef.current.on) return;
      const dx = e.clientX - panDragRef.current.x;
      const dy = e.clientY - panDragRef.current.y;
      panDragRef.current.x = e.clientX;
      panDragRef.current.y = e.clientY;
      setPan((p) => clampPan(p.x + dx, p.y + dy, zoomRef.current));
      poke();
    },
    [poke],
  );
  const onImgUp = useCallback((e: PointerEvent) => {
    if (!panDragRef.current.on) return;
    panDragRef.current.on = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  // the zoom minimap draws the grid thumbnail (a cache hit)
  const zoomed = zoom > 1;
  const shownId = visible?.asset.id;
  useEffect(() => {
    if (!zoomed || !shownId) return;
    let alive = true;
    loadThumb(shownId).then((u) => { if (alive) setMiniSrc(u); }).catch(() => {});
    return () => { alive = false; };
  }, [zoomed, shownId]);

  // Live Photos play their motion only while browsing, unzoomed, and with the
  // music off (the clip would need the media pipeline the radio is holding).
  const motionOk = !!liveId && paused && !musicOn && !zoomed;
  const motionOkRef = useRef(motionOk);
  motionOkRef.current = motionOk;
  useEffect(() => {
    window.clearTimeout(motionFadeTimer.current);
    setMotionVisible(false);
    setMotionOn(motionOk && livePlayRef.current);
  }, [liveId, motionOk]);
  // fade the still back in over the clip, then drop the clip
  const endMotion = useCallback(() => {
    setMotionVisible(false);
    window.clearTimeout(motionFadeTimer.current);
    motionFadeTimer.current = window.setTimeout(() => setMotionOn(false), MOTION_FADE_MS);
  }, []);
  const replayMotion = useCallback(() => {
    window.clearTimeout(motionFadeTimer.current);
    setMotionVisible(false); // the still stays up until the clip's first frame decodes
    setMotionOn(true);
  }, []);
  // The Live button toggles the persisted live-play preference AND applies it
  // to the photo on screen.
  const toggleLivePlay = useCallback(() => {
    const next = !livePlayRef.current;
    setLivePlay(next);
    setLivePlayState(next);
    if (next && motionOkRef.current) replayMotion();
    else endMotion();
    poke();
  }, [replayMotion, endMotion, poke]);
  // The still sits ON TOP of the motion clip and fades OUT to reveal it, so an
  // opaque layer always covers the webOS hardware video plane (no black flash
  // from the plane punching through a transparent layer). The still is a
  // cached element, so its fade is set on it directly and undone when the
  // frame changes.
  const fadedRef = useRef<Still | null>(null);
  useEffect(() => {
    const prev = fadedRef.current;
    if (prev !== visibleImg) {
      // a new frame: the old still comes back opaque at once, and the new one
      // starts opaque (motionVisible still describes the old photo's clip here)
      for (const el of [prev, visibleImg]) {
        if (el) {
          el.style.transition = '';
          el.style.opacity = '';
        }
      }
      fadedRef.current = visibleImg;
      return;
    }
    if (!visibleImg) return;
    visibleImg.style.transition = `opacity ${MOTION_FADE_MS}ms ease-in-out`;
    visibleImg.style.opacity = motionVisible ? '0' : '';
  }, [visibleImg, motionVisible]);

  // own key listener (the shell's remote handler is disabled while we're up)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const code = e.keyCode;
      poke();
      const dir = dirFromKey(code);
      // viewer on a video: OK and the media keys drive the clip
      const vid = viewer ? cache.current.get(iRef.current)?.el : undefined;
      // the seek group needs a clip that loaded (a failed one shows no transport)
      const seekable = !!vid && !cache.current.get(iRef.current)?.error;
      const g = groupRef.current;

      // Back drops a picked group back to previous/next first, then closes
      if (isBack(code)) {
        e.preventDefault();
        if (g !== 'nav') selectGroup('nav');
        else exit();
        return;
      }

      // options bar: Left/Right walk its buttons, OK presses one, Up steps
      // back up. The media keys still reach the clip/show below.
      if (g === 'bar') {
        if (dir === 'left' || dir === 'right') {
          e.preventDefault();
          focusBarBtn(dir === 'left' ? -1 : 1);
          return;
        }
        if (dir === 'up') {
          e.preventDefault();
          selectGroup(seekable ? 'seek' : 'nav');
          return;
        }
        if (dir === 'down') {
          e.preventDefault();
          return;
        }
        if (code === Key.Enter) {
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.click();
          return;
        }
      }

      // zoomed photo: arrows pan it and OK resets to fit
      if (zoomRef.current > 1) {
        if (code === Key.Enter || code === Key.PlayPause) {
          e.preventDefault();
          setZoom(1);
          setPan({ x: 0, y: 0 });
          return;
        }
        if (dir) {
          e.preventDefault();
          const z = zoomRef.current;
          setPan((p) => {
            const dx = dir === 'left' ? PAN_KEY_STEP : dir === 'right' ? -PAN_KEY_STEP : 0;
            const dy = dir === 'up' ? PAN_KEY_STEP : dir === 'down' ? -PAN_KEY_STEP : 0;
            return clampPan(p.x + dx, p.y + dy, z);
          });
          return;
        }
      }

      // Down/Up step through the groups as they sit on screen: nav (the side
      // arrows), seek (the transport, videos only), bar (the bottom edge)
      if (dir === 'down') {
        e.preventDefault();
        selectGroup(g === 'nav' && seekable ? 'seek' : 'bar');
        return;
      }
      if (dir === 'up') {
        e.preventDefault();
        if (g === 'seek') selectGroup('nav');
        return;
      }

      // viewer on a video: OK plays/pauses the clip; Left/Right step to the
      // previous/next item, or jump the clip with the seek group picked
      if (vid) {
        if (code === Key.Enter || code === Key.PlayPause) {
          e.preventDefault();
          toggleVideo();
        } else if (code === Key.Play) {
          e.preventDefault();
          vidHoldRef.current = false;
          playEl(vid);
        } else if (code === Key.Pause) {
          e.preventDefault();
          if (!vid.paused) toggleVideo();
        } else if (code === Key.FastForward) {
          e.preventDefault();
          seek(SEEK_STEP);
        } else if (code === Key.Rewind) {
          e.preventDefault();
          seek(-SEEK_STEP);
        } else if (dir === 'left') {
          e.preventDefault();
          g === 'seek' ? seek(-SEEK_STEP) : advance(-1, true);
        } else if (dir === 'right') {
          e.preventDefault();
          g === 'seek' ? seek(SEEK_STEP) : advance(1, true);
        }
        return;
      }

      if (dir === 'left') {
        e.preventDefault();
        advance(-1, true); // follows through once the previous frame loads
      } else if (dir === 'right') {
        e.preventDefault();
        advance(1, true); // follows through once the next frame loads
      } else if (code === Key.Enter || code === Key.PlayPause) {
        e.preventDefault();
        setPlaying(pausedRef.current);
      } else if (code === Key.Play) {
        e.preventDefault();
        setPlaying(true);
      } else if (code === Key.Pause) {
        e.preventDefault();
        setPlaying(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    advance,
    exit,
    poke,
    setPlaying,
    selectGroup,
    focusBarBtn,
    viewer,
    toggleVideo,
    playEl,
    seek,
  ]);

  if (!asset) return null;

  const cur = cache.current.get(i);
  const curVideo = viewer && asset.isVideo ? cur?.el : undefined;
  const videoError = !!curVideo && !!cur?.error;
  const loadFailed = viewer && failed === asset.id;
  // spinner: nothing loaded yet for the current item, current video still
  // decoding, or a manual d-pad nav waiting on its target frame to load (the
  // press is acknowledged, not dropped)
  const buffering =
    navPending ||
    (!cur && !loadFailed) ||
    (!!asset.isVideo && !!cur && !cur.decoded && !cur.error);
  // key on the caption CONTENT so it only re-animates when the text changes
  // (consecutive shots from the same place/day won't re-trigger the animation)
  const metaKey = `${meta.loc ?? ''}|${meta.date}`;
  const pct = progress.dur > 0 ? (progress.cur / progress.dur) * 100 : 0;
  const bufferedPct = progress.dur > 0 ? Math.min(100, (progress.buffered / progress.dur) * 100) : 0;
  // previous/next arrows: hidden at the viewer's ends (the show wraps) and
  // while zoomed (the d-pad pans)
  const showPrev = !zoomed && (!viewer || i > 0);
  const showNext = !zoomed && (!viewer || i < assets.length - 1);
  // viewer on a photo: the slideshow's play/pause and the photo's number take
  // the place of a clip's transport
  const photoPlace =
    viewer && !asset.isVideo ? placeOf?.(asset.id) ?? { n: i + 1, total: assets.length } : null;

  // Zoom minimap: the whole photo with a rectangle marking the visible region,
  // computed from the contain-fit size, the current scale, and the pan (all in
  // screen px).
  let mini: {
    w: number;
    h: number;
    box: { left: string; top: string; width: string; height: string };
  } | null = null;
  if (zoomed && visibleImg && miniSrc) {
    const [iw, ih] = stillSize(visibleImg);
    const imgAspect = iw > 0 && ih > 0 ? iw / ih : 1;
    const Vw = window.innerWidth;
    const Vh = window.innerHeight;
    // contain-fit size at scale 1
    let baseW: number, baseH: number;
    if (imgAspect > Vw / Vh) {
      baseW = Vw;
      baseH = Vw / imgAspect;
    } else {
      baseH = Vh;
      baseW = Vh * imgAspect;
    }
    const Sw = baseW * zoom;
    const Sh = baseH * zoom;
    const fx = Math.min(1, Vw / Sw);
    const fy = Math.min(1, Vh / Sh);
    // viewport center offset from image center (pan moves the image, so the
    // view center moves opposite), normalized to the scaled image.
    const cx = 0.5 - pan.x / Sw;
    const cy = 0.5 - pan.y / Sh;
    const bx = Math.max(0, Math.min(1 - fx, cx - fx / 2));
    const by = Math.max(0, Math.min(1 - fy, cy - fy / 2));
    const MINI_W = 220;
    mini = {
      w: MINI_W,
      h: Math.round(MINI_W / imgAspect),
      box: {
        left: bx * 100 + '%',
        top: by * 100 + '%',
        width: fx * 100 + '%',
        height: fy * 100 + '%',
      },
    };
  }

  // Mount a frame's reused element (pre-decoded <img> or buffering <video>) as
  // the sole child of a persistent crossfade layer. The element is reparented,
  // never recreated, so it never re-decodes/re-downloads or flashes black. Only
  // the visible layer's video plays; the outgoing one freezes as it fades.
  const mountLayer = (node: HTMLDivElement | null, f: Frame | null, on: boolean) => {
    if (!node) return;
    const want = (f && (f.el || f.img)) || null;
    if (node.firstChild !== want) {
      while (node.firstChild) node.removeChild(node.firstChild); // detach prior element (still cached)
      if (want) node.appendChild(want);
    }
    if (f?.el) {
      if (on && wantPlay()) playEl(f.el);
      else f.el.pause();
    }
  };

  // Portal to <body>: rendered inside the shell's .view-enter, whose lingering
  // transform (animation ... both) would otherwise trap position:fixed inside
  // the content box, leaving the sidebar visible instead of a true fullscreen.
  return createPortal(
    <div
      class={'wp-player group-' + group + (overlay ? ' show-ui' : '')}
      onMouseMove={poke}
      onWheel={viewer ? onWheel : undefined}
      onPointerDown={viewer ? onImgDown : undefined}
      onPointerMove={viewer ? onImgMove : undefined}
      onPointerUp={viewer ? onImgUp : undefined}
      onPointerCancel={viewer ? onImgUp : undefined}
    >
      {/* off-screen full-screen stage: stills are laid out + rastered here at
          display size before they're shown, then reparented into a frame layer */}
      <div class="wp-stage" ref={stageRef} />
      {/* Live Photo motion, UNDER the current layer (same z-index, earlier in
          the DOM). The clip is sized to the photo so the video plane only
          punches through where the photo is, and the blurred fill the still
          carries is copied here so the sides stay put while it plays. */}
      {motionOn && liveId && visibleImg && (
        <div class="wp-motion" style={backdropOf(visibleImg)}>
          <video
            ref={motionRef}
            src={videoStreamUrl(liveId)}
            style={containRect(visibleImg)}
            autoPlay
            muted
            playsInline
            // webOS fires `playing` at the first frame then can stall the
            // short transcoded clip; kick playback on canplay and re-issue
            // play() on any stall so it does not freeze on frame one.
            onCanPlay={() => { void motionRef.current?.play().catch(() => {}); }}
            // Reveal only once frames are actually advancing on the hardware
            // plane. `playing` fires a beat early on webOS, so fading the still
            // then punches a black frame mid-fade; waiting for currentTime > 0
            // guarantees a real frame is on the plane before the still fades.
            onTimeUpdate={() => {
              if ((motionRef.current?.currentTime ?? 0) > 0) setMotionVisible(true);
            }}
            onWaiting={() => { void motionRef.current?.play().catch(() => {}); }}
            onStalled={() => { void motionRef.current?.play().catch(() => {}); }}
            onEnded={endMotion}
            onError={() => setMotionOn(false)}
          />
        </div>
      )}
      {(['a', 'b'] as const).map((slot) => {
        const f = layers[slot];
        const on = (slot === 'a') === showA; // this layer is the current one
        // Crossfade = fade the OUTGOING layer OUT, never the incoming one IN.
        // The current frame snaps to opacity 1 underneath (z1, no transition);
        // the previous frame sits opaque on top (z2) until `fading` flips (two
        // painted frames later), then transitions 1->0 to reveal it. A 0->1
        // fade-in is unreliable on webOS Cr79: a layer parked at opacity 0 may
        // never be rastered, so the transition has no painted start state and
        // snaps. The outgoing layer has been on screen for seconds — its 1->0
        // always animates, and delaying its start keeps the incoming frame's
        // raster stall from eating the transition window. Inline styles, not
        // classes, so each layer's opacity/z-index/transition commit atomically.
        return (
          <div
            key={slot}
            class="wp-frame"
            style={
              on
                ? { opacity: 1, zIndex: 1, transition: 'none' }
                : fading
                  ? { opacity: 0, zIndex: 2, transition: `opacity ${fadeMs}ms ease` }
                  : { opacity: 1, zIndex: 2, transition: 'none' }
            }
            ref={(node) => mountLayer(node, f, on)}
          />
        );
      })}

      {(videoError || loadFailed) && (
        <div class="wp-player-msg">
          {videoError ? 'This video format is not supported on this TV.' : "This photo couldn't be loaded."}
        </div>
      )}

      {(buffering || warming) && (
        <div class={'wp-player-spin' + (warming ? ' cover' : '')}>
          <div class="fs-spinner" />
        </div>
      )}

      {/* zoom minimap: whole photo + visible-region rectangle */}
      {mini && miniSrc && (
        <div class="fs-minimap" style={{ width: `${mini.w}px`, height: `${mini.h}px` }}>
          <img src={miniSrc} />
          <div class="fs-minimap-box" style={mini.box} />
        </div>
      )}

      {/* bottom-left caption, animates in fresh for each wallpaper (keyed by id) */}
      {meta.date && !zoomed && (
        <div class="wp-player-meta" key={metaKey}>
          {meta.loc && <div class="wp-player-loc">{meta.loc}</div>}
          {meta.date && <div class="wp-player-date">{meta.date}</div>}
        </div>
      )}

      {/* seek line on the bottom edge, shown the whole time a video plays, not
          only while the transport is up. Click or drag it with the pointer. */}
      {curVideo && !videoError && !warming && (
        <div
          ref={seekRef}
          class="wp-edge-progress"
          onPointerDown={onSeekDown}
          onPointerMove={onSeekMove}
          onPointerUp={onSeekUp}
          onPointerCancel={onSeekUp}
        >
          <div class="wp-edge-track">
            <div class="wp-edge-buffer" style={{ width: `${bufferedPct}%` }} />
            <div class="wp-edge-fill" style={{ width: `${pct}%` }}>
              <span class="wp-edge-knob" />
            </div>
          </div>
        </div>
      )}

      {/* the viewer's slideshow: a photo's dwell running out along the same
          line (not a seek bar, so the pointer passes through it) */}
      {viewer && !paused && !asset.isVideo && dwell.n > 0 && (
        <div class="wp-edge-progress dwell">
          <div class="wp-edge-track">
            <div class="wp-edge-fill" key={dwell.n} style={{ animationDuration: `${dwell.ms}ms` }} />
          </div>
        </div>
      )}

      <div class="wp-player-ui">
        {showPrev && (
          <button class="fs-arrow left" onClick={() => advance(-1, true)} title="Previous">
            <Icon name="chevronLeft" size={48} />
          </button>
        )}
        {showNext && (
          <button class="fs-arrow right" onClick={() => advance(1, true)} title="Next">
            <Icon name="chevronRight" size={48} />
          </button>
        )}

        {/* video transport: 10s jumps around play/pause, + time, above the
            caption (the seek bar is the edge line) */}
        {curVideo && !videoError && !warming && (
          <div class="wp-transport">
            <button class="fs-btn round" onClick={() => seek(-SEEK_STEP)} title="Back 10 seconds">
              <Icon name="rewind10" size={30} />
            </button>
            <button class="fs-btn round" onClick={toggleVideo} title={vidPaused ? 'Play' : 'Pause'}>
              <Icon name={vidPaused ? 'play' : 'pause'} size={30} />
            </button>
            <button class="fs-btn round" onClick={() => seek(SEEK_STEP)} title="Forward 10 seconds">
              <Icon name="forward10" size={30} />
            </button>
            <span class="fs-time">
              {fmt(progress.cur)} / {fmt(progress.dur)}
            </span>
          </div>
        )}

        {/* photo transport: the slideshow's play/pause right where a clip's
            is (an invisible back-10s button holds its place), + photo number */}
        {photoPlace && (
          <div class="wp-transport">
            <span class="fs-btn round ghost" aria-hidden="true">
              <Icon name="rewind10" size={30} />
            </span>
            <button
              class="fs-btn round"
              onClick={() => { setPlaying(pausedRef.current); poke(); }}
              title={paused ? 'Start slideshow' : 'Pause slideshow'}
            >
              <Icon name={paused ? 'play' : 'pause'} size={30} />
            </button>
            <span class="fs-time">
              {photoPlace.n.toLocaleString()} / {photoPlace.total.toLocaleString()}
            </span>
          </div>
        )}

        <div class="wp-player-top" ref={barRef}>
          {/* the viewer's photos start the show from their transport */}
          {!photoPlace && (
            <button
              class={'wp-text-btn' + (paused ? '' : ' active')}
              onClick={() => { setPlaying(pausedRef.current); poke(); }}
              title={paused ? 'Start slideshow' : 'Pause slideshow'}
            >
              <Icon name={paused ? 'play' : 'pause'} size={22} />
              <span>Slideshow</span>
            </button>
          )}
          {liveId && (
            <button
              class={'wp-icon-btn' + (livePlay ? ' active' : '')}
              onClick={toggleLivePlay}
              title={livePlay ? 'Live play on' : 'Live play off'}
            >
              <Icon name="live" size={22} />
            </button>
          )}
          {curVideo && (
            <button class="wp-text-btn" onClick={cycleQuality} title="Video quality">
              <Icon name="hd" size={22} />
              <span>{cur?.q === 'original' ? 'Original' : 'Transcoded'}</span>
            </button>
          )}
          <div class="wp-speed">
            {SPEEDS.map((s) => (
              <button
                key={s.ms}
                class={'wp-speed-btn' + (s.ms === intervalMs ? ' active' : '')}
                onClick={() => { setIntervalMs(s.ms); poke(); }}
              >
                {s.label}
              </button>
            ))}
          </div>
          {canShuffle && (
            <button
              class={'wp-icon-btn' + (shuffle ? ' active' : '')}
              onClick={() => { toggleShuffle(); poke(); }}
              title="Shuffle"
            >
              <Icon name="shuffle" size={22} />
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Originals this TV has loaded but refused to pre-decode (see decodeStill).
// After two, skipOriginals sends every still straight to the preview for the
// rest of the app's life instead of downloading originals only to drop them.
let undecodableOriginals = 0;
let skipOriginals = false;

// Build an <img> element and fully decode its bitmap off-screen, resolving with
// the SAME element once it's ready to paint. The caller caches and mounts this
// exact element, so it never re-decodes on screen (older sets only; newer ones
// use loadBitmapStill). `decoded` is false when the bytes loaded but decode()
// was refused: Chromium rejects it whenever its decode budget is short (on
// webOS 10 always for images around 4K and up, intermittently even for a 1080p
// JPEG) although the image paints fine, so it's kept and the compositor
// decodes it when it's first shown. A real format
// failure (HEIC/RAW original) loads with no natural size and still rejects: the
// caller must fall back to the preview JPEG rather than cache a broken element
// that renders black.
async function decodeStill(src: string): Promise<{ img: HTMLImageElement; decoded: boolean }> {
  const img = new Image();
  img.src = src;
  if (!img.decode) return { img, decoded: true }; // can't verify — assume paintable
  try {
    await img.decode();
    return { img, decoded: true };
  } catch (err) {
    if (img.naturalWidth > 0) return { img, decoded: false };
    throw err;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Paint a blurred, dimmed, screen-filling copy of a still as the <img>'s own
// CSS background, so with object-fit:contain the side bars show the photo's
// colors instead of black. It stays ONE element — the layer/stage reparenting
// is untouched. The blur runs once on a tiny canvas (cheap on TV hardware,
// unlike a live CSS filter over a 4K layer) and the browser's upscale adds more
// softness. The canvas overshoots the screen by a margin that is scaled
// off-screen, hiding the blur's dark edge falloff. Best-effort: on any failure
// (e.g. a tainted canvas) the bars just stay black.
//
// Drawn from the asset's small grid thumbnail, not the shown image: drawing
// the full photo decoded it on the main thread and read the canvas back from
// the busy GPU, which froze the UI for up to a second per portrait on the TV.
// A CPU canvas (willReadFrequently) keeps the readback off the GPU entirely.
const BACKDROP_W = 192; // backdrop canvas width; height follows the screen aspect
const BACKDROP_BLUR = 6; // px at canvas scale (~60px at 1080p)
async function applyBlurBackdrop(img: Still, id: string): Promise<void> {
  try {
    const thumb = await loadImage(await loadThumb(id));
    const sw = window.innerWidth || 1920;
    const sh = window.innerHeight || 1080;
    const w = BACKDROP_W;
    const h = Math.round((BACKDROP_W * sh) / sw);
    const m = BACKDROP_BLUR * 2;
    const canvas = document.createElement('canvas');
    canvas.width = w + 2 * m;
    canvas.height = h + 2 * m;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    // cover-fit the photo into the canvas (center crop)
    const scale = Math.max(canvas.width / thumb.naturalWidth, canvas.height / thumb.naturalHeight);
    const dw = thumb.naturalWidth * scale;
    const dh = thumb.naturalHeight * scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = `blur(${BACKDROP_BLUR}px)`;
    ctx.drawImage(thumb, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    ctx.filter = 'none';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'; // dim so the photo itself stands out
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.9);
    // decode up front so the backdrop is paintable by the stage raster
    const pre = new Image();
    pre.src = url;
    if (pre.decode) await pre.decode().catch(() => {});
    img.style.backgroundColor = '#000';
    img.style.backgroundImage = `url(${url})`;
    img.style.backgroundRepeat = 'no-repeat';
    img.style.backgroundPosition = '50% 50%';
    img.style.backgroundSize = `${(canvas.width / w) * 100}% ${(canvas.height / h) * 100}%`;
  } catch {
    /* no backdrop — plain black bars */
  }
}

// the blurred fill a still carries (see applyBlurBackdrop), for an element
// that has to show the same bars (the Live Photo motion layer)
function backdropOf(img: Still): Record<string, string> {
  return {
    backgroundColor: '#000',
    backgroundImage: img.style.backgroundImage,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: img.style.backgroundPosition,
    backgroundSize: img.style.backgroundSize,
  };
}

// where a contain-fitted still sits on screen, in px
function containRect(img: Still): Record<string, string> {
  const [w, h] = stillSize(img);
  const W = window.innerWidth || 1920;
  const H = window.innerHeight || 1080;
  const s = w > 0 && h > 0 ? Math.min(W / w, H / h) : 0;
  const dw = s ? w * s : W;
  const dh = s ? h * s : H;
  return {
    left: `${(W - dw) / 2}px`,
    top: `${(H - dh) / 2}px`,
    width: `${dw}px`,
    height: `${dh}px`,
  };
}

// Weighted shuffle (Efraimidis-Spirakis): each item gets key = rand^(1/weight),
// sorted descending -> a uniform random permutation biased so heavier items tend
// earlier / appear more (the same weighted-sampling trick Apple/Google Photos use
// to favor "good" shots). Weight 1 is the neutral baseline. In-place on `a`.
const FAV_WEIGHT = 4; // a favorite is ~4x as likely to land early as a plain shot
function weightedShuffle<T>(a: T[], weight: (item: T) => number): void {
  const key = new Map<T, number>();
  for (const item of a) {
    const w = Math.max(1e-6, weight(item));
    // rand in (0,1]; ^(1/w) — larger w pushes the key toward 1 (sorts earlier)
    key.set(item, Math.pow(Math.random() || 1e-9, 1 / w));
  }
  a.sort((x, y) => key.get(y)! - key.get(x)!);
}

function fmtPlace(r: { city?: string | null; state?: string | null; country?: string | null }): string | null {
  const parts = [r.city, r.state, r.country].filter(Boolean) as string[];
  const deduped = parts.filter((p, k) => p !== parts[k - 1]);
  return deduped.length ? deduped.join(', ') : null;
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
