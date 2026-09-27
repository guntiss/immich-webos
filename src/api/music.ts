// App-wide background music: one <audio> element playing internet radio (see
// radio.ts). It starts on Lofi every time the app opens and is steered from
// the sidebar's Music menu.
//
// webOS has one hardware media pipeline, and a radio stream and a video can't
// decode at the same time (the video plane just goes black), so whatever plays
// a video with sound holds the music off with holdMusic() while it does. The
// stream is also let go while the app is in the background, so it never plays
// over live TV or another app.
import { useEffect, useState } from 'preact/hooks';
import { fetchStations, Station } from './radio';

export const GENRES = [
  { label: 'Lofi', tag: 'lofi' },
  { label: 'Ambient', tag: 'ambient' },
  { label: 'Jazz', tag: 'jazz' },
  { label: 'Classical', tag: 'classical' },
];
const DEFAULT_GENRE = 'lofi';

export interface MusicState {
  on: boolean;
  genre: string; // kept while off, so turning it back on resumes this genre
  stations: Station[]; // the genre's stations, most popular first
  idx: number; // the one playing
  loading: boolean; // fetching the genre's stations
  failed: boolean; // no station of this genre could be found or played
}

let state: MusicState = {
  on: false,
  genre: DEFAULT_GENRE,
  stations: [],
  idx: 0,
  loading: false,
  failed: false,
};
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let src = ''; // the stream URL set on `audio` ('' = unloaded)
let holds = 0;
let fetchToken = 0; // only the latest genre fetch lands
let errors = 0; // stations in a row that failed to play
let unlockArmed = false;

function set(patch: Partial<MusicState>): void {
  state = { ...state, ...patch };
  sync();
  listeners.forEach((l) => l());
}

function wanted(): boolean {
  return state.on && holds === 0 && !document.hidden;
}

// Drive the <audio> element from the state.
function sync(): void {
  const a = audio;
  if (!a) return;
  const st = state.stations[state.idx];
  if (wanted() && st && !state.failed) {
    if (src !== st.url) a.src = src = st.url;
    a.play().catch((err: Error) => {
      // blocked by an autoplay policy (desktop dev before any gesture): retry
      // on the next key press or click
      if (err?.name !== 'NotAllowedError' || unlockArmed) return;
      unlockArmed = true;
      const retry = () => {
        unlockArmed = false;
        window.removeEventListener('keydown', retry, true);
        window.removeEventListener('pointerdown', retry, true);
        sync();
      };
      window.addEventListener('keydown', retry, true);
      window.addEventListener('pointerdown', retry, true);
    });
  } else if (src) {
    // unload rather than pause, so a video gets the media pipeline to itself
    // and a live stream never resumes from a stale buffer
    src = '';
    a.pause();
    a.removeAttribute('src');
    a.load();
  }
}

function ensureAudio(): void {
  if (audio) return;
  const a = document.createElement('audio');
  a.addEventListener('playing', () => {
    errors = 0;
  });
  // a dead stream: move on to the genre's next station, giving up once every
  // one of them has failed in a row
  a.addEventListener('error', () => {
    if (!src || !wanted()) return;
    const n = state.stations.length;
    if (++errors >= n) set({ failed: true });
    else set({ idx: (state.idx + 1) % n });
  });
  // a muted video can still steal audio focus on webOS and pause the stream —
  // resume it if music is meant to be on
  a.addEventListener('pause', () => {
    if (!wanted()) return;
    window.setTimeout(() => {
      if (wanted() && src) void a.play().catch(() => {});
    }, 400);
  });
  document.addEventListener('visibilitychange', sync);
  document.body.appendChild(a);
  audio = a;
}

async function load(tag: string): Promise<void> {
  const token = ++fetchToken;
  errors = 0;
  set({ stations: [], idx: 0, loading: true, failed: false });
  const stations = await fetchStations(tag);
  if (token !== fetchToken) return;
  set({ stations, idx: 0, loading: false, failed: !stations.length });
}

// Start the music as the app opens: always Lofi, whatever was playing before.
export function startMusic(): void {
  ensureAudio();
  set({ on: true, genre: DEFAULT_GENRE });
  void load(DEFAULT_GENRE);
}

export function stopMusic(): void {
  set({ on: false });
}

// Play a genre. Re-picking the current one (or turning back on to it) keeps
// its station; a genre that failed is fetched again.
export function playGenre(tag: string): void {
  ensureAudio();
  const reuse = tag === state.genre && (state.loading || (state.stations.length > 0 && !state.failed));
  set({ on: true, genre: tag });
  if (!reuse) void load(tag);
}

export function toggleMusic(): void {
  if (state.on) stopMusic();
  else playGenre(state.genre);
}

export function nextStation(): void {
  const n = state.stations.length;
  if (n < 2) return;
  errors = 0;
  set({ idx: (state.idx + 1) % n, failed: false });
}

// Keep the music off until the returned release() is called.
export function holdMusic(): () => void {
  holds++;
  sync();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holds--;
    sync();
  };
}

export function useMusic(): MusicState {
  const [s, setS] = useState(state);
  useEffect(() => {
    const l = () => setS(state);
    listeners.add(l);
    l(); // catch a change between the first render and subscribing
    return () => {
      listeners.delete(l);
    };
  }, []);
  return s;
}
