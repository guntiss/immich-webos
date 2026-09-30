// What to watch: the rows on the Home page, built from whatever the signed-in
// account can see. The TV usually signs in as an account with no library of its
// own, only albums shared with it, so nothing here leans on the timeline or on
// Immich's memories (both are the account's own photos). Everything comes from
// album buckets, plus the account's own library when it has one.
//
// Rows are built independently and handed over as each finishes ("slots", in
// display order), so the page fills in from the top instead of waiting for the
// slowest one.

import {
  Album,
  getAlbums,
  getAlbumBuckets,
  getAlbumBucket,
  getTimelineBuckets,
  getBucket,
} from './client';
import { Asset, flattenBucket } from './assets';
import { gate } from './media';
import { getServer, getToken } from '../auth/store';

export type FeedRow = { id: string; title: string; subtitle?: string } & (
  | { kind: 'albums'; albums: Album[] }
  | { kind: 'photos'; assets: Asset[] }
);

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const RECENT_ALBUMS = 12;
const MORE_ALBUMS = 12;
const ROW_PHOTOS = 30;
const OTD_ROWS = 3; // "N years ago" rows shown
const OTD_SPAN = 3; // days either side of today
const MAX_YEARS_BACK = 40;
const CACHE_MS = 10 * 60 * 1000;
export const SLOT_COUNT = 7; // row builders, see loadSuggestions

// ---- Days -----------------------------------------------------------------
//
// Dates are compared as whole days since the epoch, read straight off the ISO
// string's date part. Immich stamps fileCreatedAt with the photo's local time,
// so parsing it through the TV's timezone would shift midnight shots a day.

const dayNum = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / DAY);

function dayOfIso(iso: string | undefined): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? dayNum(+m[1], +m[2], +m[3]) : NaN;
}

const yearOfDay = (day: number): number => new Date(day * DAY).getUTCFullYear();

const monthKey = (y: number, m: number): string => y + '-' + (m < 10 ? '0' : '') + m;

// Bucket keys come as "2025-07-01", "2025-7-1" or a full ISO stamp depending on
// the server; all reduce to "2025-07".
function monthOfBucket(tb: string): string | null {
  const m = /^(\d{4})-(\d{1,2})/.exec(tb);
  return m ? monthKey(+m[1], +m[2]) : null;
}

// Every "YYYY-MM" the day range touches.
function monthsIn(from: number, to: number): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d++) {
    const dt = new Date(d * DAY);
    const k = monthKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1);
    if (out[out.length - 1] !== k) out.push(k);
  }
  return out;
}

interface Win {
  from: number;
  to: number;
}

// Western Easter Sunday (Meeus/Jones/Butcher).
function easterDay(y: number): number {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayNum(y, month, day);
}

// A holiday is suggested while today is within `lead` days before / `tail` days
// after it; its row holds the photos taken on that holiday in earlier years.
interface Holiday {
  id: string;
  title: string;
  win: (year: number) => Win;
  lead: number;
  tail: number;
}

const HOLIDAYS: Holiday[] = [
  { id: 'christmas', title: 'Christmas', win: (y) => ({ from: dayNum(y, 12, 23), to: dayNum(y, 12, 26) }), lead: 28, tail: 12 },
  { id: 'newyear', title: 'New Year', win: (y) => ({ from: dayNum(y, 12, 30), to: dayNum(y + 1, 1, 2) }), lead: 6, tail: 12 },
  { id: 'easter', title: 'Easter', win: (y) => ({ from: easterDay(y) - 2, to: easterDay(y) + 1 }), lead: 21, tail: 7 },
  { id: 'jani', title: 'Jāņi', win: (y) => ({ from: dayNum(y, 6, 22), to: dayNum(y, 6, 24) }), lead: 21, tail: 14 },
];

// ---- Sources --------------------------------------------------------------
//
// A source is anything that lists month buckets and hands back one month's
// assets: one album, or the account's own library. Lookups are memoized for the
// run, and only these leaf requests go through the gate (gating callers that
// await other gated calls could starve it).

interface Source {
  id: string;
  from: number; // day range its photos are known to fall in (unbounded when unknown)
  to: number;
  albumId: string | null; // null for the account's own library
  buckets: () => Promise<Map<string, string>>; // "2025-07" -> bucket key, newest first
  bucket: (tb: string) => Promise<Asset[]>;
}

interface Ctx {
  now: Date;
  today: number;
  api: <T>(job: () => Promise<T>) => Promise<T>;
  albums: Promise<Album[]>; // non-empty, most recently updated first
  sources: Promise<Source[]>;
  pool: Map<string, Asset>; // every asset seen, for the videos row
}

const recency = (a: Album): string => a.lastModifiedAssetTimestamp || a.updatedAt || a.endDate || '';

function makeSource(
  ctx: Ctx,
  id: string,
  albumId: string | null,
  from: number,
  to: number,
  listBuckets: () => Promise<{ timeBucket: string }[]>,
  loadBucket: (tb: string) => Promise<Parameters<typeof flattenBucket>[0]>,
): Source {
  let months: Promise<Map<string, string>> | null = null;
  const loaded = new Map<string, Promise<Asset[]>>();
  return {
    id,
    from,
    to,
    albumId,
    buckets() {
      if (!months) {
        months = ctx.api(listBuckets).then((list) => {
          const m = new Map<string, string>();
          for (const b of list) {
            const k = monthOfBucket(b.timeBucket);
            if (k && !m.has(k)) m.set(k, b.timeBucket);
          }
          return m;
        });
        months.catch(() => (months = null)); // a failed lookup can be retried
      }
      return months;
    },
    bucket(tb) {
      let p = loaded.get(tb);
      if (!p) {
        p = ctx.api(() => loadBucket(tb)).then((cols) => {
          const assets = flattenBucket(cols);
          for (const a of assets) ctx.pool.set(a.id, a);
          return assets;
        });
        p.catch(() => loaded.delete(tb));
        loaded.set(tb, p);
      }
      return p;
    },
  };
}

function makeCtx(now: Date): Ctx {
  const ctx = {
    now,
    today: dayNum(now.getFullYear(), now.getMonth() + 1, now.getDate()),
    api: gate(4),
    pool: new Map<string, Asset>(),
  } as Ctx;
  ctx.albums = getAlbums().then((list) =>
    list.filter((a) => a.assetCount > 0).sort((x, y) => recency(y).localeCompare(recency(x))),
  );
  ctx.sources = Promise.all([ctx.albums, getTimelineBuckets('desc').catch(() => [])]).then(([albums, own]) => {
    const out: Source[] = albums.map((a) => {
      const from = dayOfIso(a.startDate);
      const to = dayOfIso(a.endDate);
      return makeSource(
        ctx,
        a.id,
        a.id,
        isNaN(from) ? -Infinity : from,
        isNaN(to) ? Infinity : to,
        () => getAlbumBuckets(a.id, 'desc'),
        (tb) => getAlbumBucket(a.id, tb, 'desc'),
      );
    });
    if (own.length) {
      const list = own;
      out.unshift(
        makeSource(ctx, 'library', null, -Infinity, Infinity, () => Promise.resolve(list), (tb) => getBucket(tb, 'desc')),
      );
    }
    return out;
  });
  return ctx;
}

// ---- Helpers --------------------------------------------------------------

function shuffled<T>(list: T[]): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// `n` items spread evenly through the list, keeping their order.
function spread<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)]);
  return out;
}

const byTakenAsc = (a: Asset, b: Asset): number => a.createdAt.localeCompare(b.createdAt);
const byTakenDesc = (a: Asset, b: Asset): number => b.createdAt.localeCompare(a.createdAt);

function unique(assets: Asset[]): Asset[] {
  const seen = new Set<string>();
  return assets.filter((a) => !seen.has(a.id) && !!seen.add(a.id));
}

// Photos taken inside `win(year)` for each year, from every source that could
// hold some. Only the months the window touches are fetched, and only for
// sources whose date range reaches the window.
async function gather(ctx: Ctx, win: (year: number) => Win, years: number[]): Promise<Map<number, Asset[]>> {
  const sources = await ctx.sources;
  const found = new Map<number, Asset[]>();
  await Promise.all(
    sources.map(async (src) => {
      const hits = years.filter((y) => {
        const w = win(y);
        return w.from <= ctx.today && w.to >= src.from && w.from <= src.to;
      });
      if (!hits.length) return;
      const months = await src.buckets();
      await Promise.all(
        hits.map(async (y) => {
          const w = win(y);
          for (const m of monthsIn(w.from, w.to)) {
            const tb = months.get(m);
            if (!tb) continue;
            for (const a of await src.bucket(tb)) {
              const d = dayOfIso(a.createdAt);
              if (d >= w.from && d <= w.to) found.set(y, (found.get(y) || []).concat(a));
            }
          }
        }),
      );
    }),
  );
  found.forEach((list, y) => found.set(y, unique(list).sort(byTakenAsc)));
  return found;
}

// The years worth looking back through: from the oldest photo anything holds.
async function pastYears(ctx: Ctx, through: number): Promise<number[]> {
  const sources = await ctx.sources;
  const now = ctx.now.getFullYear();
  let oldest = now - 10;
  for (const s of sources) if (isFinite(s.from)) oldest = Math.min(oldest, yearOfDay(s.from));
  oldest = Math.max(oldest, now - MAX_YEARS_BACK);
  const out: number[] = [];
  for (let y = through; y >= oldest; y--) out.push(y);
  return out;
}

// The newest photos and videos of a source: its latest months, until there are
// enough photos or three months have been read.
async function newest(src: Source, wantImages: number): Promise<Asset[]> {
  const months = await src.buckets();
  const out: Asset[] = [];
  let read = 0;
  for (const tb of months.values()) {
    if (read++ >= 3) break;
    out.push(...(await src.bucket(tb).catch(() => [] as Asset[])));
    if (out.filter((a) => a.isImage).length >= wantImages) break;
  }
  return out;
}

// ---- Rows -----------------------------------------------------------------

async function recentAlbumsRow(ctx: Ctx): Promise<FeedRow[]> {
  const albums = (await ctx.albums).slice(0, RECENT_ALBUMS);
  return albums.length ? [{ kind: 'albums', id: 'recent', title: 'Recent albums', albums }] : [];
}

async function moreAlbumsRow(ctx: Ctx): Promise<FeedRow[]> {
  const albums = shuffled((await ctx.albums).slice(RECENT_ALBUMS)).slice(0, MORE_ALBUMS);
  return albums.length ? [{ kind: 'albums', id: 'more', title: 'Explore albums', albums }] : [];
}

async function seasonalRows(ctx: Ctx): Promise<FeedRow[]> {
  const year = ctx.now.getFullYear();
  const rows: FeedRow[] = [];
  for (const h of HOLIDAYS) {
    const inSeason = [year - 1, year].some((y) => {
      const w = h.win(y);
      return ctx.today >= w.from - h.lead && ctx.today <= w.to + h.tail;
    });
    if (!inSeason) continue;
    const found = await gather(ctx, h.win, await pastYears(ctx, year));
    const years = Array.from(found.keys())
      .filter((y) => found.get(y)!.length)
      .sort((a, b) => b - a);
    if (!years.length) continue;
    const per = Math.max(6, Math.floor(ROW_PHOTOS / years.length));
    const assets: Asset[] = [];
    for (const y of years) assets.push(...spread(found.get(y)!, per));
    const shown = years.slice(0, 4).join(', ');
    rows.push({
      kind: 'photos',
      id: 'season-' + h.id,
      title: h.title,
      subtitle: 'From ' + shown + (years.length > 4 ? ' and earlier' : ''),
      assets: assets.slice(0, ROW_PHOTOS),
    });
  }
  return rows;
}

async function onThisDayRows(ctx: Ctx): Promise<FeedRow[]> {
  const y0 = ctx.now.getFullYear();
  const m = ctx.now.getMonth() + 1;
  const d = ctx.now.getDate();
  const win = (y: number): Win => ({ from: dayNum(y, m, d) - OTD_SPAN, to: dayNum(y, m, d) + OTD_SPAN });
  const found = await gather(ctx, win, await pastYears(ctx, y0 - 1));
  return Array.from(found.keys())
    .filter((y) => found.get(y)!.length)
    .sort((a, b) => b - a)
    .slice(0, OTD_ROWS)
    .map((y): FeedRow => {
      const n = y0 - y;
      return {
        kind: 'photos',
        id: 'otd-' + y,
        title: n === 1 ? 'A year ago' : n + ' years ago',
        subtitle: 'Around ' + d + ' ' + MONTHS[m - 1] + ' ' + y,
        assets: spread(found.get(y)!, ROW_PHOTOS),
      };
    });
}

// Sources ordered as the albums row is (most recently updated first), the
// account's own library ahead of them.
async function recentSources(ctx: Ctx): Promise<Source[]> {
  const [sources, albums] = await Promise.all([ctx.sources, ctx.albums]);
  const byAlbum = new Map<string, Source>();
  for (const s of sources) if (s.albumId) byAlbum.set(s.albumId, s);
  const out: Source[] = sources.filter((s) => !s.albumId);
  for (const a of albums) {
    const s = byAlbum.get(a.id);
    if (s) out.push(s);
  }
  return out;
}

async function latestRow(ctx: Ctx): Promise<FeedRow[]> {
  const picks = (await recentSources(ctx)).slice(0, 6);
  const lists = await Promise.all(picks.map((s) => newest(s, 12).catch(() => [] as Asset[])));
  const assets = unique(([] as Asset[]).concat(...lists))
    .filter((a) => a.isImage)
    .sort(byTakenDesc)
    .slice(0, ROW_PHOTOS);
  return assets.length ? [{ kind: 'photos', id: 'latest', title: 'Latest photos', assets }] : [];
}

// Runs after the rows above: the videos are picked out of everything they read.
function videosRow(ctx: Ctx): FeedRow[] {
  const assets: Asset[] = [];
  ctx.pool.forEach((a) => a.isVideo && assets.push(a));
  assets.sort(byTakenDesc);
  return assets.length ? [{ kind: 'photos', id: 'videos', title: 'Latest videos', assets: assets.slice(0, 20) }] : [];
}

async function archiveRow(ctx: Ctx): Promise<FeedRow[]> {
  const sources = shuffled(await ctx.sources).slice(0, 5);
  const lists = await Promise.all(
    sources.map(async (s) => {
      const months = Array.from((await s.buckets()).values());
      if (!months.length) return [] as Asset[];
      const assets = await s.bucket(months[Math.floor(Math.random() * months.length)]);
      return shuffled(assets.filter((a) => a.isImage)).slice(0, 8);
    }).map((p) => p.catch(() => [] as Asset[])),
  );
  const assets = shuffled(unique(([] as Asset[]).concat(...lists))).slice(0, ROW_PHOTOS);
  return assets.length
    ? [{ kind: 'photos', id: 'archive', title: 'From the archive', subtitle: 'A random pick every time', assets }]
    : [];
}

// ---- Loading + cache ------------------------------------------------------

// Finished rows are kept for a few minutes so flipping between tabs doesn't
// rebuild (and reshuffle) the page. A slot per builder, in display order.
let cache: { key: string; at: number; slots: FeedRow[][] } | null = null;

const cacheKey = (): string => getServer() + '|' + getToken();

export function cachedSuggestions(): FeedRow[][] | null {
  return cache && cache.key === cacheKey() && Date.now() - cache.at < CACHE_MS ? cache.slots : null;
}

export function clearSuggestions(): void {
  cache = null;
}

// Starts building every row; `onSlot` fires once per slot as it finishes (a
// failed builder counts as an empty slot). Returns a function that stops the
// callbacks.
export function loadSuggestions(onSlot: (slot: number, rows: FeedRow[]) => void): () => void {
  const ctx = makeCtx(new Date());
  const key = cacheKey();
  let alive = true;

  const safe = (p: Promise<FeedRow[]>): Promise<FeedRow[]> => p.catch(() => [] as FeedRow[]);
  const recent = safe(recentAlbumsRow(ctx));
  const seasonal = safe(seasonalRows(ctx));
  const onThisDay = safe(onThisDayRows(ctx));
  const latest = safe(latestRow(ctx));
  const videos = Promise.all([seasonal, onThisDay, latest]).then(() => videosRow(ctx));
  const slots = [recent, seasonal, onThisDay, latest, videos, safe(archiveRow(ctx)), safe(moreAlbumsRow(ctx))];
  if (slots.length !== SLOT_COUNT) throw new Error('SLOT_COUNT out of date');

  const results: FeedRow[][] = [];
  let left = slots.length;
  slots.forEach((p, i) =>
    safe(p).then((rows) => {
      results[i] = rows;
      if (alive) onSlot(i, rows);
      if (--left === 0) cache = { key, at: Date.now(), slots: results };
    }),
  );
  return () => {
    alive = false;
  };
}
