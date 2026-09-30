// A clip loaded ahead of being opened: the video thumbnail under the grid's
// focus starts fetching its first frame, so the viewer finds it decoded and
// plays it at once (see loadFresh in WallpaperPlayer). One clip at most, on the
// same terms as the viewer's own lookahead: a detached element with
// preload=metadata, which on webOS already decodes its first frame and leaves
// the background music playing. Not the clip a press is about to step onto
// (the viewer readies those itself).
import { originalStreamUrl, videoStreamUrl } from './client';
import { getVideoQuality, VideoQuality } from '../settings';

const DWELL_MS = 200; // focus rests this long before a clip is fetched: scrolling past starts nothing
const KEEP_MS = 3000; // focus left, nothing opened it: the clip is dropped after this

let warm: { id: string; q: VideoQuality; el: HTMLVideoElement } | null = null;
let dwell = 0;
let keep = 0;

// stop fetching and release the element, as the viewer's teardown does
function free(el: HTMLVideoElement): void {
  el.pause();
  el.removeAttribute('src');
  el.load();
  el.remove();
}

function drop(): void {
  window.clearTimeout(keep);
  if (!warm) return;
  const { el } = warm;
  warm = null;
  free(el);
}

// a video thumbnail took the focus
export function focusClip(id: string): void {
  window.clearTimeout(dwell);
  window.clearTimeout(keep);
  if (warm?.id === id && warm.q === getVideoQuality()) return;
  dwell = window.setTimeout(() => {
    drop();
    const q = getVideoQuality();
    const el = document.createElement('video');
    el.src = q === 'original' ? originalStreamUrl(id) : videoStreamUrl(id);
    el.preload = 'metadata';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.load();
    warm = { id, q, el };
  }, DWELL_MS);
}

// the focus left a video thumbnail (on another thumbnail, the viewer is
// about to take the clip: see takeWarmClip)
export function blurClip(): void {
  window.clearTimeout(dwell);
  window.clearTimeout(keep);
  keep = window.setTimeout(drop, KEEP_MS);
}

// The viewer's claim on a clip: its element, loading or loaded, if it's the
// one asked for in the quality asked for. Null otherwise (and an element that
// failed is let go, for the viewer to load afresh).
export function takeWarmClip(id: string, q: VideoQuality): HTMLVideoElement | null {
  window.clearTimeout(dwell); // focused a moment ago: no use fetching it twice
  if (!warm || warm.id !== id || warm.q !== q) return null;
  window.clearTimeout(keep);
  const { el } = warm;
  warm = null;
  if (el.error) {
    free(el);
    return null;
  }
  return el;
}
