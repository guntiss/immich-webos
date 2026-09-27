// Remembers which wallpaper items have been shown, per source, across sessions
// (webOS localStorage survives app restarts), so shuffle plays everything once
// before anything repeats. Insertion-ordered: past MAX_SEEN the oldest entries
// roll off and become eligible again. Saves are batched — each one rewrites the
// whole list, too heavy to do on every photo change.

const PREFIX = 'immich.wallpaperSeen.';
const MAX_SEEN = 10000;
const SAVE_MS = 15000;

export interface SeenStore {
  has(id: string): boolean;
  add(id: string): void;
  size(): number;
  clear(): void;
  flush(): void; // write any pending additions now (player close)
}

export function seenStore(source: string): SeenStore {
  const key = PREFIX + source;
  let ids = new Set<string>(load(key));
  let timer: number | undefined;

  const write = () => {
    if (ids.size) localStorage.setItem(key, JSON.stringify(Array.from(ids)));
    else localStorage.removeItem(key);
  };
  const save = () => {
    window.clearTimeout(timer);
    timer = undefined;
    try {
      write();
    } catch {
      // over quota: keep the newer half and try once more
      ids = new Set(Array.from(ids).slice(ids.size >> 1));
      try {
        write();
      } catch {
        /* memory still works for this session */
      }
    }
  };

  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return;
      ids.add(id);
      if (ids.size > MAX_SEEN) ids.delete(ids.values().next().value as string); // oldest
      if (timer === undefined) timer = window.setTimeout(save, SAVE_MS);
    },
    size: () => ids.size,
    clear() {
      ids.clear();
      save();
    },
    flush() {
      if (timer !== undefined) save();
    },
  };
}

function load(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
