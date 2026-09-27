import { useEffect, useState, useRef, useCallback, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Asset } from '../api/assets';
import { loadBlob, loadBlobUrl, loadThumb, revoke, appliesExifOrientation } from '../api/media';
import {
  thumbnailUrl,
  videoStreamUrl,
  originalUrl,
  getAssetLocation,
  getAssetOrientation,
  getAssetPixels,
} from '../api/client';
import { Key, isBack, dirFromKey } from '../nav/keys';
import { fetchStations, Station } from '../api/radio';
import { keepAwake } from '../api/screensaver';
import { Icon } from '../components/Icon';
import { aimAtFaces } from './faceCrop';
import { SeenStore } from './wallpaperSeen';

interface Props {
  assets: Asset[];
  // 'photos': muted stills slideshow with the dwell-speed + background-music
  // controls. 'videos': clips play with their ORIGINAL audio, and the speed +
  // music controls are hidden (webOS has one hardware media pipeline — a
  // radio stream and a video can't decode at the same time, the video plane
  // just goes black).
  mode: 'photos' | 'videos';
  onExit: () => void;
  // called when nearing the end of the loaded list so more buckets can load
  onNearEnd?: () => void;
  // called when the user toggles shuffle. The feed randomizes its remaining
  // bucket order so shuffle spans the whole source, not just the loaded page.
  onShuffleChange?: (on: boolean) => void;
  // what this source has already shown (persisted): shuffle skips these
  seen: SeenStore;
}

const HIDE_MS = 3000;
const BAR_IDLE_MS = 8000; // hide the focused bar after this long with no input
const CAPTION_DELAY_MS = 1000; // location/date animate in this long after a transition
const SPEEDS = [
  { label: '5s', ms: 5000 },
  { label: '10s', ms: 10000 },
  { label: '15s', ms: 15000 },
];
const DEFAULT_MS = SPEEDS[0].ms; // dwell per still (5s)
const GENRES = [
  { label: 'Ambient', tag: 'ambient' },
  { label: 'Lofi', tag: 'lofi' },
  { label: 'Jazz', tag: 'jazz' },
  { label: 'Classical', tag: 'classical' },
];
const DEFAULT_GENRE = 'lofi'; // music starts on with this genre (photos mode)
const WINDOW = 2; // stills prefetched ahead (each holds a decoded bitmap in TV RAM)
const VIDEO_STALL_MS = 8000; // skip a video that hasn't produced a frame by now
const PREBUFFER_S = 5; // seconds of the NEXT video to pre-download

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
  el?: HTMLVideoElement; // for video: the buffering, reusable element
  img?: Still; // for still: the fully-decoded, reusable <img>/canvas element
}

interface Frame {
  key: number;
  asset: Asset;
  src: string;
  el?: HTMLVideoElement;
  img?: Still;
}

// Fullscreen auto-advancing wallpaper slideshow. Stills crossfade on a timer,
// pre-decoded (original quality when it fits the screen, else the preview);
// videos buffer in chunks (progressive range streaming, like
// the grid) and play muted to the end, then advance. Navigation (auto or d-pad)
// only moves to an item whose media is loaded — never onto a black/unready
// frame. Loops forever. Owns its own key listener; the shell disables its
// remote handler while this is up.
export function WallpaperPlayer({ assets: assetsProp, mode, onExit, onNearEnd, onShuffleChange, seen }: Props) {
  const [i, setI] = useState(0);
  // Play order: `order` is a permutation of indices into assetsProp; `assets`
  // (used everywhere below) is the sequenced list the show walks. Shuffled by
  // default (a random permutation); turning shuffle off restores identity order.
  // Keeping playback consecutive over `assets` preserves the prefetch window,
  // eviction, and near-end paging unchanged — only the mapping changes. The
  // feed starts shuffled too, so the first batch is already unseen items.
  const [shuffle, setShuffle] = useState(true);
  const shuffleRef = useRef(true);
  shuffleRef.current = shuffle;
  const [order, setOrder] = useState<number[]>(() => {
    const ids = assetsProp.map((_, k) => k);
    weightedShuffle(ids, (k) => (assetsProp[k]?.isFavorite ? FAV_WEIGHT : 1));
    return ids;
  });
  const orderRef = useRef(order);
  orderRef.current = order;
  // bumped by the shuffle toggle so the show effect re-runs even when index 0
  // keeps the same asset (the frame on screen is kept at the head)
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
  const [paused, setPaused] = useState(false);
  const [overlay, setOverlay] = useState(true);
  // when true, d-pad drives the options bar (left/right between buttons, Enter
  // activates) instead of the photo track. Entered with Up, left with Down/Back.
  const [focusBar, setFocusBar] = useState(false);
  const focusBarRef = useRef(false);
  focusBarRef.current = focusBar;
  const barRef = useRef<HTMLDivElement>(null);
  // true while d-pad focus sits on the music button or one of its genre pills;
  // gates the genre popover so it only shows when the music control is focused
  const [musicFocus, setMusicFocus] = useState(false);
  // transient play/pause feedback pill, shown briefly on each toggle
  const [pill, setPill] = useState<'none' | 'paused' | 'playing'>('none');
  const pillTimer = useRef<number | undefined>(undefined);
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
  // slideshow speed for stills (videos advance on their own end)
  const [intervalMs, setIntervalMs] = useState(DEFAULT_MS);
  const intervalRef = useRef(DEFAULT_MS);
  intervalRef.current = intervalMs;
  // background music (Radio Browser internet-radio streams)
  // on by default in photos mode; videos mode plays the clips' own audio
  const [musicOn, setMusicOn] = useState(mode === 'photos');
  const [genre, setGenre] = useState(DEFAULT_GENRE);
  const [stations, setStations] = useState<Station[]>([]);
  const [stIdx, setStIdx] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const musicOnRef = useRef(musicOn);
  musicOnRef.current = musicOn;
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  // hold off the TV screen saver for as long as the player is open (no-op off
  // webOS); cleanup releases it so the saver resumes on the timeline
  useEffect(() => keepAwake(), []);

  const keyRef = useRef(0);
  // off-screen full-screen container used to lay out + raster a decoded still at
  // display size BEFORE it's shown, so the transition never hitches on a
  // first-composite resize (see fitOnStage / loadInto).
  const stageRef = useRef<HTMLDivElement>(null);
  const advanceTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const iRef = useRef(0);
  iRef.current = i;
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  // latest "advance forward" fn, so video element listeners never go stale
  const advanceRef = useRef<() => void>(() => {});

  // play() with an autoplay-policy fallback: an UNMUTED play can be rejected
  // (desktop dev without a fresh gesture) — degrade that clip to muted rather
  // than letting it sit black until the stall watchdog skips it.
  const playEl = useCallback((el: HTMLVideoElement) => {
    void el.play().catch(() => {
      if (!el.muted) {
        el.muted = true;
        void el.play().catch(() => {});
      }
    });
  }, []);

  const asset = assets[i];

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
  // photo. Everything else keeps the face-aimed full-screen cover crop.
  const prepStill = useCallback(
    async (img: Still, id: string): Promise<void> => {
      const [w, h] = stillSize(img);
      if (h > w) {
        await applyBlurBackdrop(img, id);
        await fitOnStage(img, 'contain');
      } else {
        await aimAtFaces(img, id); // aim the cover crop BEFORE the stage raster
        await fitOnStage(img, 'cover');
      }
    },
    [fitOnStage],
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
        const el = document.createElement('video');
        el.src = videoStreamUrl(a.id);
        // videos mode plays clips with their original audio; photos mode keeps
        // any interleaved video muted (there shouldn't be one, but stay safe)
        el.muted = mode !== 'videos';
        el.playsInline = true;
        // only metadata while it's a lookahead/behind; promoted to 'auto' when
        // it becomes the current clip (keeps at most one clip fully buffering).
        el.preload = 'metadata';
        el.setAttribute('playsinline', '');
        if (el.muted) el.setAttribute('muted', '');
        const e: Cached = { src: el.src, isVideo: true, blob: false, ready: false, decoded: false, el };
        // NOTE: no aimAtFaces on videos. webOS composites <video> on its own
        // hardware plane; a non-center object-position breaks the hole-punch
        // and the video renders black (fine on desktop). Face boxes for videos
        // are also detected on the thumbnail, so the data is unreliable anyway.
        el.addEventListener('loadedmetadata', () => { e.ready = true; bump(); }, { once: true });
        el.addEventListener('loadeddata', () => { e.decoded = true; bump(); }, { once: true });
        el.addEventListener('ended', () => { if (iRef.current === idx) advanceRef.current(); });
        el.addEventListener('waiting', () => { if (!pausedRef.current) playEl(el); });
        el.addEventListener('error', () => {
          e.ready = true; // let nav move onto it so it can be skipped
          e.error = true;
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
    [assets, bump, prepStill, loadBitmapStill, mode, playEl],
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

  // Pre-download ~PREBUFFER_S of a NEIGHBOUR video, then back off so it doesn't
  // keep filling. Download-only (never play()) so it won't grab the TV's HW
  // video decoder from the current clip. Once this item becomes current the
  // show effect flips it back to full 'auto' buffering.
  const capPrebuffer = useCallback((idx: number, e: Cached) => {
    const el = e.el;
    if (!el) return;
    el.preload = 'auto';
    const onProgress = () => {
      if (iRef.current === idx) {
        el.removeEventListener('progress', onProgress); // it's current now — let it buffer fully
        return;
      }
      let end = 0;
      try {
        if (el.buffered.length) end = el.buffered.end(el.buffered.length - 1);
      } catch {
        /* buffered not readable yet */
      }
      if (end >= PREBUFFER_S) {
        el.preload = 'metadata'; // best-effort: signal the browser to stop topping up
        el.removeEventListener('progress', onProgress);
      }
    };
    el.addEventListener('progress', onProgress);
    el.load();
  }, []);

  // tear down a cached element (release the blob, stop buffering, drop the DOM node)
  const teardown = (e: Cached) => {
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

  // Toggle shuffle: rebuild the whole order, reset the cache, restart at 0.
  // Shuffle skips everything this source has already shown (remembered across
  // sessions) and keeps the frame on screen at the head, carrying its cache
  // entry along, so the toggle doesn't cut away from it — and still plays when
  // every loaded item has been seen (onNearEnd then pulls unseen ones).
  const toggleShuffle = useCallback(() => {
    const next = !shuffleRef.current;
    let ids = assetsProp.map((_, k) => k);
    let keep: Cached | undefined;
    if (next) {
      const cur = orderRef.current[iRef.current];
      ids = ids.filter((k) => k !== cur && !seen.has(assetsProp[k].id));
      weightedShuffle(ids, (k) => (assetsProp[k]?.isFavorite ? FAV_WEIGHT : 1));
      if (cur !== undefined) {
        ids.unshift(cur);
        keep = cache.current.get(iRef.current);
        cache.current.delete(iRef.current);
      }
    }
    clearCache();
    if (keep) cache.current.set(0, keep);
    orderedUpTo.current = assetsProp.length;
    setShuffle(next);
    setOrder(ids);
    setI(0);
    setEpoch((n) => n + 1);
    onShuffleChange?.(next); // widen the bound: feed randomizes remaining buckets
  }, [assetsProp, clearCache, onShuffleChange, seen]);

  // An index is navigable only once its media is loaded: a still's blob is ready,
  // or a video has decoded its first frame (or errored, so it can be skipped).
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
    (delta: number) => {
      const n = iRef.current + delta;
      if (n < 0) return assets.length - 1; // wrap to last
      // wrap to first — except while shuffling: hold for the next unseen batch
      // (onNearEnd) rather than replay what was just shown
      if (n >= assets.length) return shuffleRef.current ? iRef.current : 0;
      return n;
    },
    [assets.length],
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
    (delta: number, manual = false) => {
      const n = targetIndex(delta);
      // nowhere else to go (yet): leave the frame and timers alone; the auto
      // retry loop polls until onNearEnd has appended more
      if (n === iRef.current) return false;
      navToken.current++; // supersede any pending manual nav
      if (isLoaded(n)) {
        setNavPending(false);
        window.clearTimeout(advanceTimer.current);
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
      void loadInto(n).then(() => {
        if (navToken.current !== token) return; // a newer press took over
        setNavPending(false);
        if (isLoaded(n)) setI(n);
        else advanceRef.current(); // unloadable target — resume the show
      });
      return false;
    },
    [targetIndex, isLoaded, loadInto],
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

  const prefetchGeoFor = useCallback((a: Asset) => {
    if (geoCache.current.has(a.id)) return;
    const date = fmtDate(a.createdAt);
    getAssetLocation(a.id)
      .then((r) => {
        const parts = [r.city, r.state, r.country].filter(Boolean) as string[];
        const deduped = parts.filter((p, k) => p !== parts[k - 1]);
        geoCache.current.set(a.id, { loc: deduped.length ? deduped.join(', ') : null, date });
      })
      .catch(() => { geoCache.current.set(a.id, { loc: null, date }); });
  }, []);

  // load + show the current asset, prefetch ahead, evict the rest
  useEffect(() => {
    if (!asset) return;
    let alive = true;
    const key = ++keyRef.current;
    let stallTimer: number | undefined;
    window.clearTimeout(advanceTimer.current);

    loadInto(i)
      .then((e) => {
        if (!alive) return;
        if (!e) return scheduleNext(500); // unloadable still — skip quickly
        if (!e.isVideo) {
          showFrame({ key, asset, src: e.src, img: e.img });
          scheduleNext(intervalRef.current); // stills auto-advance on a timer
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
          if (!pausedRef.current) playEl(el);
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
          if (pausedRef.current) { lastT = -1; return; } // don't skip a paused clip
          const t = el.currentTime || 0;
          if (t > lastT) { lastT = t; strikes = 0; return; }
          if (++strikes >= ticks) { window.clearInterval(stallTimer); scheduleNext(0); }
        }, 2000);
      })
      .catch(() => alive && scheduleNext(500))
      .then(prefetch);

    // Prefetch the window ONE AT A TIME, nearest first, once the current frame
    // is in: loading everything at once made the frames race each other for
    // the TV's bandwidth and decoder, so the one needed next landed last. All
    // stills in the window, but only the NEXT video ahead (videos are heavy to
    // buffer — one lookahead is enough to keep nav unblocked). Stops when the
    // show moves on; the next run resumes from cache.
    async function prefetch() {
      let vids = 0;
      for (let k = i + 1; k <= i + WINDOW && k < assets.length; k++) {
        if (!alive) return;
        prefetchGeoFor(assets[k]);
        if (assets[k].isVideo) {
          if (vids < 1) {
            vids++;
            const e = await loadInto(k);
            if (e?.el) capPrebuffer(k, e); // ~5s prebuffer
          }
        } else {
          await loadInto(k);
        }
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

    const cached = geoCache.current.get(shownAsset.id);
    if (cached) {
      // We already know the new meta. Clear the old caption now only when the
      // content is actually changing — same place/date stays visible throughout.
      const newKey = `${cached.loc ?? ''}|${cached.date}`;
      const curKey = `${metaRef.current.loc ?? ''}|${metaRef.current.date}`;
      if (newKey !== curKey) setMeta({ loc: null, date: '' });
      const t = window.setTimeout(() => { if (alive) setMeta(cached); }, CAPTION_DELAY_MS);
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
    const t = window.setTimeout(() => { delayed = true; commit(); }, CAPTION_DELAY_MS);
    getAssetLocation(shownAsset.id)
      .then((r) => {
        const parts = [r.city, r.state, r.country].filter(Boolean) as string[];
        const deduped = parts.filter((p, k) => p !== parts[k - 1]);
        loc = deduped.length ? deduped.join(', ') : null;
      })
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
      window.clearTimeout(pillTimer.current);
      for (const e of held.values()) teardown(e);
      held.clear();
      seen.flush();
    };
  }, []);

  // pause/resume: stop the timer + current video, or resume playback/rotation
  useEffect(() => {
    const cur = cache.current.get(iRef.current);
    if (paused) {
      window.clearTimeout(advanceTimer.current);
      cur?.el?.pause();
    } else if (cur?.isVideo) {
      if (cur.el) playEl(cur.el);
    } else {
      scheduleNext(intervalRef.current);
    }
  }, [paused, scheduleNext, playEl]);

  // changing the speed while a still is showing restarts its timer at the new rate
  useEffect(() => {
    if (paused) return;
    if (!assets[iRef.current]?.isVideo) scheduleNext(intervalMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  const poke = useCallback(() => {
    setOverlay(true);
    window.clearTimeout(hideTimer.current);
    if (focusBarRef.current) {
      // focused but idle: after a longer window, hide the bar AND drop focus
      hideTimer.current = window.setTimeout(() => {
        setFocusBar(false);
        focusBarRef.current = false;
        (document.activeElement as HTMLElement | null)?.blur();
        setOverlay(false);
      }, BAR_IDLE_MS);
      return;
    }
    hideTimer.current = window.setTimeout(() => setOverlay(false), HIDE_MS);
  }, []);

  // Walk a live list of buttons, wrapping at both ends, moving focus by `delta`.
  const walk = (btns: HTMLButtonElement[], delta: number) => {
    if (!btns.length) return;
    const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = cur < 0 ? 0 : (cur + delta + btns.length) % btns.length;
    btns[next].focus();
  };
  // bottom-row buttons (genre pills live in a popover ABOVE, walked separately)
  const barBtns = () =>
    Array.from(barRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []).filter(
      (b) => !b.closest('.wp-genres'),
    );
  const genreBtns = () =>
    Array.from(barRef.current?.querySelectorAll<HTMLButtonElement>('.wp-genres button') ?? []);
  // Move d-pad focus among the option-bar buttons (live query — the button set
  // changes with mode and whether music is on). Wraps at both ends.
  const focusBarBtn = useCallback((delta: number) => walk(barBtns(), delta), []);
  const focusGenreBtn = useCallback((delta: number) => walk(genreBtns(), delta), []);
  const focusMusicBtn = useCallback(() => {
    barRef.current
      ?.querySelector<HTMLButtonElement>('button[title="Background music"]')
      ?.focus();
  }, []);

  const enterBar = useCallback(() => {
    setFocusBar(true);
    focusBarRef.current = true; // sync: poke() below arms the focused-idle timer
    setOverlay(true);
    // focus the first button after the overlay has painted
    requestAnimationFrame(() => focusBarBtn(1));
    poke(); // arm the 8s idle-hide (resets on every subsequent key)
  }, [focusBarBtn, poke]);

  const leaveBar = useCallback(() => {
    setFocusBar(false);
    focusBarRef.current = false; // sync: poke() below reads the ref, not state
    (document.activeElement as HTMLElement | null)?.blur();
    poke();
  }, [poke]);

  const flashPill = useCallback((mode: 'paused' | 'playing') => {
    setPill(mode);
    window.clearTimeout(pillTimer.current);
    pillTimer.current = window.setTimeout(() => setPill('none'), 1400);
  }, []);

  // --- background music ---
  const loadGenre = useCallback(async (tag: string) => {
    const st = await fetchStations(tag);
    setStations(st);
    setStIdx(0);
  }, []);

  const toggleMusic = useCallback(async () => {
    poke();
    if (musicOn) {
      setMusicOn(false);
      return;
    }
    setMusicOn(true);
    if (stations.length === 0) await loadGenre(genre);
  }, [musicOn, stations.length, genre, loadGenre, poke]);

  const selectGenre = useCallback(
    (tag: string) => {
      poke();
      if (tag === genre) return;
      setGenre(tag);
      if (musicOn) void loadGenre(tag);
    },
    [genre, musicOn, loadGenre, poke],
  );

  const nextStation = useCallback(() => {
    poke();
    setStIdx((n) => (stations.length ? (n + 1) % stations.length : 0));
  }, [stations.length, poke]);

  // drive the <audio> element from music state / selected station
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (musicOn && stations[stIdx]) {
      if (a.src !== stations[stIdx].url) a.src = stations[stIdx].url;
      void a.play().catch(() => {});
    } else {
      a.pause();
    }
  }, [musicOn, stIdx, stations]);

  // music starts on: fetch the default genre's stations as the player opens
  useEffect(() => {
    if (musicOnRef.current) void loadGenre(DEFAULT_GENRE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // stop music when the player closes
  useEffect(() => () => audioRef.current?.pause(), []);
  // cancel a pending fade kick-off when the player closes
  useEffect(() => () => window.cancelAnimationFrame(fadeRaf.current), []);

  // show the overlay briefly at start; afterwards it appears only on interaction
  // (key / pointer), never on an automatic photo change
  useEffect(() => {
    poke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // own key listener (the shell's remote handler is disabled while we're up)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const code = e.keyCode;
      poke();
      const dir = dirFromKey(code);

      // options bar has focus. Two rows: the bottom button row, and the genre
      // popover ABOVE the music button. Up from the music button climbs into the
      // genres; Down drops back; Down again (from the bottom row) exits the bar.
      if (focusBarRef.current) {
        const active = document.activeElement as HTMLElement | null;
        const inGenres = !!active?.closest('.wp-genres');
        if (inGenres) {
          if (dir === 'left') {
            e.preventDefault();
            focusGenreBtn(-1);
          } else if (dir === 'right') {
            e.preventDefault();
            focusGenreBtn(1);
          } else if (dir === 'down' || isBack(code)) {
            e.preventDefault();
            focusMusicBtn();
          } else if (code === Key.Enter) {
            e.preventDefault();
            active?.click();
          }
          return;
        }
        if (dir === 'left') {
          e.preventDefault();
          focusBarBtn(-1);
        } else if (dir === 'right') {
          e.preventDefault();
          focusBarBtn(1);
        } else if (dir === 'up') {
          // on any music control (toggle or next-station) with the genre popover
          // open: climb into it
          e.preventDefault();
          if (active?.closest('.wp-music') && genreBtns().length) focusGenreBtn(1);
        } else if (dir === 'down' || isBack(code)) {
          e.preventDefault();
          leaveBar();
        } else if (code === Key.Enter) {
          e.preventDefault();
          active?.click();
        }
        return;
      }

      if (isBack(code)) {
        e.preventDefault();
        onExit();
        return;
      }
      if (dir === 'up') {
        e.preventDefault();
        enterBar(); // raise + focus the options bar
      } else if (dir === 'left') {
        e.preventDefault();
        advance(-1, true); // follows through once the previous frame loads
      } else if (dir === 'right') {
        e.preventDefault();
        advance(1, true); // follows through once the next frame loads
      } else if (code === Key.Enter || code === Key.PlayPause) {
        e.preventDefault();
        setPaused((p) => {
          const next = !p;
          flashPill(next ? 'paused' : 'playing');
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, onExit, poke, flashPill, enterBar, leaveBar, focusBarBtn, focusGenreBtn, focusMusicBtn]);

  if (!asset) return null;

  const cur = cache.current.get(i);
  // spinner: current video still decoding, or a manual d-pad nav waiting on its
  // target frame to load (the press is acknowledged, not dropped)
  const buffering = (!!asset.isVideo && !(cur?.decoded)) || navPending;
  // key on the caption CONTENT so it only re-animates when the text changes
  // (consecutive shots from the same place/day won't re-trigger the animation)
  const metaKey = `${meta.loc ?? ''}|${meta.date}`;

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
      if (on && !pausedRef.current) playEl(f.el);
      else f.el.pause();
    }
  };

  // Portal to <body>: rendered inside the shell's .view-enter, whose lingering
  // transform (animation ... both) would otherwise trap position:fixed inside
  // the content box, leaving the sidebar visible instead of a true fullscreen.
  return createPortal(
    <div class={'wp-player ' + (overlay ? 'show-ui' : '')} onMouseMove={poke}>
      {/* off-screen full-screen stage: stills are laid out + rastered here at
          display size before they're shown, then reparented into a frame layer */}
      <div class="wp-stage" ref={stageRef} />
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
                  ? { opacity: 0, zIndex: 2, transition: 'opacity 0.9s ease' }
                  : { opacity: 1, zIndex: 2, transition: 'none' }
            }
            ref={(node) => mountLayer(node, f, on)}
          />
        );
      })}

      {buffering && (
        <div class="wp-player-spin">
          <div class="fs-spinner" />
        </div>
      )}

      {/* bottom-left caption, animates in fresh for each wallpaper (keyed by id) */}
      {meta.date && (
        <div class="wp-player-meta" key={metaKey}>
          {meta.loc && <div class="wp-player-loc">{meta.loc}</div>}
          {meta.date && <div class="wp-player-date">{meta.date}</div>}
        </div>
      )}

      <div class="wp-player-ui">
        <div class={'wp-player-top' + (focusBar ? ' bar-focus' : '')} ref={barRef}>
          {pill !== 'none' && (
            <span class="wp-player-pill">
              <Icon name={pill === 'paused' ? 'pause' : 'play'} size={22} />
              {pill === 'paused' ? 'Paused' : 'Playing'}
            </span>
          )}
          {mode === 'photos' && <div
            class="wp-music"
            onFocus={() => setMusicFocus(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMusicFocus(false);
            }}
          >
            {musicOn && musicFocus && (
              <div class="wp-genres wp-speed">
                {GENRES.map((g) => (
                  <button
                    key={g.tag}
                    class={'wp-speed-btn' + (g.tag === genre ? ' active' : '')}
                    onClick={() => selectGenre(g.tag)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            )}
            {musicOn && stations[stIdx] && (
              <span class="wp-music-name">{stations[stIdx].name}</span>
            )}
            {musicOn && stations.length > 1 && (
              <button class="wp-icon-btn" onClick={nextStation} title="Next station">
                <Icon name="skipNext" size={22} />
              </button>
            )}
            <button
              class={'wp-icon-btn' + (musicOn ? ' active' : '')}
              onClick={toggleMusic}
              title="Background music"
            >
              <Icon name="music" size={22} />
            </button>
          </div>}
          {mode === 'photos' && (
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
          )}
          <button
            class={'wp-icon-btn' + (mode === 'videos' ? ' wp-shuffle' : '') + (shuffle ? ' active' : '')}
            onClick={() => { toggleShuffle(); poke(); }}
            title="Shuffle"
          >
            <Icon name="shuffle" size={22} />
          </button>
        </div>
        {mode === 'photos' && <audio
          ref={audioRef}
          onError={nextStation}
          // a muted video can still steal audio focus on webOS and pause the
          // stream — resume it if music is meant to be on
          onPause={() => {
            if (musicOnRef.current) {
              window.setTimeout(() => {
                if (musicOnRef.current) void audioRef.current?.play().catch(() => {});
              }, 400);
            }
          }}
        />}
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

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
