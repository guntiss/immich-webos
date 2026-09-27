// App-wide background music: one <audio> element playing internet radio (see
// radio.ts). It starts on Lofi every time the app opens and is steered from
// the sidebar's Music menu.
//
// webOS plays one media element at a time: a playing video pauses the radio,
// and the radio resuming stops the video (even a muted one, even with the radio
// muted). So a video first ducks the music with duckMusic(): it fades out and
// pauses with its stream still buffered, then resumes from that buffer and
// fades back in when the video stops, instead of reconnecting. The stream is
// let go while the app is in the background, so it never plays over live TV
// or another app.
import { useEffect, useState } from 'preact/hooks';
import { fetchStations, Station } from './radio';
import { digitalSoundOutput, watchSoundOutput } from './soundOutput';

export const GENRES = [
  { label: 'Lofi', tag: 'lofi' },
  { label: 'Ambient', tag: 'ambient' },
  { label: 'Jazz', tag: 'jazz' },
  { label: 'Classical', tag: 'classical' },
];
const DEFAULT_GENRE = 'lofi';
const VOLUME = 0.7; // background level, under the TV's own volume
const DUCK_MS = 350; // fade out before a video starts
const UNDUCK_MS = 1000; // fade back in once it stops
const UNDUCK_DELAY_MS = 300; // so stepping from one video to the next doesn't bounce it

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
let ducks = 0;
let silent: Promise<void> = Promise.resolve(); // resolves once a duck has faded out
let unduckTimer = 0;
let fadeTimer = 0;
let fetchToken = 0; // only the latest genre fetch lands
let errors = 0; // stations in a row that failed to play
let unlockArmed = false;
let heardPcm = false; // non-AAC music has played since a clip last took over

function set(patch: Partial<MusicState>): void {
  state = { ...state, ...patch };
  sync();
  listeners.forEach((l) => l());
}

function wanted(): boolean {
  return state.on && !document.hidden;
}

// Ease the volume to `to` over `ms`, then call done(). A newer fade cancels it.
function fadeTo(to: number, ms: number, done?: () => void): void {
  const a = audio;
  if (!a) return;
  window.clearInterval(fadeTimer);
  const from = a.volume;
  const t0 = Date.now();
  fadeTimer = window.setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / ms);
    a.volume = from + (to - from) * k;
    if (k === 1) {
      window.clearInterval(fadeTimer);
      done?.();
    }
  }, 30);
}

// Drive the <audio> element from the state.
function sync(): void {
  const a = audio;
  if (!a) return;
  const st = state.stations[state.idx];
  if (wanted() && st && !state.failed) {
    if (src !== st.url) a.src = src = st.url;
    if (ducks) return; // stays paused under the video
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
    // unload rather than pause, so a live stream never resumes from a stale
    // buffer
    src = '';
    a.pause();
    a.removeAttribute('src');
    a.load();
  }
}

function ensureAudio(): void {
  if (audio) return;
  const a = document.createElement('audio');
  a.volume = VOLUME;
  a.addEventListener('playing', () => {
    errors = 0;
    if (!state.stations[state.idx]?.aac) heardPcm = true;
  });
  // a dead stream: move on to the genre's next station, giving up once every
  // one of them has failed in a row
  a.addEventListener('error', () => {
    if (!src || !wanted()) return;
    const n = state.stations.length;
    if (++errors >= n) set({ failed: true });
    else set({ idx: (state.idx + 1) % n });
  });
  // a video loading can still take the media pipeline and pause the stream —
  // resume it if music is meant to be on (and no video is playing)
  a.addEventListener('pause', () => {
    if (!wanted() || ducks) return;
    window.setTimeout(() => {
      if (wanted() && !ducks && src) void a.play().catch(() => {});
    }, 400);
  });
  document.addEventListener('visibilitychange', sync);
  watchSoundOutput();
  document.body.appendChild(a);
  audio = a;
}

async function load(tag: string): Promise<void> {
  const token = ++fetchToken;
  errors = 0;
  set({ stations: [], idx: 0, loading: true, failed: false });
  let stations = await fetchStations(tag);
  if (token !== fetchToken) return;
  // A digital link to a soundbar or receiver carries the radio's MP3 as PCM
  // but AAC as it is, like a clip's own audio: an AAC station keeps it on one
  // format, so the receiver doesn't go quiet re-syncing whenever a clip
  // starts or stops (see takeClipWarmup).
  if (digitalSoundOutput() && stations.some((s) => s.aac)) stations = stations.filter((s) => s.aac);
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

// Make way for a video: the music fades out and pauses, and `faded` resolves
// once it's silent — start the video then. release() fades it back in.
export function duckMusic(): { faded: Promise<void>; release: () => void } {
  window.clearTimeout(unduckTimer);
  const a = audio;
  if (ducks++ === 0 && a) {
    if (a.paused) {
      // already silent (off, still tuning in, or paused by a video loading):
      // just make sure it comes back with a fade
      window.clearInterval(fadeTimer);
      a.volume = 0;
      silent = Promise.resolve();
    } else {
      silent = new Promise((res) => fadeTo(0, DUCK_MS, () => {
        a.pause();
        res();
      }));
    }
  }
  let ducked = true;
  const release = () => {
    if (!ducked) return;
    ducked = false;
    if (--ducks) return;
    unduckTimer = window.setTimeout(() => {
      sync(); // resumes the stream, still at zero volume
      fadeTo(VOLUME, UNDUCK_MS);
    }, UNDUCK_DELAY_MS);
  };
  return { faded: silent, release };
}

// Whether a clip with sound, about to play, should warm the audio output up
// first. A digital link to a soundbar or receiver (ARC/eARC, optical) sends
// MP3 music as PCM but a clip's own AAC as it is, and the receiver goes quiet
// for about a second re-syncing to the new format, swallowing the start of the
// clip. Only needed when non-AAC music has played since the last clip (the
// digital link normally gets AAC stations, see load).
export function takeClipWarmup(): boolean {
  const need = heardPcm && digitalSoundOutput();
  heardPcm = false;
  return need;
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
