/* Thin client for the real sync backend. The till is served same-origin at /app
   after a server-side cookie gate; its Authorization: Bearer token is the JWT the
   login flow stashed in localStorage["kashikeyo-cloud"] (see site/login.html and
   index.js). We speak the exact existing contract: GET /api/pull?since= →
   {rowver, entities:[{kind,id,data,deleted,rowver}], more}; POST /api/ops
   {ops:[{opId,puts:[{kind,id,data}]}]}; SSE /api/events?token=. */

export type Entity = { kind: string; id: string; data: any; deleted?: boolean; rowver?: number };
export type PullResp = { rowver: number; entities: Entity[]; more?: boolean; storeId?: string };

export function cloud(): { token?: string; slug?: string; register?: string } {
  try { return JSON.parse(localStorage.getItem("kashikeyo-cloud") || "{}"); } catch { return {}; }
}
export const token = () => cloud().token || "";
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

/* Same DJB2-ish hash the till + server use for staff PINs (index.js hashTillPin).
   Not a security boundary — a fast per-shift operator switch. */
export function hashPin(pin: string): string {
  let h = 5381;
  for (const ch of String(pin)) h = (h * 33 ^ ch.charCodeAt(0)) >>> 0;
  return String(h);
}

const headers = () => ({ "Content-Type": "application/json", Authorization: "Bearer " + token() });

export async function pull(since: number): Promise<PullResp> {
  const r = await fetch(`/api/pull?since=${since}`, { headers: headers() });
  if (!r.ok) throw new Error("pull " + r.status);
  return r.json();
}
export async function pushOps(ops: any[], elevation?: string): Promise<any> {
  const h: Record<string, string> = headers();
  if (elevation) h["X-Elevation"] = elevation;
  const r = await fetch("/api/ops", { method: "POST", headers: h, body: JSON.stringify({ ops }) });
  if (!r.ok) throw new Error("ops " + r.status);
  return r.json();
}
export const eventsUrl = () => `/api/events?token=${encodeURIComponent(token())}`;

/* SEC-03: verify the store password server-side for a short-lived elevation
   token that authorises a refund (sent as X-Elevation on the refund op). */
export async function elevate(password: string): Promise<string> {
  const r = await fetch("/api/elevate", { method: "POST", headers: headers(), body: JSON.stringify({ password }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "wrong password");
  return (await r.json()).elevation;
}
