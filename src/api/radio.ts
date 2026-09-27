// Radio Browser API — free community directory of internet-radio streams, no
// key/auth. We use it to play ambient background music over the wallpaper.
// https://api.radio-browser.info  (CORS: Access-Control-Allow-Origin: *)
//
// The API is a pool of mirror hosts; any can be down, so we try a few in turn.

export interface Station {
  name: string;
  url: string; // resolved stream URL, playable directly in <audio>
  aac: boolean; // AAC/AAC+ stream (else MP3, OGG, ...)
}

const HOSTS = [
  'https://de2.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
  'https://de1.api.radio-browser.info',
];

// Top working stations for a tag (e.g. "ambient", "lofi", "chillout"), most
// clicked first. Returns [] if every mirror is unreachable.
export async function fetchStations(tag = 'ambient'): Promise<Station[]> {
  const q =
    `/json/stations/search?tag=${encodeURIComponent(tag)}` +
    '&hidebroken=true&order=clickcount&reverse=true&limit=100';
  for (const host of HOSTS) {
    try {
      const res = await fetch(host + q);
      if (!res.ok) continue;
      const data = (await res.json()) as Array<{
        name: string;
        url: string;
        url_resolved?: string;
        codec?: string;
      }>;
      const stations = data
        .map((d) => ({
          name: d.name?.trim() || 'Unknown',
          url: d.url_resolved || d.url,
          aac: /^AAC/i.test(d.codec || ''),
        }))
        .filter((s) => !!s.url);
      if (stations.length) return stations;
    } catch {
      // try the next mirror
    }
  }
  return [];
}
