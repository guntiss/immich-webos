import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { memo } from 'preact/compat';
import { TimeBucket, BucketColumns, describeError } from '../api/client';
import { Asset, flattenBucket } from '../api/assets';
import { Thumb } from './Thumb';
import { bucketObserver, setLazyRoot } from './lazyObserver';
import { justify, targetRowHeight, GRID_GAP as GAP } from './justified';
import { reportError } from './ErrorBoundary';
import { EmptyState } from './EmptyState';
import { TimelineScrubber } from './TimelineScrubber';

const DAY_SEP = 5; // px gap inserted between day-groups on a shared row
const LABEL_GAP = 24; // min px between one day label's end and the next one's start

// Where an asset sits in the whole grid (1-based) and how many items the grid
// holds, for the viewer's "12 / 340"; null when it isn't in the grid.
export type PlaceOf = (id: string) => { n: number; total: number } | null;

interface Props {
  // loaders injected so the same grid serves timeline / albums / favorites
  loadBuckets: () => Promise<TimeBucket[]>;
  loadBucket: (timeBucket: string) => Promise<BucketColumns>;
  onOpen: (assets: Asset[], index: number, placeOf?: PlaceOf) => void;
  // ref filled with a function that loads the next unloaded bucket; caller invokes it to prefetch
  loadNextUnloaded?: { current: (() => void) | null };
  // called whenever the flat asset list grows (new bucket loaded)
  onAssetsChange?: (assets: Asset[]) => void;
  // shown (centered, with the broken logo) when the bucket list loads empty
  emptyLabel?: string;
  emptyHint?: string;
  // only the assets this keeps (the Photos view's photos/videos filter); the
  // grid shows emptyLabel once every bucket has loaded with none kept
  keep?: (a: Asset) => boolean;
}

// Date-bucketed, justified-row photo grid (Immich timeline look). Buckets load
// lazily as their header nears the viewport; loaded assets are concatenated so
// fullscreen left/right traverses everything loaded.
//
// Perf: every prop handed to BucketSection is kept referentially stable (refs +
// stable useCallbacks), and BucketSection is memo()'d. So loading the Nth bucket
// re-renders ONLY that section — not all N previously loaded sections. Without
// this the grid did O(N) justify()+vnode work on every bucket load, which is
// why the UI degraded the longer you scrolled.
// memo: a parent (Home) re-render — e.g. toggling the sidebar — must not
// reconcile this whole grid. All props are stable (Home useCallback's the
// loaders; literals for the rest), so a re-render with the same view is a
// no-op here instead of an 800ms+ diff of every thumbnail vnode.
export const PhotoGrid = memo(function PhotoGrid({ loadBuckets, loadBucket, onOpen, loadNextUnloaded, onAssetsChange, emptyLabel, emptyHint, keep }: Props) {
  const [buckets, setBuckets] = useState<TimeBucket[]>([]);
  const [fetched, setFetched] = useState(false); // bucket list resolved (may be empty)
  const [loaded, setLoaded] = useState<Record<string, Asset[]>>({});
  const [error, setError] = useState('');
  const [width, setWidth] = useState(window.innerWidth - 96 - 32);
  const [rowH, setRowH] = useState(targetRowHeight());
  const loadingRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Refs mirror the latest state so the stable callbacks below can read current
  // values without being recreated (which would defeat the memo on sections).
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onAssetsChangeRef = useRef(onAssetsChange);
  onAssetsChangeRef.current = onAssetsChange;
  const flatRef = useRef<Asset[]>([]);
  const offsetRef = useRef<Record<string, number>>({});

  // keep loadNextUnloaded.current pointed at a fresh closure so callers always
  // get the next truly-unloaded bucket regardless of when they invoke it
  const bucketsRef = useRef(buckets);
  bucketsRef.current = buckets;
  if (loadNextUnloaded) {
    loadNextUnloaded.current = () => {
      const next = bucketsRef.current.find(
        (b) => !loadedRef.current[b.timeBucket] && !loadingRef.current.has(b.timeBucket),
      );
      if (next) ensureBucket(next.timeBucket);
    };
  }

  useEffect(() => {
    setFetched(false);
    loadBuckets()
      .then(setBuckets)
      .catch((e) => setError(e?.message || 'Failed to load timeline'))
      .finally(() => setFetched(true));
  }, [loadBuckets]);

  useEffect(() => {
    const onResize = () => {
      if (scrollRef.current) setWidth(scrollRef.current.clientWidth - 32);
      setRowH(targetRowHeight());
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Point the shared lazy observers at THIS grid's scroll container, without
  // which rootMargin is clipped by .grid-scroll and the 2-page prefetch never
  // triggers ahead of the viewport. A ref, not a mount effect: the scroller only
  // renders once the bucket list is in ("Loading…" stands in before that).
  const setScroller = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setLazyRoot(el);
  }, []);

  // notify caller whenever the flat asset list grows so it can update live views
  useEffect(() => {
    onAssetsChangeRef.current?.(flatRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Stable: reads `loaded` via ref, so it never changes identity. Passed to
  // every section as-is.
  const ensureBucket = useCallback(
    (tb: string) => {
      if (loadedRef.current[tb] || loadingRef.current.has(tb)) return;
      loadingRef.current.add(tb);
      loadBucket(tb)
        .then((cols) => {
          const assets = flattenBucket(cols);
          setLoaded((m) => ({ ...m, [tb]: keep ? assets.filter(keep) : assets }));
        })
        .catch((e) => reportError(new Error(`Failed to load bucket ${tb}: ${describeError(e)}`)))
        .finally(() => loadingRef.current.delete(tb));
    },
    [loadBucket, keep],
  );

  // Stable: counts the buckets not loaded yet by their size, so the number is
  // the asset's place in the whole timeline/album, not just in what's loaded.
  const placeOf = useCallback<PlaceOf>((id) => {
    let n = 0;
    let total = 0;
    for (const b of bucketsRef.current) {
      const arr = loadedRef.current[b.timeBucket];
      if (!n && arr) {
        const k = arr.findIndex((a) => a.id === id);
        if (k >= 0) n = total + k + 1;
      }
      total += arr ? arr.length : b.count;
    }
    return n ? { n, total } : null;
  }, []);

  // Stable: resolves the bucket-local index to a global one against the latest
  // flat list (read from refs) at click time.
  const handleOpen = useCallback((tb: string, localIdx: number) => {
    onOpenRef.current(flatRef.current, (offsetRef.current[tb] ?? 0) + localIdx, placeOf);
  }, []);

  // flat list of everything loaded, for fullscreen traversal. Stored in refs so
  // the stable handleOpen sees current values; only array refs are copied here,
  // no vnode work, so this stays cheap.
  const flat: Asset[] = [];
  const offsetOf: Record<string, number> = {};
  for (const b of buckets) {
    offsetOf[b.timeBucket] = flat.length;
    const arr = loaded[b.timeBucket];
    if (arr) for (const a of arr) flat.push(a);
  }
  flatRef.current = flat;
  offsetRef.current = offsetOf;

  // filtered down to nothing, once every bucket has had its say
  if (keep && buckets.length && !flat.length && buckets.every((b) => loaded[b.timeBucket])) {
    return <EmptyState title={emptyLabel ?? 'Nothing here yet'} hint={emptyHint} />;
  }

  if (error) return <div class="msg error">{error}</div>;
  if (!buckets.length) {
    return fetched ? (
      <EmptyState title={emptyLabel ?? 'Nothing here yet'} hint={emptyHint} />
    ) : (
      <div class="msg">Loading…</div>
    );
  }

  return (
    <div class="grid-wrap">
      <div
        class="grid-scroll"
        ref={setScroller}
        // Clicking empty space (gaps, padding, bucket titles) would otherwise
        // move focus to <body> and drop the focus ring off the current thumbnail.
        // Suppressing focus shift on mousedown for non-focusable targets keeps the
        // last thumbnail focused; clicks that land on a thumb still focus/open it.
        onMouseDown={(e) => {
          if (!(e.target as HTMLElement).closest('[data-focusable]')) e.preventDefault();
        }}
      >
        {buckets.map((b) => (
          <BucketSection
            key={b.timeBucket}
            bucket={b}
            assets={loaded[b.timeBucket]}
            width={width}
            rowH={rowH}
            ensureBucket={ensureBucket}
            onOpen={handleOpen}
          />
        ))}
      </div>
      <TimelineScrubber buckets={buckets} scrollRef={scrollRef} />
    </div>
  );
});

const BucketSection = memo(function BucketSection({
  bucket,
  assets,
  width,
  rowH,
  ensureBucket,
  onOpen,
}: {
  bucket: TimeBucket;
  assets?: Asset[];
  width: number;
  rowH: number;
  ensureBucket: (tb: string) => void;
  onOpen: (tb: string, localIdx: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tb = bucket.timeBucket;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    bucketObserver.observe(el, (inside) => {
      if (inside) ensureBucket(tb);
    });
    return () => bucketObserver.unobserve(el);
  }, [tb, ensureBucket]);

  // Pack consecutive day-groups into shared rows when they fit. A shared row
  // never fills the width, so justify() leaves it at rowH: lay each day out at
  // that height (gaps and separators included). A day narrower than its label
  // (one portrait video) widens the separator after it so the next day starts
  // LABEL_GAP past the label. A day joins the row only if
  //   1. the whole row, separators included, still fits the width
  //   2. this day's label ends inside the row
  const days = assets ? groupByDay(assets) : [];
  const units: Unit[] = [];
  let cur: Unit | null = null;
  let curW = 0; // px from cur's left edge to where its next item would start
  let lastLeft = 0; // left edge of the latest day label in cur
  let lastText = '';
  for (const day of days) {
    const dayW = day.assets.reduce((s, a) => s + (a.ratio > 0 ? a.ratio : 1) * rowH + GAP, 0);
    const text = formatDay(day.key);
    const pad = Math.max(0, lastLeft + labelWidth(lastText) + LABEL_GAP - (curW + DAY_SEP + GAP));
    const left = curW + DAY_SEP + GAP + pad;
    if (cur && left + dayW - GAP <= width && left + labelWidth(text) <= width) {
      cur.assets.push(...day.assets);
      cur.seps[day.key] = DAY_SEP + pad;
      curW = left + dayW;
      lastLeft = left;
    } else {
      cur = { assets: day.assets.slice(), seps: {} };
      units.push(cur);
      curW = dayW;
      lastLeft = 0;
    }
    lastText = text;
  }

  let bucketIdx = 0;

  return (
    <section ref={ref} class="bucket" data-bucket={tb}>
      {assets ? (
        units.map(({ assets: unitAssets, seps }, ui) => {
          let effWidth = width;
          for (const k in seps) effWidth -= seps[k] + GAP;
          const rows = justify(unitAssets, effWidth, rowH, GAP);
          let rowOffset = 0;
          let prevDk: string | undefined; // persists across rows — no duplicate labels
          const rowEls = rows.map((row, ri) => {
            const labels: Array<{ left: number; text: string }> = [];
            const rowChildren: preact.ComponentChildren[] = [];
            let cumX = 0;
            row.items.forEach((a, j) => {
              const dk = dayKey(a.createdAt);
              const isNewDay = dk !== prevDk;
              if (isNewDay && j > 0) {
                const sep = seps[dk] ?? DAY_SEP;
                rowChildren.push(<div class="day-sep" key={`sep${j}`} style={{ flexBasis: `${sep}px` }} />);
                cumX += sep + GAP;
              }
              if (isNewDay) {
                labels.push({ left: cumX, text: formatDay(dk) });
                prevDk = dk;
              }
              const myIdx = bucketIdx + rowOffset + j;
              rowChildren.push(
                <Thumb
                  key={a.id}
                  assetId={a.id}
                  thumbhash={a.thumbhash}
                  isVideo={a.isVideo}
                  duration={a.duration}
                  isLive={!!a.livePhotoVideoId}
                  width={a.w}
                  height={a.h}
                  onSelect={() => onOpen(tb, myIdx)}
                />,
              );
              cumX += a.w + GAP;
            });
            rowOffset += row.items.length;
            return (
              <div class="jrow-wrap" key={`${ui}-${ri}`}>
                {labels.length > 0 && (
                  <div class="jrow-header">
                    {labels.map((l) => (
                      <span class="day-label" style={{ left: `${l.left}px` }} key={l.text}>
                        {l.text}
                      </span>
                    ))}
                  </div>
                )}
                <div class="jrow" style={{ height: `${row.height}px` }}>{rowChildren}</div>
              </div>
            );
          });
          bucketIdx += unitAssets.length;
          return rowEls;
        })
      ) : (
        <>
          <h2 class="bucket-title">{formatBucket(tb)}</h2>
          {/* placeholder block sized from the known count so scroll height is
              stable. Estimate columns from the current row height (~square-ish
              cells) so the reserved height roughly matches the real layout. */}
          <div
            class="bucket-ph"
            style={{
              height: `${Math.ceil(Math.min(bucket.count, 60) / Math.max(3, Math.round(width / (rowH * 1.2)))) * (rowH + GAP)}px`,
            }}
          />
        </>
      )}
    </section>
  );
});

// Days that share one row (or a single day, which may span several).
interface Unit {
  assets: Asset[];
  seps: Record<string, number>; // day key -> px of the separator before it
}

interface DayGroup {
  key: string; // YYYY-MM-DD
  base: number; // index of this group's first asset within the bucket
  assets: Asset[];
}

// Split a date-sorted bucket into consecutive same-calendar-day runs. `base`
// preserves each group's offset within the bucket so onOpen still maps to the
// correct flat index. Local calendar day (not UTC) so headers match the wall
// date the photo shows.
function groupByDay(assets: Asset[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let cur: DayGroup | null = null;
  for (let i = 0; i < assets.length; i++) {
    const key = dayKey(assets[i].createdAt);
    if (!cur || cur.key !== key) {
      cur = { key, base: i, assets: [] };
      groups.push(cur);
    }
    cur.assets.push(assets[i]);
  }
  return groups;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || 'unknown';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function formatDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return key;
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// Rendered width of a day label in .day-label's font. Measured, not guessed:
// "Wed, September 30, 2026" alone is 241px, and other locales run longer.
// Before Inter loads the fallback measures ~13px short; LABEL_GAP covers that.
let labelCtx: CanvasRenderingContext2D | null = null;
function labelWidth(text: string): number {
  if (!labelCtx) labelCtx = document.createElement('canvas').getContext('2d');
  if (!labelCtx) return text.length * 11;
  labelCtx.font = "600 19px Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif";
  return labelCtx.measureText(text).width;
}

function formatBucket(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}
