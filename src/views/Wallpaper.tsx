import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { Asset, flattenBucket } from '../api/assets';
import { getAlbums, getAlbumBuckets, getAlbumBucket, Album } from '../api/client';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { getSort, getWallpaperAlbums, setWallpaperAlbums } from '../settings';
import { AlbumCard, sortAlbums } from './Albums';
import { WallpaperPlayer } from './WallpaperPlayer';
import { seenStore, SeenStore } from './wallpaperSeen';

// One month bucket of one picked album: the unit the feed pages in.
interface Page {
  albumId: string;
  timeBucket: string;
}

interface Props {
  // register a back handler with the shell; returns true when it consumed Back
  backRef: { current: (() => boolean) | null };
  // tell the shell a fullscreen overlay owns the keys (disables its remote nav)
  onFullscreen: (active: boolean) => void;
}

// Wallpaper page: every album as a checklist. Enter toggles an album in or out
// of the show (remembered across restarts); Start plays the photos of all
// picked albums in the fullscreen slideshow, shuffled.
export function Wallpaper({ backRef, onFullscreen }: Props) {
  // non-empty albums, in the Albums tab's sort order
  const [albums, setAlbums] = useState<Album[]>([]);
  const [fetched, setFetched] = useState(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(getWallpaperAlbums()));
  const [player, setPlayer] = useState<Asset[] | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null); // label while gathering
  const [empty, setEmpty] = useState(false);
  const startRef = useRef<HTMLButtonElement>(null);
  const wasPlaying = useRef(false);
  // bumped to cancel an in-flight prepare (Back pressed while preparing)
  const prepToken = useRef(0);
  // paged bucket cursor across the picked albums: buckets load one at a time as
  // the slideshow nears the end, instead of all up front.
  const feed = useRef<{
    pages: Page[];
    idx: number;
    loading: boolean;
    shuffle: boolean; // mirrors the player's toggle: skip already-shown items
    seen: SeenStore; // what the wallpaper has already shown (persisted)
    queued: Set<string>; // handed to the player this pass (albums can share photos)
  } | null>(null);

  // wire the shell's Back button to pop our internal state
  useEffect(() => {
    backRef.current = () => {
      if (player) {
        setPlayer(null);
        return true;
      }
      if (preparing) {
        prepToken.current++;
        setPreparing(null);
        return true;
      }
      if (empty) {
        setEmpty(false);
        return true;
      }
      return false;
    };
    return () => {
      backRef.current = null;
    };
  }, [backRef, player, preparing, empty]);

  useEffect(() => {
    onFullscreen(!!player);
  }, [player, onFullscreen]);

  useEffect(() => {
    getAlbums()
      .then((list) => sortAlbums(list.filter((a) => a.assetCount > 0), getSort('albums')))
      .then(setAlbums)
      .catch((e) => setError(e?.message || 'Failed to load albums'))
      .finally(() => setFetched(true));
  }, []);

  // back from the slideshow: land focus on Start again
  useEffect(() => {
    if (player) {
      wasPlaying.current = true;
    } else if (wasPlaying.current) {
      wasPlaying.current = false;
      setTimeout(() => startRef.current?.focus(), 0);
    }
  }, [player]);

  // Picked albums in list order. Ids of albums that no longer exist drop out
  // here, and out of storage on the next change.
  const chosen = albums.filter((a) => picked.has(a.id));
  const allPicked = albums.length > 0 && chosen.length === albums.length;

  const savePicked = (ids: string[]) => {
    setPicked(new Set(ids));
    setWallpaperAlbums(ids);
  };
  const toggle = (id: string) =>
    savePicked(albums.filter((a) => (a.id === id ? !picked.has(id) : picked.has(a.id))).map((a) => a.id));
  const toggleAll = () => savePicked(allPicked ? [] : albums.map((a) => a.id));

  // Pull the next bucket(s) until one yields photos not yet queued. Returns that
  // batch (empty when the albums are exhausted). While shuffling, items already
  // shown are skipped; once everything has been shown, the memory is cleared
  // and a fresh random pass over all buckets begins.
  const pullBatch = async (token: number): Promise<Asset[]> => {
    const f = feed.current;
    if (!f) return [];
    for (let pass = 0; pass < 2; pass++) {
      while (f.idx < f.pages.length) {
        const p = f.pages[f.idx++];
        const cols = await getAlbumBucket(p.albumId, p.timeBucket, 'asc').catch(() => null);
        if (prepToken.current !== token) return [];
        const add = flattenBucket(cols).filter(
          (a) => a.isImage && !f.queued.has(a.id) && !(f.shuffle && f.seen.has(a.id)),
        );
        add.forEach((a) => f.queued.add(a.id));
        if (add.length) return add;
      }
      if (!f.shuffle || !f.seen.size()) return [];
      f.seen.clear();
      f.queued.clear();
      f.pages = shuffled(f.pages);
      f.idx = 0;
    }
    return [];
  };

  // onNearEnd: append the next batch to the live play list (guarded so overlapping
  // near-end fires don't double-load the same bucket).
  const loadMore = useCallback(async () => {
    const f = feed.current;
    if (!f || f.loading) return;
    f.loading = true;
    const add = await pullBatch(prepToken.current);
    if (add.length) setPlayer((prev) => (prev ? [...prev, ...add] : add));
    f.loading = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shuffle toggled in the player: reorder the NOT-YET-CONSUMED buckets so the
  // pages that stream in next are sampled from across every picked album, not
  // just the next one in line. Off plays them oldest first. Already-loaded
  // assets are permuted by the player.
  const onShuffleChange = useCallback((on: boolean) => {
    const f = feed.current;
    if (!f) return;
    f.shuffle = on;
    const rest = f.pages.slice(f.idx);
    f.pages = f.pages.slice(0, f.idx).concat(
      on ? shuffled(rest) : rest.sort((a, b) => (a.timeBucket < b.timeBucket ? -1 : 1)),
    );
  }, []);

  const start = async () => {
    if (!chosen.length) return;
    const token = ++prepToken.current;
    setEmpty(false);
    setPreparing(chosen.length === 1 ? chosen[0].albumName : `${chosen.length} albums`);
    const lists = await Promise.all(
      chosen.map((a) =>
        getAlbumBuckets(a.id, 'asc')
          .then((bs) => bs.map((b): Page => ({ albumId: a.id, timeBucket: b.timeBucket })))
          .catch(() => [] as Page[]),
      ),
    );
    if (prepToken.current !== token) return; // cancelled via Back
    feed.current = {
      pages: shuffled(([] as Page[]).concat(...lists)),
      idx: 0,
      loading: false,
      shuffle: true, // the player starts shuffled
      seen: seenStore('albums'),
      queued: new Set(),
    };
    const first = await pullBatch(token); // just the first non-empty bucket
    if (prepToken.current !== token) return;
    setPreparing(null);
    if (first.length) setPlayer(first);
    else setEmpty(true); // the picked albums hold no photos
  };

  return (
    <div class="wp">
      <header class="wp-header">
        <div class="wp-header-text">
          <h1 class="album-title">Wallpaper</h1>
          {albums.length > 0 && (
            <div class="album-subtitle">
              {chosen.length
                ? `${chosen.length} of ${albums.length} albums selected`
                : 'Pick the albums to show'}
            </div>
          )}
        </div>
        {/* noautofocus: a freshly opened page lands on Start (or, with nothing
            picked yet, the first album), not on Select all */}
        {albums.length > 0 && (
          <button
            data-focusable
            data-noautofocus
            data-header-nav
            class="wp-btn focusable"
            onClick={toggleAll}
          >
            <Icon name={allPicked ? 'close' : 'check'} size={24} />
            <span>{allPicked ? 'Clear all' : 'Select all'}</span>
          </button>
        )}
        {chosen.length > 0 && (
          <button
            ref={startRef}
            data-focusable
            data-header-nav
            class="wp-btn wp-btn-primary focusable"
            onClick={start}
          >
            <Icon name="play" size={26} />
            <span>Start</span>
          </button>
        )}
      </header>

      {error ? (
        <div class="msg error">{error}</div>
      ) : albums.length ? (
        <div class="album-grid">
          {albums.map((a) => (
            <AlbumCard key={a.id} album={a} checked={picked.has(a.id)} onSelect={() => toggle(a.id)} />
          ))}
        </div>
      ) : fetched ? (
        <EmptyState
          title="No albums yet"
          hint="Create an album in the Immich mobile or web app, then pick it here to use as wallpaper."
        />
      ) : (
        <div class="msg">Loading…</div>
      )}

      {preparing && (
        <div class="wp-prep">
          <div class="fs-spinner" />
          <div class="wp-prep-text">Preparing {preparing}…</div>
        </div>
      )}

      {empty && (
        <div class="wp-prep">
          <EmptyState
            title="No photos to show"
            hint="The selected albums have no photos. Pick other albums to use as wallpaper."
          />
        </div>
      )}

      {player && feed.current && (
        <WallpaperPlayer
          assets={player}
          mode="photos"
          seen={feed.current.seen}
          onExit={() => setPlayer(null)}
          onNearEnd={loadMore}
          onShuffleChange={onShuffleChange}
        />
      )}
    </div>
  );
}

// Fisher-Yates shuffle into a new array (does not mutate input).
function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
