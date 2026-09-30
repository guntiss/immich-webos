import { useState, useEffect, useRef } from 'preact/hooks';
import { Icon } from './Icon';
import { IconName } from './icons';
import { ImmichLogo } from './ImmichLogo';
import { isWebOS, checkForUpdate } from '../api/localRelay';
import { GENRES, useMusic, playGenre, stopMusic, toggleMusic, nextStation } from '../api/music';
import pkg from '../../package.json';

const APP_VERSION = 'v' + pkg.version;

export type Route = 'home' | 'timeline' | 'albums' | 'favorites' | 'search' | 'wallpaper';

interface Item {
  route: Route;
  label: string;
  icon: IconName;
}

const ITEMS: Item[] = [
  { route: 'home', label: 'Home', icon: 'home' },
  { route: 'timeline', label: 'Photos', icon: 'photos' },
  { route: 'search', label: 'Search', icon: 'search' },
  { route: 'albums', label: 'Albums', icon: 'albums' },
  { route: 'favorites', label: 'Favorites', icon: 'favorite' },
  { route: 'wallpaper', label: 'Slideshow', icon: 'wallpaper' },
];

interface Props {
  open: boolean;
  active: Route;
  userName?: string;
  onNavigate: (r: Route) => void;
  onLogout: () => void;
  // register a back handler with the shell; returns true when it consumed Back
  backRef: { current: (() => boolean) | null };
}

// Single floating rail card. Collapsed it's a 76px icon strip; open it widens
// to 300px and reveals the labels — the SAME element grows, not a second drawer
// sliding over it.
//
// Smoothness: animating `width` normally relayouts the contents every frame
// (the old chop). We avoid that by laying the inner content out at a FIXED
// width (.rail-inner) regardless of the outer card's animated width, so growing
// the card just reveals more of already-laid-out content (overflow:hidden clips
// it) — no text reflow per frame. `contain` bounds the relayout/repaint to the
// card's own small box, so the (huge) grid behind it is never touched.
//
// Focusability: the nav buttons join d-pad navigation (data-focusable +
// data-sidebar) ONLY while open, so the collapsed strip stays out of the grid's
// focus order. Collapsed, they remain pointer-clickable (magic remote).
type UpdateStatus = 'idle' | 'checking' | 'upToDate' | 'installing' | 'error';

export function Sidebar({ open, active, userName, onNavigate, onLogout, backRef }: Props) {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateLabel, setUpdateLabel] = useState(APP_VERSION);

  const handleUpdate = async () => {
    if (updateStatus === 'checking') return;
    setUpdateStatus('checking');
    setUpdateLabel('Checking...');
    const result = await checkForUpdate();
    if ('error' in result) {
      setUpdateLabel(result.error.slice(0, 28));
      setUpdateStatus('error');
      setTimeout(() => { setUpdateStatus('idle'); setUpdateLabel(APP_VERSION); }, 4000);
    } else if ('upToDate' in result) {
      setUpdateLabel('Up to date');
      setUpdateStatus('upToDate');
      setTimeout(() => { setUpdateStatus('idle'); setUpdateLabel(APP_VERSION); }, 3000);
    } else {
      if (result.latestVersion === pkg.version) {
        setUpdateLabel('Up to date');
        setUpdateStatus('upToDate');
        setTimeout(() => { setUpdateStatus('idle'); setUpdateLabel(APP_VERSION); }, 3000);
      } else {
        setUpdateLabel('v' + result.latestVersion + ' available');
        setUpdateStatus('upToDate');
      }
    }
  };
  // Warm-up: prime the open-state card (full width + its box-shadow blur) into
  // the GPU cache once at mount, invisibly, so the first real open paints
  // without a cold hitch. A 3-step state machine across frames keeps the
  // teardown from animating: `.priming` pins transition:none + opacity:0, held
  // through the frame where width jumps back to collapsed, then dropped only
  // once it's settled — re-enabling the transition with nothing pending.
  //   prime  -> open + priming   (full width, shadow, invisible, no-anim)
  //   settle -> priming          (width jumps back to collapsed, no-anim)
  //   done   -> (none)           (transition restored, nothing to animate)
  const [warm, setWarm] = useState<'prime' | 'settle' | 'done'>('prime');
  useEffect(() => {
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      setWarm('settle');
      r2 = requestAnimationFrame(() => setWarm('done'));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, []);

  // Music: the row shows what's playing; OK opens its menu of genres (plus
  // next station and off) right under it. Collapsed, a click on the note just
  // turns the music on or off.
  const music = useMusic();
  const [musicMenu, setMusicMenu] = useState(false);
  const musicBtn = useRef<HTMLButtonElement>(null);
  const musicMenuRef = useRef<HTMLDivElement>(null);
  const openMusicMenu = () => {
    setMusicMenu(true);
    setTimeout(() => musicMenuRef.current?.querySelector<HTMLElement>('.selected')?.focus(), 0);
  };
  const closeMusicMenu = () => {
    setMusicMenu(false);
    setTimeout(() => musicBtn.current?.focus(), 0);
  };
  // the menu folds away with the rail
  useEffect(() => {
    if (!open) setMusicMenu(false);
  }, [open]);
  // Back inside the menu closes it instead of leaving the app
  useEffect(() => {
    backRef.current = () => {
      if (!musicMenu) return false;
      closeMusicMenu();
      return true;
    };
    return () => {
      backRef.current = null;
    };
  }, [backRef, musicMenu]);
  const genreLabel = GENRES.find((g) => g.tag === music.genre)?.label ?? music.genre;
  const station = music.stations[music.idx];
  const musicStatus = !music.on
    ? 'Off'
    : genreLabel +
      ' · ' +
      (music.failed ? 'No station found' : station && !music.loading ? station.name : 'Tuning in…');

  const priming = warm !== 'done';
  const railOpen = open || warm === 'prime';
  // d-pad focusability only when genuinely open (not during the warm-up prime).
  const navAttrs = open
    ? { 'data-focusable': true, 'data-sidebar': true }
    : { tabIndex: -1 };

  return (
    <>
    {/* Shadow on its OWN layer, fixed at the open geometry, opacity-faded — like
        LG's native UI bakes its shadow and alpha-composites it. Kept a sibling
        (not inside .rail) because the rail's overflow:hidden would clip it. */}
    <div class={'rail-shadow' + (open ? ' open' : '')} aria-hidden="true" />
    <aside
      class={'rail ' + (railOpen ? 'open ' : '') + (priming ? 'priming' : '')}
    >
      {/* fixed-width inner: never reflows as the outer card animates width */}
      <div class="rail-inner">
        <div class="rail-brand">
          <ImmichLogo size={40} />
          <span class="rail-label">Immich</span>
        </div>

        <nav class="rail-nav">
          {ITEMS.map((it) => (
            <button
              key={it.route}
              {...navAttrs}
              class={'rail-item focusable ' + (active === it.route ? 'active' : '')}
              onClick={() => onNavigate(it.route)}
            >
              <Icon name={it.icon} size={26} />
              <span class="rail-label">{it.label}</span>
            </button>
          ))}
        </nav>

        <div class="rail-foot">
          <button
            ref={musicBtn}
            {...navAttrs}
            class={'rail-item rail-music focusable' + (music.on ? ' on' : '')}
            onClick={() => (!open ? toggleMusic() : musicMenu ? closeMusicMenu() : openMusicMenu())}
          >
            <Icon name="music" size={26} />
            <span class="rail-label rail-music-text">
              <span>Music</span>
              <span class="rail-music-status">{musicStatus}</span>
            </span>
          </button>
          {musicMenu && (
            <div class="rail-music-menu" ref={musicMenuRef}>
              {music.on && music.stations.length > 1 && (
                <button {...navAttrs} class="rail-item rail-sub focusable" onClick={nextStation}>
                  <Icon name="skipNext" size={22} />
                  <span class="rail-label">Next station</span>
                </button>
              )}
              {GENRES.map((g) => {
                const sel = music.on && g.tag === music.genre;
                return (
                  <button
                    key={g.tag}
                    {...navAttrs}
                    class={'rail-item rail-sub focusable' + (sel ? ' selected' : '')}
                    onClick={() => {
                      playGenre(g.tag);
                      closeMusicMenu();
                    }}
                  >
                    <Icon name="check" size={22} class="rail-tick" />
                    <span class="rail-label">{g.label}</span>
                  </button>
                );
              })}
              <button
                {...navAttrs}
                class={'rail-item rail-sub focusable' + (!music.on ? ' selected' : '')}
                onClick={() => {
                  stopMusic();
                  closeMusicMenu();
                }}
              >
                <Icon name="check" size={22} class="rail-tick" />
                <span class="rail-label">Off</span>
              </button>
            </div>
          )}
          <div class="rail-item user">
            <Icon name="account" size={26} />
            <span class="rail-label">{userName || 'Account'}</span>
          </div>
          {isWebOS() && (
            <button
              {...navAttrs}
              class={'rail-item focusable' + (updateStatus === 'error' ? ' rail-item--error' : updateStatus === 'upToDate' ? ' rail-item--ok' : '')}
              onClick={handleUpdate}
            >
              <Icon name="update" size={26} />
              <span class="rail-label">{updateLabel}</span>
            </button>
          )}
          <button
            {...navAttrs}
            class="rail-item focusable"
            onClick={onLogout}
          >
            <Icon name="logout" size={26} />
            <span class="rail-label">Sign out</span>
          </button>
        </div>
      </div>
    </aside>
    </>
  );
}
