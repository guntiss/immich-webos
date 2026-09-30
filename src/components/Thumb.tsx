import { useEffect, useState, useRef } from 'preact/hooks';
import { loadThumb } from '../api/media';
import { thumbObserver } from './lazyObserver';
import { Icon } from './Icon';

interface Props {
  assetId: string;
  // Lets the loader tell a thumbnail kept on disk is out of date.
  thumbhash?: string | null;
  isVideo: boolean;
  duration?: number | string | null;
  isLive?: boolean;
  // Set on a cell in a horizontal row (the Home page) rather than the timeline
  // grid: Left/Right stay inside the row, and its thumbnail loads at once (the
  // row's own scroller would hide it from the grid's lazy-load observer).
  row?: string;
  width: number;
  height: number;
  onSelect: () => void;
}

// Single justified-grid cell sized to explicit width/height (aspect preserved
// by the parent's justified-row math). Lazily fetches its thumbnail blob when
// near the viewport. Marked focusable for remote nav.
export function Thumb({ assetId, thumbhash, isVideo, duration, isLive, row, width, height, onSelect }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [near, setNear] = useState(!!row);

  useEffect(() => {
    const el = ref.current;
    if (!el || row) return;
    // Load once when the cell enters the 2-page window, then stop observing and
    // keep the src for the life of the component. We deliberately do NOT drop it
    // when it scrolls away: a loaded thumb then goes static (no fetch/decode/
    // setState on further scroll), so revisiting is free. Dropping it forced a
    // reload/re-decode on scroll-back — the "thumbnails reloading" churn. RAM is
    // not the constraint here (measured ~10MB heap); the media LRU caps blobs.
    thumbObserver.observe(el, (inside) => {
      if (!inside) return;
      setNear(true);
      thumbObserver.unobserve(el);
    });
    return () => thumbObserver.unobserve(el);
  }, []);

  // Load once near the viewport, retrying a few times with backoff. A thumb
  // fetch can fail transiently (a slot's fetch timed out, wifi hiccup); without
  // a retry the cell would keep its placeholder forever, since the observer has
  // already unobserved it and nothing re-triggers the load. Bounded attempts so
  // a genuinely-missing asset doesn't loop.
  useEffect(() => {
    if (!near) return;
    let alive = true;
    let timer = 0;
    const attempt = (n: number) => {
      loadThumb(assetId, thumbhash)
        .then((url) => alive && setSrc(url))
        .catch(() => {
          if (alive && n < 4) timer = window.setTimeout(() => attempt(n + 1), 1000 * (n + 1));
        });
    };
    attempt(0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [near, assetId, thumbhash]);

  return (
    <button
      ref={ref}
      data-focusable
      data-seq={row ? undefined : true}
      data-row={row}
      data-asset-id={assetId}
      class="thumb focusable"
      style={{ width: `${width}px`, height: `${height}px` }}
      onClick={onSelect}
    >
      {src ? (
        // No loading="lazy": we already gate the fetch via IntersectionObserver
        // (setNear), and native lazy-loading additionally lets the browser drop
        // off-screen images and re-decode them on scroll-back — the placeholder→
        // image flash on already-visited rows. decoding="async" keeps the decode
        // off the scroll frame.
        <img class="thumb-img" src={src} decoding="async" />
      ) : (
        // Neutral grey cell until the thumbnail loads.
        <div class="thumb-ph" />
      )}
      {isVideo && (
        <span class="thumb-badge">
          <Icon name="playCircle" size={24} />
          {formatDuration(duration)}
        </span>
      )}
      {!isVideo && isLive && (
        <span class="thumb-badge live">
          <Icon name="live" size={24} />
        </span>
      )}
    </button>
  );
}

function formatDuration(d?: number | string | null): string {
  if (d == null) return '';
  if (typeof d === 'string' && d.includes(':')) return d.split('.')[0].replace(/^00:/, '');
  // Immich v3 sends duration as integer milliseconds; v2 only ever sent strings.
  const secs = typeof d === 'string' ? parseFloat(d) : d / 1000;
  if (!isFinite(secs)) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
