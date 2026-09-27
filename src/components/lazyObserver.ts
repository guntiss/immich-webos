// Shared IntersectionObserver pools. Previously every Thumb and BucketSection
// created its own IntersectionObserver; with a few screens of grid that's
// hundreds of live observers, each recomputing intersections on scroll — a
// real source of scroll jank on the TV's browser. Instead we keep ONE observer
// per rootMargin and route callbacks through a WeakMap keyed by element.

// cb receives whether the element is currently inside the (margin-expanded)
// root; callers act on `inside === true` (load the thumb / the bucket).
type Cb = (inside: boolean) => void;

interface Pool {
  observe(el: Element, cb: Cb): void;
  unobserve(el: Element): void;
  setRoot(root: Element | null): void;
}

// Every pool, so setLazyRoot can retarget them all at once.
const pools: Pool[] = [];

function makeObserver(rootMargin: string): Pool {
  // Strong Map (not WeakMap) so setRoot can re-observe the live set after
  // rebuilding the IO on a root change. Callers always unobserve on unmount /
  // after load, so entries don't leak.
  const cbs = new Map<Element, Cb>();
  let io: IntersectionObserver | null = null;
  let root: Element | null = null;

  const handler: IntersectionObserverCallback = (entries) => {
    for (const e of entries) {
      const cb = cbs.get(e.target);
      if (cb) cb(e.isIntersecting);
    }
  };
  const build = () => new IntersectionObserver(handler, { root, rootMargin });

  const pool: Pool = {
    observe(el, cb) {
      cbs.set(el, cb);
      if (!io) io = build();
      io.observe(el);
    },
    unobserve(el) {
      cbs.delete(el);
      io?.unobserve(el);
    },
    // Rebuild against a new root and re-observe everything currently tracked.
    // rootMargin only extends the ROOT box; an intermediate scroll container
    // still clips the intersection, so with the implicit viewport root a thumb
    // below the grid's scroller is clipped out and only loads once it touches
    // the viewport. Pointing root at the scroller makes the margin apply.
    setRoot(r) {
      if (r === root) return;
      root = r;
      if (!io) return;
      io.disconnect();
      io = build();
      for (const el of cbs.keys()) io.observe(el);
    },
  };
  pools.push(pool);
  return pool;
}

// Point the lazy observers at the actual scroll container (the grid's scroller).
// Called by the grid on mount; reset to null (viewport) on unmount.
export function setLazyRoot(root: Element | null): void {
  for (const p of pools) p.setRoot(root);
}

// setLazyRoot as a ref callback for a scroll container, so the root follows
// the element itself as it mounts and unmounts. Stable, so it runs only then.
export const lazyRootRef = (el: Element | null): void => setLazyRoot(el);

// Prefetch window, sized in viewport heights ("pages") so it tracks the screen.
// We keep roughly four pages above AND below the viewport loaded so scrolling
// back and forth never waits on a refetch (the thumbnails stay mounted and in
// the media LRU cache). rootMargin expands the root box in every direction, so
// `4 pages` means thumbnails within ~4 pages of the viewport in either
// direction start loading. Two left a fast d-pad scroll showing grey cells.
const PAGE = (typeof window !== 'undefined' && window.innerHeight) || 720;

// ~4 pages: fetch a thumbnail well before it scrolls into view.
export const thumbObserver = makeObserver(`${PAGE * 4}px`);
// A bit further out than the thumbnails, so a bucket's assets have loaded by
// the time its thumbnails enter the prefetch window (thumbs can't exist until
// their bucket's asset list arrives).
export const bucketObserver = makeObserver(`${PAGE * 4 + 300}px`);
