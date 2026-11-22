import {
  setupMessagingIdentity, verifyRegistration, sealMessage, openMessage, checkSender, reassemble, signProfile,
  parsePaymentBody, unb64, shortAddress, verifyProfile, type Opened,
} from "@primar/core";
import type { PrimarApi, Chat, Message, Profile, Status } from "../api";
import { getSession, getSigner, setIdentity, disconnect as endSession } from "./session";

export const RELAYER: string = (import.meta.env.VITE_RELAYER_URL as string | undefined) ?? "http://127.0.0.1:8787";

type KeyRecord = { wallet: string; msgPub: string; sig: string };
type Item = { id: string; envelope: string; signature: string | null; ts: number };
type Stored = { id: string; other: string; fromMe: boolean; kind: "text" | "payment"; body: string; ts: number; sig: string | null };
type Store = { cursor: string | null; messages: Stored[]; read: Record<string, number>; started: string[] };

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(RELAYER + path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

// ---------------- local store (per wallet) ----------------
const storeKey = (w: string) => `pispt:store:${w}`;
const emptyStore = (): Store => ({ cursor: null, messages: [], read: {}, started: [] });
let store: Store = emptyStore();
let storeWallet: string | null = null;

function loadStore(): Store {
  const s = getSession();
  if (!s) return emptyStore();
  if (storeWallet === s.wallet) return store;
  storeWallet = s.wallet;
  try {
    const raw = localStorage.getItem(storeKey(s.wallet));
    store = raw ? { ...emptyStore(), ...(JSON.parse(raw) as Store) } : emptyStore();
  } catch {
    store = emptyStore();
  }
  return store;
}
function saveStore() {
  if (!storeWallet) return;
  try { localStorage.setItem(storeKey(storeWallet), JSON.stringify(store)); } catch { /* quota / private mode */ }
}

// ---------------- change notifications ----------------
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// ---------------- key directory ----------------
const keyCache = new Map<string, Promise<KeyRecord | null>>();
function getKey(wallet: string): Promise<KeyRecord | null> {
  let p = keyCache.get(wallet);
  if (!p) {
    p = http<KeyRecord>(`/v1/keys/${wallet}`)
      .then((r) => (verifyRegistration(r) && r.wallet === wallet ? r : null))
      .catch((e) => { keyCache.delete(wallet); if (e instanceof ApiError && e.status === 404) return null; throw e; });
    keyCache.set(wallet, p);
  }
  return p;
}

// ---------------- receiving ----------------
const pending: Opened[] = [];
const partSig = new Map<string, string | null>();

async function ingest(items: Item[]) {
  const s = getSession();
  if (!s?.secret) return;
  loadStore();
  let changed = false;
  for (const it of items) {
    const opened = openMessage({ wire: it.envelope, mySecret: s.secret });
    if (!opened) continue;
    const rec = await getKey(opened.from).catch(() => null);
    if (!checkSender(opened, rec)) continue;
    pending.push(opened);
    const k = `${opened.from}:${opened.id}`;
    if (!partSig.has(k) || opened.part === 0) partSig.set(k, it.signature);
  }
  for (const m of reassemble(pending)) {
    const id = `${m.from}:${m.id}`;
    for (let i = pending.length - 1; i >= 0; i--) if (`${pending[i].from}:${pending[i].id}` === id) pending.splice(i, 1);
    if (store.messages.some((x) => x.id === id)) continue;
    store.messages.push({ id, other: m.from, fromMe: false, kind: m.kind === "payment" ? "payment" : "text", body: m.body, ts: m.ts, sig: partSig.get(id) ?? null });
    changed = true;
  }
  if (changed) store.messages.sort((a, b) => a.ts - b.ts);
  return changed;
}

let syncing: Promise<void> | null = null;
async function syncHistory() {
  if (syncing) return syncing;
  syncing = (async () => {
    loadStore();
    for (let guard = 0; guard < 50; guard++) {
      const q = store.cursor ? `?since=${encodeURIComponent(store.cursor)}` : "";
      const { items, cursor } = await http<{ items: Item[]; cursor: string | null }>(`/v1/messages${q}`);
      await ingest(items);
      if (cursor) store.cursor = cursor;
      saveStore();
      if (items.length < 200 || !cursor) break;
    }
    emit();
  })().finally(() => { syncing = null; });
  return syncing;
}

let ws: WebSocket | null = null;
let wsWallet: string | null = null;
let backoff = 1000;
function connectStream() {
  const s = getSession();
  if (!s?.secret || (ws && wsWallet === s.wallet)) return;
  wsWallet = s.wallet;
  const url = RELAYER.replace(/^http/, "ws") + "/v1/stream";
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => { backoff = 1000; syncHistory().catch(() => {}); };
  sock.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type: string; item?: Item };
      if (msg.type !== "message" || !msg.item) return;
      loadStore();
      const changed = await ingest([msg.item]);
      store.cursor = msg.item.id;
      saveStore();
      if (changed) emit();
    } catch { /* ignore malformed */ }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (!getSession()?.secret || wsWallet !== getSession()?.wallet) return;
    setTimeout(connectStream, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
}
function stopStream() {
  const s = ws;
  ws = null;
  wsWallet = null;
  s?.close();
}

let booted: string | null = null;
function ensureBoot() {
  const s = getSession();
  if (!s?.secret || booted === s.wallet) return;
  booted = s.wallet;
  syncHistory().catch(() => {});
  connectStream();
}

// ---------------- helpers ----------------
const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const diff = (now.getTime() - ts) / 86400000;
  if (diff < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

function toMessage(m: Stored): Message {
  if (m.kind === "payment") {
    const p = parsePaymentBody(m.body);
    const token = p?.mint === "SOL" ? "SOL" : "USDC";
    const amount = p ? Number(p.amount) / (token === "SOL" ? 1e9 : 1e6) : 0;
    return { id: m.id, chatId: m.other, fromMe: m.fromMe, kind: "payment", body: "", amount, token, time: fmtTime(m.ts), sig: m.sig ?? p?.ringsSignature ?? null };
  }
  return { id: m.id, chatId: m.other, fromMe: m.fromMe, kind: "text", body: m.body, time: fmtTime(m.ts), sig: m.sig };
}

function preview(m: Stored) {
  if (m.kind === "payment") return m.fromMe ? "Sent a private payment" : "Received a private payment";
  return (m.fromMe ? "You: " : "") + m.body;
}

// ---------------- API ----------------
export const realApi: PrimarApi = {
  mode: "real",

  me() {
    const s = getSession();
    return { address: s?.wallet ?? "", label: s ? shortAddress(s.wallet) : "" };
  },

  async getStatus(): Promise<Status> {
    const [health, rings] = await Promise.all([
      http<{ mode: "onchain" | "local"; network: string }>("/v1/health").catch(() => null),
      http<{ enabled: boolean; reason?: string }>("/v1/rings/status").catch(() => ({ enabled: false, reason: "Relayer unreachable" })),
    ]);
    return { network: health?.network ?? "devnet", mode: health ? health.mode : "offline", rings };
  },

  subscribe(cb) {
    listeners.add(cb);
    ensureBoot();
    return () => { listeners.delete(cb); };
  },

  async listChats() {
    ensureBoot();
    const st = loadStore();
    const byOther = new Map<string, Stored[]>();
    for (const w of st.started) byOther.set(w, []);
    for (const m of st.messages) {
      const arr = byOther.get(m.other) ?? [];
      arr.push(m);
      byOther.set(m.other, arr);
    }
    const chats: (Chat & { last: number })[] = [];
    for (const [other, msgs] of byOther) {
      const last = msgs[msgs.length - 1];
      const readTs = st.read[other] ?? 0;
      chats.push({
        id: other,
        address: other,
        label: shortAddress(other),
        lastMessage: last ? preview(last) : "New private chat",
        time: last ? fmtTime(last.ts) : "",
        unread: msgs.filter((m) => !m.fromMe && m.ts > readTs).length,
        last: last?.ts ?? Number.MAX_SAFE_INTEGER,
      });
    }
    return chats.sort((a, b) => b.last - a.last).map(({ last: _l, ...c }) => c);
  },

  async listMessages(chatId) {
    return loadStore().messages.filter((m) => m.other === chatId).map(toMessage);
  },

  markRead(chatId) {
    const st = loadStore();
    st.read[chatId] = Date.now();
    saveStore();
  },

  async sendText(chatId, body) {
    const s = getSession();
    if (!s?.secret) throw new Error("Not signed in");
    const rec = await getKey(chatId);
    if (!rec) throw new Error("This wallet hasn't joined Pispt yet.");
    const wires = sealMessage({ senderWallet: s.wallet, senderSecret: s.secret, recipientMsgPub: unb64(rec.msgPub), text: body });
    let first: { id: string; signature: string | null; ts: number } | null = null;
    for (const envelope of wires) {
      const r = await http<{ id: string; signature: string | null; ts: number }>("/v1/messages", { method: "POST", body: JSON.stringify({ envelope }) });
      first ??= r;
    }
    const st = loadStore();
    const stored: Stored = { id: `me:${first!.id}`, other: chatId, fromMe: true, kind: "text", body, ts: first!.ts || Date.now(), sig: first!.signature };
    st.messages.push(stored);
    st.read[chatId] = Date.now();
    saveStore();
    emit();
    return toMessage(stored);
  },

  async sendPayment() {
    // TODO: wire @primar/rings client once Helius Privacy Rings is enabled on the relayer.
    throw new Error("Private payments switch on once the Helius Privacy Rings key is configured.");
  },

  async startChat(address) {
    const rec = await getKey(address);
    if (!rec) throw new Error("This wallet hasn't joined Pispt yet.");
    const st = loadStore();
    if (!st.started.includes(address)) st.started.push(address);
    saveStore();
    emit();
    return { id: address, address, label: shortAddress(address), lastMessage: "New private chat", time: "", unread: 0 };
  },

  async deriveKey() {
    const signer = await getSigner();
    const { secret, record } = await setupMessagingIdentity(signer);
    await http("/v1/register", { method: "POST", body: JSON.stringify(record) });
    keyCache.delete(record.wallet);
    setIdentity(secret, record.msgPub);
    ensureBoot();
    const profile = await realApi.getProfile(record.wallet);
    return { msgPub: record.msgPub, hasProfile: !!profile };
  },

  async getMyProfile() {
    const s = getSession();
    return s ? realApi.getProfile(s.wallet) : null;
  },

  async saveProfile(p) {
    const s = getSession();
    if (!s) throw new Error("Not connected");
    const signer = await getSigner();
    const profile: Profile = { wallet: s.wallet, username: p.username, updatedAt: Date.now() };
    if (p.displayName) profile.displayName = p.displayName;
    if (p.bio) profile.bio = p.bio;
    if (p.avatar) profile.avatar = p.avatar;
    const sig = await signProfile(signer, profile);
    const r = await http<{ ok: true; profile: Profile }>("/v1/profile", { method: "PUT", body: JSON.stringify({ profile, sig }) });
    return r.profile;
  },

  async checkUsername(raw) {
    const name = raw.trim().toLowerCase();
    const mine = await realApi.getMyProfile().catch(() => null);
    if (mine?.username === name) return { available: true };
    return http<{ available: boolean; reason?: string }>(`/v1/username/${encodeURIComponent(name)}/available`);
  },

  async getProfile(wallet) {
    try {
      const r = await http<{ profile: Profile; sig?: string }>(`/v1/profile/${wallet}`);
      return r.profile && r.sig && r.profile.wallet === wallet && verifyProfile(r.profile, r.sig) ? r.profile : null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },

  async getProfiles(wallets) {
    if (!wallets.length) return [];
    const out: Profile[] = [];
    for (let i = 0; i < wallets.length; i += 100) {
      const r = await http<{ profiles: Profile[]; sigs?: Record<string, string> }>(`/v1/profiles?wallets=${wallets.slice(i, i + 100).join(",")}`);
      out.push(...r.profiles.filter((p) => { const sig = r.sigs?.[p.wallet]; return !!sig && verifyProfile(p, sig); }));
    }
    return out;
  },

  async findByUsername(raw) {
    const name = raw.trim().replace(/^@/, "").toLowerCase();
    try {
      const r = await http<{ wallet: string; profile: Profile; sig?: string }>(`/v1/username/${encodeURIComponent(name)}`);
      return r.profile && r.sig && r.profile.wallet === r.wallet && r.profile.username === name && verifyProfile(r.profile, r.sig) ? r.profile : null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },

  disconnect(opts) {
    stopStream();
    booted = null;
    storeWallet = null;
    store = emptyStore();
    pending.length = 0;
    endSession(opts);
  },
};
