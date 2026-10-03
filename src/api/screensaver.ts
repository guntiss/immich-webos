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
//
// A registration can't be undone: cancelling the subscription leaves the client
// in tvpower's list until the app process exits (checked with getClientList),
// and registering again under the same name fails with "already registered",
// leaving the old, now unanswered, subscription in charge, so the saver started
// mid-show after the viewer was closed and reopened. So the page registers once,
// keeps that subscription for good, and answers every request: ack:false while
// something wants the screen awake, ack:true (let it start) otherwise.

interface PalmBridge {
  onservicecallback: ((body: string) => void) | null;
  call(uri: string, params: string): void;
}

const REGISTER = 'luna://com.webos.service.tvpower/power/registerScreenSaverRequest';
const RESPOND = 'luna://com.webos.service.tvpower/power/responseScreenSaverRequest';
const CLIENT = 'immich-webos-wallpaper';

let sub: PalmBridge | null = null; // the one subscription, for the page's lifetime
let holds = 0; // keepAwake() callers that haven't released yet
const replies = new Set<PalmBridge>(); // kept referenced until each reply is sent

function register(Ctor: new () => PalmBridge): void {
  if (sub) return;
  const s = new Ctor();
  s.onservicecallback = (body: string) => {
    try {
      const msg = JSON.parse(body);
      if (msg.returnValue === false || !msg.timestamp) return;
      // ack:false = "don't let the saver start"; echo back the timestamp we got
      const r = new Ctor();
      replies.add(r);
      r.onservicecallback = () => replies.delete(r);
      r.call(RESPOND, JSON.stringify({ clientName: CLIENT, ack: holds === 0, timestamp: msg.timestamp }));
    } catch {
      // ignore malformed callbacks
    }
  };
  s.call(REGISTER, JSON.stringify({ subscribe: true, clientName: CLIENT }));
  sub = s;
}

// Start holding the screen awake. Returns a stop() that releases it (letting
// the TV's normal screen saver resume).
export function keepAwake(): () => void {
  const Ctor = (window as any).PalmServiceBridge;
  if (!Ctor) return () => {}; // not on webOS
  register(Ctor);
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
  };
}
