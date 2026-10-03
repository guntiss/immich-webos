import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Album } from '../api/client';
import { Asset } from '../api/assets';
import { FeedRow, SLOT_COUNT, cachedSuggestions, loadSuggestions } from '../api/suggestions';
import { focus } from '../nav/focus';
import { EmptyState } from '../components/EmptyState';
import { Thumb } from '../components/Thumb';
import { AlbumCard, AlbumsRestore } from './Albums';

// Photo tiles share one height and take their width from the photo's shape, so
// portraits stay portraits; the clamp keeps panoramas and slivers reasonable.
const TILE_H = 230;
const TILE_MIN_W = 150;
const TILE_MAX_W = 400;

const tileWidth = (a: Asset): number =>
  Math.round(Math.max(TILE_MIN_W, Math.min(TILE_MAX_W, TILE_H * (a.ratio > 0 ? a.ratio : 1))));

// The rows to show: builders finish in any order but the page only shows a
// finished prefix of them, so a late row never pushes in above one already on
// screen. A photo or album already shown higher up is left out of later rows,
// so each appears once (the viewer finds its tile by asset id). `keep` is the
// photos/videos filter: photo rows keep only that kind and a row left empty
// goes; album rows stay, an album holds both.
function visibleRows(slots: (FeedRow[] | undefined)[], keep?: (a: Asset) => boolean): FeedRow[] {
  const photos = new Set<string>();
  const albums = new Set<string>();
  const out: FeedRow[] = [];
  for (let i = 0; i < slots.length; i++) {
    const rows = slots[i];
    if (!rows) break;
    for (const row of rows) {
      if (row.kind === 'albums') {
        const fresh = row.albums.filter((a) => !albums.has(a.id));
        fresh.forEach((a) => albums.add(a.id));
        if (fresh.length) out.push({ ...row, albums: fresh });
      } else {
        const fresh = row.assets.filter((a) => (!keep || keep(a)) && !photos.has(a.id));
        fresh.forEach((a) => photos.add(a.id));
        if (fresh.length) out.push({ ...row, assets: fresh });
      }
    }
  }
  return out;
}

// Home: suggestions of what to look at, one horizontal row each — recent
// albums, the latest photos, photos from this day in earlier years, the
// season's holiday, videos, a random pick from the archive. Built from albums
// (the TV's account typically owns nothing, only sees shared albums).
export function HomeFeed({
  onOpen,
  onOpenAlbum,
  restore,
  onRestored,
  keep,
}: {
  keep?: (a: Asset) => boolean;
  onOpen: (assets: Asset[], index: number) => void;
  onOpenAlbum: (album: Album) => void;
  restore?: AlbumsRestore | null;
  onRestored?: () => void;
}) {
  const [slots, setSlots] = useState<(FeedRow[] | undefined)[]>(() => cachedSuggestions() || []);
  const pageRef = useRef<HTMLDivElement>(null);
  const done = slots.filter(Boolean).length === SLOT_COUNT;

  useEffect(() => {
    if (cachedSuggestions()) return;
    return loadSuggestions((i, rows) =>
      setSlots((s) => {
        const next = s.slice();
        next[i] = rows;
        return next;
      }),
    );
  }, []);

  const rows = useMemo(() => visibleRows(slots, keep), [slots, keep]);

  // Back from an opened album: put the page's scroll and focus back on its card.
  // Focus first (its instant retarget scrolls the card into its row), then set
  // the saved scrollTop so the page stays exactly where it was.
  useEffect(() => {
    if (!restore) return;
    const page = pageRef.current;
    if (!page) return;
    const card = page.querySelector<HTMLElement>(`[data-album-id="${restore.albumId}"]`);
    if (card) {
      focus(card, true);
      page.scrollTop = restore.scrollTop;
      onRestored?.();
    } else if (done) {
      onRestored?.(); // the card is gone (the rows were rebuilt): start from the top
    }
  }, [rows, done, restore]);

  if (!rows.length) {
    return done ? (
      <EmptyState
        title={keep ? 'Nothing of that kind to suggest yet' : 'Nothing to show yet'}
        hint={
          keep
            ? 'Switch the filter in the top corner to see everything.'
            : 'Albums shared with this account, and photos in them, will be suggested here.'
        }
      />
    ) : (
      <div class="msg">Loading…</div>
    );
  }

  return (
    <div class="feed" ref={pageRef}>
      {rows.map((row) => (
        <section class="feed-row" key={row.id}>
          <div class="feed-head">
            <h2 class="feed-title">{row.title}</h2>
            {row.subtitle && <span class="feed-sub">{row.subtitle}</span>}
          </div>
          <div class="feed-scroller">
            {row.kind === 'albums'
              ? row.albums.map((a) => <AlbumCard key={a.id} album={a} row={row.id} onSelect={() => onOpenAlbum(a)} />)
              : row.assets.map((a, i) => (
                  <Thumb
                    key={a.id}
                    row={row.id}
                    assetId={a.id}
                    thumbhash={a.thumbhash}
                    isVideo={a.isVideo}
                    duration={a.duration}
                    isLive={!!a.livePhotoVideoId}
                    width={tileWidth(a)}
                    height={TILE_H}
                    onSelect={() => onOpen(row.assets, i)}
                  />
                ))}
          </div>
        </section>
      ))}
    </div>
  );
}
