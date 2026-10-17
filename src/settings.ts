// Small persisted UI preferences. webOS web apps have a normal localStorage
// that survives app restarts (same store the auth state uses).

import type { Album } from './api/client';

const LIVE_PLAY_KEY = 'immich.livePlay';
const VIDEO_QUALITY_KEY = 'immich.videoQuality';
const SORT_KEY = 'immich.sort.';
const OVERLAY_HIDDEN_KEY = 'immich.overlayHidden';

export type VideoQuality = 'transcoded' | 'original';

// Preferred video stream quality. Defaults to transcoded (lighter for the TV);
// once the user switches a video to Original it becomes the default for every
// video and sticks across restarts.
export function getVideoQuality(): VideoQuality {
  return localStorage.getItem(VIDEO_QUALITY_KEY) === 'original' ? 'original' : 'transcoded';
}

export function setVideoQuality(q: VideoQuality): void {
  if (q === 'original') localStorage.setItem(VIDEO_QUALITY_KEY, 'original');
  else localStorage.removeItem(VIDEO_QUALITY_KEY);
}

// Whether Live Photos autoplay their motion clip. Off by default; the user
// turns it on with the viewer's Live button and it sticks across restarts.
export function getLivePlay(): boolean {
  return localStorage.getItem(LIVE_PLAY_KEY) === '1';
}

export function setLivePlay(on: boolean): void {
  if (on) localStorage.setItem(LIVE_PLAY_KEY, '1');
  else localStorage.removeItem(LIVE_PLAY_KEY);
}

// Whether the fullscreen viewer keeps its overlay (options bar, arrows, video
// controls) permanently hidden while browsing. Off by default (overlay
// auto-hides after inactivity); the user turns it on from the grid header for a
// clean, distraction-free view and it sticks across restarts. Navigation
// still works via the remote regardless, and Up still raises the options bar.
export function getOverlayHidden(): boolean {
  return localStorage.getItem(OVERLAY_HIDDEN_KEY) === '1';
}

export function setOverlayHidden(on: boolean): void {
  if (on) localStorage.setItem(OVERLAY_HIDDEN_KEY, '1');
  else localStorage.removeItem(OVERLAY_HIDDEN_KEY);
}

// Per-section sort direction. 'desc' (newest first) is the default everywhere;
// the user flips a section to 'asc' (oldest first) from its header sort button
// and it sticks across restarts. Each browsable section stores independently so
// e.g. albums can read oldest-first while the main timeline stays newest-first.
export type SortDir = 'asc' | 'desc';
export type SortSection = 'timeline' | 'favorites' | 'albums' | 'album';

export function getSort(section: SortSection): SortDir {
  return localStorage.getItem(SORT_KEY + section) === 'asc' ? 'asc' : 'desc';
}

export function setSort(section: SortSection, dir: SortDir): void {
  if (dir === 'asc') localStorage.setItem(SORT_KEY + section, 'asc');
  else localStorage.removeItem(SORT_KEY + section);
}

// The photos/videos filter on Home, Photos and inside an album: both kinds (the
// default each time the app opens), or only one.
export type MediaFilter = 'all' | 'photos' | 'videos';

// Where the last album's viewer was left: the album and the photo on screen,
// so Home can offer to continue from there. Saved as each photo shows, so it
// survives the app (or the TV) closing mid-show. One album only: the latest.
const ALBUM_PROGRESS_KEY = 'immich.albumProgress';

export interface AlbumProgress {
  album: Album;
  assetId: string;
  createdAt: string; // the photo's date: finds its month in the album on resume
  filter: MediaFilter; // the album's filter while it was watched
  n?: number; // its place in the album ("12 of 340"), when known
  total?: number;
  at: number; // when it was on screen (ms)
}

export function getAlbumProgress(): AlbumProgress | null {
  try {
    const p = JSON.parse(localStorage.getItem(ALBUM_PROGRESS_KEY) || 'null');
    return p && p.album?.id && typeof p.assetId === 'string' ? p : null;
  } catch {
    return null;
  }
}

export function setAlbumProgress(p: AlbumProgress | null): void {
  if (p) localStorage.setItem(ALBUM_PROGRESS_KEY, JSON.stringify(p));
  else localStorage.removeItem(ALBUM_PROGRESS_KEY);
}

// Albums the wallpaper slideshow draws from, by id. Empty until the user picks
// some on the Wallpaper page; the pick sticks across restarts.
const WALLPAPER_ALBUMS_KEY = 'immich.wallpaperAlbums';

export function getWallpaperAlbums(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(WALLPAPER_ALBUMS_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function setWallpaperAlbums(ids: string[]): void {
  if (ids.length) localStorage.setItem(WALLPAPER_ALBUMS_KEY, JSON.stringify(ids));
  else localStorage.removeItem(WALLPAPER_ALBUMS_KEY);
}
