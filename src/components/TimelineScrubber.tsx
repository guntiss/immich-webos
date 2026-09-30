import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { TimeBucket } from '../api/client';

interface Props {
  buckets: TimeBucket[];
  scrollRef: { current: HTMLDivElement | null };
}

// Right-edge scroll timeline: a thin rail spanning the grid's full scroll
// range, with a thumb sized/positioned to the viewport's share of it (like a
// native scrollbar) plus year labels at the buckets where the year changes.
// Click or drag it (magic-remote pointer or mouse) to jump straight to a
// point in the timeline instead of flicking through months of scroll — a
// floating month/year pill follows the pointer while dragging.
//
// Position math uses each bucket's `count` (not loaded assets) so the rail is
// stable before/after buckets load — only the row height (bucket heights vary
// with aspect ratios) is approximated by weighting each bucket by its asset
// count, which is close enough for a jump-to-region control.
export function TimelineScrubber({ buckets, scrollRef }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [thumb, setThumb] = useState({ top: 0, height: 0 });
  const [label, setLabel] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  const total = buckets.reduce((s, b) => s + b.count, 0) || 1;

  // Year markers: label the first bucket of each calendar year (skip if only
  // one year total — nothing to distinguish).
  const years: Array<{ frac: number; text: string }> = [];
  {
    let seen = 0;
    let lastYear = '';
    for (const b of buckets) {
      const y = String(new Date(b.timeBucket).getFullYear());
      if (y !== lastYear) {
        years.push({ frac: seen / total, text: y });
        lastYear = y;
      }
      seen += b.count;
    }
  }

  // Recompute the thumb from the grid's actual scroll metrics — the source of
  // truth for "where am I", independent of the count-based fraction used for
  // dragging (real row heights vary, so scrollTop/scrollHeight is exact).
  const syncThumb = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const range = el.scrollHeight - el.clientHeight;
    const frac = range > 0 ? el.scrollTop / range : 0;
    const heightFrac = Math.min(1, el.clientHeight / el.scrollHeight || 1);
    setThumb({ top: frac * (1 - heightFrac) * 100, height: heightFrac * 100 });
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    syncThumb();
    el.addEventListener('scroll', syncThumb, { passive: true });
    const ro = new ResizeObserver(syncThumb);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', syncThumb);
      ro.disconnect();
    };
  }, [syncThumb, buckets]);

  // Label for wherever a given rail fraction (0..1) lands: the bucket whose
  // share of `total` contains that point.
  const bucketAtFrac = (frac: number): TimeBucket | null => {
    const target = frac * total;
    let seen = 0;
    for (const b of buckets) {
      seen += b.count;
      if (target <= seen) return b;
    }
    return buckets[buckets.length - 1] ?? null;
  };

  const formatLabel = (b: TimeBucket) =>
    new Date(b.timeBucket).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

  const scrubToClientY = useCallback(
    (clientY: number) => {
      const rail = railRef.current;
      const grid = scrollRef.current;
      if (!rail || !grid) return;
      const rect = rail.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const b = bucketAtFrac(frac);
      if (!b) return;
      setLabel(formatLabel(b));
      const target = grid.querySelector<HTMLElement>(`[data-bucket="${b.timeBucket}"]`);
      if (target) {
        grid.scrollTop = target.offsetTop;
      } else {
        // bucket not rendered (shouldn't happen — all buckets render a
        // section, loaded or placeholder) — fall back to the raw fraction
        const range = grid.scrollHeight - grid.clientHeight;
        grid.scrollTop = frac * range;
      }
    },
    [scrollRef, buckets, total],
  );

  const onDown = useCallback(
    (e: PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      setActive(true);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      scrubToClientY(e.clientY);
    },
    [scrubToClientY],
  );
  const onMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      scrubToClientY(e.clientY);
    },
    [scrubToClientY],
  );
  const onUp = useCallback((e: PointerEvent) => {
    draggingRef.current = false;
    setActive(false);
    setLabel(null);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  if (buckets.length < 2) return null;

  return (
    <div
      ref={railRef}
      class={'timeline-scrubber' + (active ? ' active' : '')}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div class="ts-track">
        {years.map((y) => (
          <span class="ts-year" style={{ top: `${y.frac * 100}%` }} key={y.text}>
            {y.text}
          </span>
        ))}
        <div class="ts-thumb" style={{ top: `${thumb.top}%`, height: `${Math.max(thumb.height, 4)}%` }} />
      </div>
      {label && <div class="ts-label" style={{ top: `${thumb.top}%` }}>{label}</div>}
    </div>
  );
}
