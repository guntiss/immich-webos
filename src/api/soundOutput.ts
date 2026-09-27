// The TV's sound output setting ("tv_speaker", "external_arc",
// "external_optical", "bt_soundbar", ...), kept current by a settings-service
// subscription. Empty off webOS (dev browser has no bridge) or until the first
// reply.

interface PalmBridge {
  onservicecallback: ((body: string) => void) | null;
  call(uri: string, params: string): void;
}

let output = '';
let sub: PalmBridge | null = null; // held so the subscription isn't collected

export function watchSoundOutput(): void {
  const Ctor = (window as any).PalmServiceBridge;
  if (sub || !Ctor) return;
  sub = new Ctor() as PalmBridge;
  sub.onservicecallback = (body: string) => {
    try {
      const v = JSON.parse(body)?.settings?.soundOutput;
      if (typeof v === 'string') output = v;
    } catch {
      // ignore malformed callbacks
    }
  };
  sub.call(
    'luna://com.webos.service.settings/getSystemSettings',
    JSON.stringify({ category: 'sound', keys: ['soundOutput'], subscribe: true }),
  );
}

// Whether sound goes out digitally to a soundbar or receiver (HDMI ARC/eARC,
// optical).
export function digitalSoundOutput(): boolean {
  return /^external_(arc|optical)/.test(output);
}
