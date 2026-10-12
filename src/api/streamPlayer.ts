// Internet radio through Web Audio instead of an <audio> element. webOS gives
// media elements one player at a time, so a clip playing pauses an <audio>
// radio; Web Audio goes out through the system mixer, beside it. The stream is
// fetched, split into frames by hand (ADTS AAC or MP3), decoded with WebCodecs
// and played as back-to-back buffers. Needs the stream to allow CORS; anything
// it can't play is reported through onError before onPlaying, and the caller
// falls back to <audio>.

const LEAD_S = 1; // buffered ahead when playback starts (or restarts after a gap)
const MAX_LEAD_S = 8; // more than this queued (the server's clock running fast): drop frames
const SCAN_BYTES = 64 * 1024; // no audio frame found in this much: not a stream we can play
const STALL_MS = 15000; // no data for this long: the stream is dead

export interface StreamPlayer {
  setVolume(v: number, ms: number): void;
  stop(): void;
}

interface Opts {
  volume: number;
  onPlaying: () => void;
  onError: () => void;
}

interface Frame {
  len: number; // bytes, header included
  codec: string; // WebCodecs codec string
  sampleRate: number;
  channels: number;
  samples: number; // per frame
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
// MPEG audio Layer III bitrates in kbps, by bitrate index
const MP3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

// The ADTS or MP3 frame whose header starts at b[i], if there is one.
function frameAt(b: Uint8Array, i: number): Frame | null {
  if (i + 7 > b.length || b[i] !== 0xff) return null;
  const b1 = b[i + 1];
  const b2 = b[i + 2];
  if ((b1 & 0xf6) === 0xf0) {
    // ADTS: sync 0xFFF, layer 00
    const sampleRate = AAC_RATES[(b2 >> 2) & 15];
    const channels = ((b2 & 1) << 2) | (b[i + 3] >> 6);
    const len = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
    if (!sampleRate || !channels || len < 7) return null;
    return { len, codec: 'mp4a.40.2', sampleRate, channels, samples: 1024 };
  }
  if ((b1 & 0xe0) === 0xe0 && ((b1 >> 1) & 3) === 1) {
    // MPEG audio Layer III
    const ver = (b1 >> 3) & 3;
    const rates = MP3_RATES[ver];
    const kbps = (ver === 3 ? MP3_KBPS_V1 : MP3_KBPS_V2)[b2 >> 4];
    const sampleRate = rates?.[(b2 >> 2) & 3];
    if (!sampleRate || !kbps) return null;
    const samples = ver === 3 ? 1152 : 576;
    const len = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + ((b2 >> 1) & 1);
    return { len, codec: 'mp3', sampleRate, channels: b[i + 3] >> 6 === 3 ? 1 : 2, samples };
  }
  return null;
}

export function canStream(): boolean {
  return typeof AudioDecoder !== 'undefined' && typeof AudioContext !== 'undefined';
}

export function playStream(url: string, opts: Opts): StreamPlayer {
  const abort = new AbortController();
  let stopped = false;
  let played = false;
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let decoder: AudioDecoder | null = null;
  let volume = opts.volume;
  let next = 0; // context time the next buffer starts at
  let stall = 0;
  let unlock: (() => void) | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(stall);
    abort.abort();
    if (unlock) {
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('pointerdown', unlock, true);
    }
    if (decoder && decoder.state !== 'closed') decoder.close();
    void ctx?.close();
  };
  const fail = () => {
    if (stopped) return;
    stop();
    opts.onError();
  };
  const armStall = () => {
    window.clearTimeout(stall);
    stall = window.setTimeout(fail, STALL_MS);
  };

  const play = (d: AudioData) => {
    const c = ctx!;
    const now = c.currentTime;
    if (next < now + 0.02) next = now + LEAD_S; // starting, or ran dry: buffer up again
    if (next - now > MAX_LEAD_S) return d.close();
    const n = d.numberOfFrames;
    const buf = c.createBuffer(d.numberOfChannels, n, d.sampleRate);
    for (let ch = 0; ch < d.numberOfChannels; ch++) {
      const plane = new Float32Array(n);
      d.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
      buf.copyToChannel(plane, ch);
    }
    d.close();
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(gain!);
    src.start(next);
    next += n / buf.sampleRate;
    if (!played) {
      played = true;
      opts.onPlaying();
    }
  };

  // the first frame sets up the context at the stream's own rate, so the
  // buffers aren't resampled one by one (which clicks at their seams)
  const open = (f: Frame) => {
    const c = new AudioContext({ sampleRate: f.sampleRate });
    ctx = c;
    gain = c.createGain();
    gain.gain.value = volume;
    gain.connect(c.destination);
    // blocked by an autoplay policy (desktop dev before any gesture): resume
    // on the next key press or click
    if (c.state === 'suspended') {
      unlock = () => void c.resume();
      window.addEventListener('keydown', unlock, true);
      window.addEventListener('pointerdown', unlock, true);
    }
    decoder = new AudioDecoder({ output: play, error: fail });
    decoder.configure({ codec: f.codec, sampleRate: f.sampleRate, numberOfChannels: f.channels });
  };

  void (async () => {
    try {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok || !res.body) return fail();
      const reader = res.body.getReader();
      armStall();
      let pending = new Uint8Array(0);
      let codec = ''; // locked onto this format
      let scanned = 0;
      let ts = 0; // microseconds
      for (;;) {
        const { value, done } = await reader.read();
        if (stopped) return;
        if (done) return fail();
        armStall();
        const b = new Uint8Array(pending.length + value.length);
        b.set(pending);
        b.set(value, pending.length);
        let i = 0;
        while (i + 7 <= b.length) {
          const f = frameAt(b, i);
          if (!f || (codec && f.codec !== codec)) {
            i++;
            continue;
          }
          if (i + f.len > b.length) break;
          if (!codec) {
            // lock on only where the next frame follows right behind, so a
            // stray sync word (in an ID3 tag, say) can't set the format
            if (i + f.len + 7 > b.length) break;
            const g = frameAt(b, i + f.len);
            if (!g || g.codec !== f.codec) {
              i++;
              continue;
            }
            codec = f.codec;
            open(f);
          }
          decoder!.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: b.subarray(i, i + f.len) }));
          ts += (f.samples * 1e6) / f.sampleRate;
          i += f.len;
        }
        if (!codec && (scanned += i) > SCAN_BYTES) return fail();
        pending = b.slice(i);
      }
    } catch {
      fail();
    }
  })();

  return {
    setVolume(v, ms) {
      volume = v;
      if (!ctx || !gain) return;
      const t = ctx.currentTime;
      const p = gain.gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(v, t + ms / 1000);
    },
    stop,
  };
}
