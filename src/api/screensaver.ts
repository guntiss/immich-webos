// Keep the webOS TV screen saver from kicking in during the wallpaper show.
//
// There's no public per-app "disable screensaver" API. The working approach
// (undocumented, but the standard one, also used by LG's own apps) is to
// subscribe to the tvpower service's registerScreenSaverRequest and veto each
// request by replying to responseScreenSaverRequest with ack:false. A request
// is a subscription message carrying a timestamp, e.g.
//   {"returnValue":true,"timestamp":"3066361491","instantBoot":"on"}
// The event re-fires on each idle timeout, so this holds the saver off for as
// long as we stay subscribed. No-op off webOS (dev browser has no bridge).
//
// Every registered client must answer within a few seconds. A client that
// doesn't makes tvpowerd file a fault, and after any fault the TV's next power
// off skips Always Ready and powers down fully, so the TV cold boots next time.
// That's why we answer every request and drop the registration while the page
// is hidden (a backgrounded page can be suspended and couldn't answer).

interface PalmBridge {
  onservicecallback: ((body: string) => void) | null;
  call(uri: string, params: string): void;
  cancel?(): void;
}

const REGISTER = 'luna://com.webos.service.tvpower/power/registerScreenSaverRequest';
const RESPOND = 'luna://com.webos.service.tvpower/power/responseScreenSaverRequest';
const CLIENT = 'immich-webos-wallpaper';

// Start holding the screen awake. Returns a stop() that releases it (letting
// the TV's normal screen saver resume).
export function keepAwake(): () => void {
  const Ctor = (window as any).PalmServiceBridge;
  if (!Ctor) return () => {}; // not on webOS

  let sub: PalmBridge | null = null;
  let resp: PalmBridge | null = null; // kept referenced until the reply is sent

  const register = () => {
    if (sub) return;
    const s: PalmBridge = new Ctor();
    s.onservicecallback = (body: string) => {
      try {
        const msg = JSON.parse(body);
        if (msg.returnValue === false || !msg.timestamp) return;
        // ack:false = "don't let the saver start"; echo back the timestamp we got
        const r: PalmBridge = new Ctor();
        r.onservicecallback = () => {
          if (resp === r) resp = null;
        };
        resp = r;
        r.call(RESPOND, JSON.stringify({ clientName: CLIENT, ack: false, timestamp: msg.timestamp }));
      } catch {
        // ignore malformed callbacks
      }
    };
    s.call(REGISTER, JSON.stringify({ subscribe: true, clientName: CLIENT }));
    sub = s;
  };

  const unregister = () => {
    if (!sub) return;
    try {
      sub.cancel?.();
    } catch {
      // ignore
    }
    sub.onservicecallback = null;
    sub = null;
  };

  const onVisibility = () => (document.hidden ? unregister() : register());
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    unregister();
  };
}
