// Network transport for relayer HTTP traffic.
//
// "direct"  -> plain window.fetch (relayer / Railway / Vercel edges see the user's IP).
// "mixnet"  -> requests are tunnelled through the Nym mixnet with @nymproject/mix-fetch,
//              so the relayer only ever sees a Nym exit (IPR) address, never the user's IP.
//
// The Nym SDK (~18 MB: wasm + worker inlined as base64) is loaded with a dynamic import
// ONLY when mixnet mode is enabled, so the default bundle is unaffected.
//
// WebSockets cannot go through mixFetch, so in mixnet mode streamSupported() is false and the
// app should poll GET /v1/messages?since= every POLL_INTERVAL_MS through pfetch instead.

export type PrivacyMode = "direct" | "mixnet";
export type MixnetStatus = "off" | "connecting" | "ready" | "error";

const MODE_KEY = "pispt:privacy-mode";
/** Poll interval for /v1/messages when the WebSocket stream is unavailable (mixnet mode). */
export const POLL_INTERVAL_MS = 4000;
/** Give up on tunnel setup after this long (first connect fetches topology + finds an exit). */
const SETUP_TIMEOUT_MS = 90_000;

type MixFetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type MixModule = typeof import("@nymproject/mix-fetch");

// ---------------- mode (persisted) ----------------
function readMode(): PrivacyMode {
  try {
    return localStorage.getItem(MODE_KEY) === "mixnet" ? "mixnet" : "direct";
  } catch {
    return "direct";
  }
}

let mode: PrivacyMode = readMode();
const modeListeners = new Set<(m: PrivacyMode) => void>();

export function getPrivacyMode(): PrivacyMode {
  return mode;
}

export function setPrivacyMode(m: PrivacyMode): void {
  if (m === mode) return;
  mode = m;
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* private window / storage blocked: mode still applies for this tab */
  }
  if (m === "mixnet") {
    void ensureTunnel().catch(() => {});
  } else {
    // We keep the tunnel object alive (Nym's disconnect makes the wasm unusable until a page
    // reload), but stop routing through it. Status reads "off" while in direct mode.
    setStatus("off");
  }
  modeListeners.forEach((cb) => cb(m));
}

/** Subscribe to mode changes. Returns an unsubscribe function. */
export function onPrivacyModeChange(cb: (m: PrivacyMode) => void): () => void {
  modeListeners.add(cb);
  return () => modeListeners.delete(cb);
}

/** False in mixnet mode: the WebSocket would bypass the mixnet, so fall back to polling. */
export function streamSupported(): boolean {
  return mode !== "mixnet";
}

// ---------------- mixnet status ----------------
let status: MixnetStatus = "off";
let lastError: string | null = null;
const statusListeners = new Set<(s: MixnetStatus) => void>();

function setStatus(s: MixnetStatus, err?: string) {
  lastError = s === "error" ? err ?? "Mixnet connection failed" : null;
  if (s === status) return;
  status = s;
  statusListeners.forEach((cb) => cb(s));
}

export function mixnetStatus(): MixnetStatus {
  return status;
}

/** Human-readable reason for the last "error" status (or null). */
export function mixnetError(): string | null {
  return lastError;
}

/** Subscribe to mixnet status changes. Returns an unsubscribe function. */
export function onMixnetStatusChange(cb: (s: MixnetStatus) => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

// ---------------- tunnel lifecycle ----------------
let tunnel: Promise<MixFetchFn> | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function ensureTunnel(): Promise<MixFetchFn> {
  if (tunnel) {
    if (mode === "mixnet" && status === "off") setStatus("connecting");
    // Re-flag ready once the existing promise settles (covers direct -> mixnet -> direct -> mixnet).
    tunnel.then(() => { if (mode === "mixnet") setStatus("ready"); }, () => {});
    return tunnel;
  }
  setStatus("connecting");
  const p = (async () => {
    const mod: MixModule = await import("@nymproject/mix-fetch");
    await withTimeout(mod.setupMixTunnel({}), SETUP_TIMEOUT_MS, "Mixnet setup");
    const st = await mod.getTunnelState();
    if (st.state === "failed") throw new Error(`Mixnet tunnel failed (${st.reason.kind})`);
    return mod.mixFetch as MixFetchFn;
  })();
  tunnel = p;
  p.then(
    () => { if (mode === "mixnet") setStatus("ready"); },
    (e: unknown) => {
      tunnel = null; // allow a retry on the next request / toggle
      if (mode === "mixnet") setStatus("error", e instanceof Error ? e.message : String(e));
    },
  );
  return p;
}

// A tunnel can come up "ready" but land on a dead exit (observed in testing: every request then
// times out after ~24s). Nym's tunnel is a per-page singleton, so the only way to get a fresh one
// is a page reload. Track consecutive request failures and surface them as "error".
const MAX_CONSECUTIVE_FAILURES = 2;
let consecutiveFailures = 0;
let needsReload = false;

/** Retry after an "error" status (e.g. from a "Retry" button). May reload the page. */
export function retryMixnet(): void {
  if (mode !== "mixnet") return;
  if (needsReload) { location.reload(); return; }
  void ensureTunnel().catch(() => {});
}

// ---------------- fetch ----------------
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

/** Make a RequestInit structured-clone-safe for the mixnet worker (no Headers / AbortSignal objects). */
function toWorkerInit(init?: RequestInit): RequestInit {
  const headers: Record<string, string> = {};
  if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  // mix-fetch defaults Accept to text/html; the relayer speaks JSON.
  if (!headers["accept"]) headers["accept"] = "application/json";
  const out: RequestInit = { method: init?.method ?? "GET", headers };
  if (init?.body != null) {
    if (typeof init.body !== "string") throw new Error("Mixnet mode only supports string request bodies");
    out.body = init.body;
  }
  return out;
}

/**
 * Drop-in for fetch() for relayer calls. Routes through the Nym mixnet in mixnet mode.
 *
 * In mixnet mode this never silently falls back to a direct request (that would leak the IP);
 * if the tunnel can't come up, the returned promise rejects. Loopback URLs (local dev relayer)
 * are the one exception: a mixnet exit can't reach your localhost, and there's no IP to hide.
 */
export async function pfetch(input: string, init?: RequestInit): Promise<Response> {
  if (mode !== "mixnet") return fetch(input, init);
  let host = "";
  try { host = new URL(input, location.href).hostname; } catch { /* relative / bad URL */ }
  if (LOOPBACK.test(host)) return fetch(input, init);

  const mixFetch = await ensureTunnel();
  if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const req = mixFetch(new URL(input, location.href).toString(), toWorkerInit(init)).then(
    (res) => {
      consecutiveFailures = 0;
      if (needsReload) { needsReload = false; if (mode === "mixnet") setStatus("ready"); }
      return res;
    },
    (e: unknown) => {
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && mode === "mixnet") {
        needsReload = true;
        setStatus("error", `Mixnet requests are failing (${e instanceof Error ? e.message : String(e)}). Reload to pick a new route.`);
      }
      throw e;
    },
  );
  if (!init?.signal) return req;
  const signal = init.signal;
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    req.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// If the user left mixnet mode on, start connecting at load so the first request is faster.
if (mode === "mixnet" && typeof window !== "undefined") void ensureTunnel().catch(() => {});
