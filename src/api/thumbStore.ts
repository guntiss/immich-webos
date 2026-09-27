// On-disk thumbnail store, so the grid's thumbnails survive an app restart.
//
// The browser's HTTP cache doesn't do this for us. Immich sends thumbnails
// with max-age=86400, yet on the TV the same thumbnail fetched twice in a row
// went to the network both times (fromDiskCache false): the app runs from a
// file:// origin and Chromium doesn't keep its cross-origin fetches. So every
// launch refetched the whole grid, grey cells first. Cache Storage does work
// there (webOS 24: Chrome 120, file:// counts as a secure context, ~150MB
// quota), so the thumbnail bytes are kept in it, keyed by their URL.
//
// Every call is best-effort: where Cache Storage is missing or failing (older
// webOS, a full disk) reads report a miss and writes are dropped, so the
// caller just falls back to the network.

const NAME = 'thumbs-v1';

// A cached entry remembers the asset's thumbhash, which Immich changes when it
// regenerates the thumbnail (an edit or rotation). A caller that knows the
// current thumbhash only accepts an entry with the same one, so a stale
// thumbnail is refetched instead of being shown forever.
const VERSION_HEADER = 'x-thumbhash';

// ~18KB per thumbnail, so ~70MB: under half the quota, leaving room for the
// rest of the origin's storage.
const MAX_ENTRIES = 4000;
// Trim a little below the cap, so the next trim isn't due after a single write.
const TRIM_TO = MAX_ENTRIES - 200;
// Check the size once per this many writes. The first check is deferred past
// startup (see storeThumb), so a session that writes only a few still trims
// what earlier sessions left.
const TRIM_EVERY = 200;

let opened: Promise<Cache | null> | null = null;

function open(): Promise<Cache | null> {
  if (!opened) {
    opened =
      typeof caches === 'undefined' ? Promise.resolve(null) : caches.open(NAME).catch(() => null);
  }
  return opened;
}

// The stored bytes, or null on a miss, on a thumbhash mismatch, or when the
// store is unavailable.
export function readThumb(url: string, version?: string | null): Promise<Blob | null> {
  return open()
    .then((c) => (c ? c.match(url) : undefined))
    .then((r) => {
      if (!r) return null;
      if (version && r.headers.get(VERSION_HEADER) !== version) return null;
      return r.blob();
    })
    .catch(() => null);
}

let writes = 0;

// Fire-and-forget: a failed write only means a refetch next launch.
export function storeThumb(url: string, blob: Blob, version?: string | null): void {
  open()
    .then((c) => {
      if (!c) return;
      const headers: Record<string, string> = {};
      if (blob.type) headers['content-type'] = blob.type;
      if (version) headers[VERSION_HEADER] = version;
      return c.put(url, new Response(blob, { headers })).then(() => {
        writes++;
        // Out of the way of the startup burst of reads and writes.
        if (writes === 1) setTimeout(trim, 15000);
        else if (writes % TRIM_EVERY === 0) trim();
      });
    })
    // Most likely over quota: make room for the next ones.
    .catch(trim);
}

let trimming = false;

// Drop the oldest entries beyond the cap. keys() lists entries in the order
// they were written (a rewrite moves one to the end; a read doesn't), so this
// evicts first-in-first-out.
function trim(): void {
  if (trimming) return;
  trimming = true;
  const done = () => {
    trimming = false;
  };
  open()
    .then(async (c) => {
      if (!c) return;
      const keys = await c.keys();
      if (keys.length <= MAX_ENTRIES) return;
      // One at a time: no hurry, and it keeps the disk free for thumbnail reads.
      for (const k of keys.slice(0, keys.length - TRIM_TO)) await c.delete(k);
    })
    .then(done, done);
}

// On sign-out: the next account shouldn't find this one's photos on disk.
export function clearStoredThumbs(): Promise<void> {
  opened = null;
  if (typeof caches === 'undefined') return Promise.resolve();
  return caches.delete(NAME).then(
    () => undefined,
    () => undefined,
  );
}
