import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import bs58 from "bs58";
import { burnerFromSeed, burnerWallet, b64, unb64, type Signer } from "@primar/core";

/** Unified signer used by the whole app. */
export type AppSigner = { publicKey: string; sign(msg: Uint8Array): Promise<Uint8Array> };
export type SessionKind = "burner" | "wallet";
export type Session = { wallet: string; kind: SessionKind; walletName?: string; label: string; secret?: Uint8Array; msgPub?: string };

const BURNER_KEY = "pispt:burnerSeed";
const SESSION_KEY = "pispt:session";

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

let current: Session | null = null;
let signer: AppSigner | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const onSessionChange = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

function persist() {
  if (!current) { ss.del(SESSION_KEY); return; }
  const { secret, ...rest } = current;
  ss.set(SESSION_KEY, JSON.stringify({ ...rest, secret: secret ? b64(secret) : undefined }));
}

// ---------- Burner ----------
function loadBurner() {
  const saved = ls.get(BURNER_KEY);
  if (saved) {
    try { return burnerFromSeed(unb64(saved)); } catch { /* fallthrough */ }
  }
  const w = burnerWallet();
  ls.set(BURNER_KEY, b64(w.seed));
  return w;
}

export function useBurner(): Session {
  const w = loadBurner();
  signer = { publicKey: w.publicKey, sign: async (m) => w.sign(m) };
  current = { wallet: w.publicKey, kind: "burner", label: "Burner (testing)" };
  persist();
  emit();
  return current;
}

export const forgetBurner = () => ls.del(BURNER_KEY);

// ---------- Wallet Standard ----------
const SIGN = "solana:signMessage";
const CONNECT = "standard:connect";

export function listWallets(): Wallet[] {
  return getWallets().get().filter((w) => SIGN in w.features && CONNECT in w.features);
}

type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
type SignFeature = { signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<readonly { signature: Uint8Array }[]> };

async function standardSigner(wallet: Wallet, silent = false): Promise<AppSigner> {
  const { accounts } = await (wallet.features[CONNECT] as ConnectFeature).connect(silent ? { silent: true } : undefined);
  const account = accounts[0] ?? wallet.accounts[0];
  if (!account) throw new Error("No account returned by wallet");
  const publicKey = bs58.encode(new Uint8Array(account.publicKey));
  return {
    publicKey,
    sign: async (message) => {
      const [out] = await (wallet.features[SIGN] as SignFeature).signMessage({ account, message });
      return out.signature;
    },
  };
}

export async function connectWallet(wallet: Wallet): Promise<Session> {
  signer = await standardSigner(wallet);
  current = { wallet: signer.publicKey, kind: "wallet", walletName: wallet.name, label: wallet.name };
  persist();
  emit();
  return current;
}

// ---------- Session ----------
export function restore(): Session | null {
  if (current) return current;
  const raw = ss.get(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Omit<Session, "secret"> & { secret?: string };
    current = { ...s, secret: s.secret ? unb64(s.secret) : undefined };
    if (current.kind === "burner") {
      const w = loadBurner();
      if (w.publicKey !== current.wallet) { current = null; ss.del(SESSION_KEY); return null; }
      signer = { publicKey: w.publicKey, sign: async (m) => w.sign(m) };
    }
    return current;
  } catch {
    return null;
  }
}

export const getSession = () => current ?? restore();
export const hasIdentity = () => !!getSession()?.secret;

/** Signer for the current session; reconnects a Wallet Standard wallet if needed. */
export async function getSigner(): Promise<Signer & AppSigner> {
  const s = getSession();
  if (!s) throw new Error("Not connected");
  if (signer && signer.publicKey === s.wallet) return signer;
  if (s.kind === "wallet") {
    const w = listWallets().find((x) => x.name === s.walletName);
    if (!w) throw new Error(`${s.walletName ?? "Wallet"} not found — reconnect`);
    const sg = await standardSigner(w, true).catch(() => standardSigner(w));
    if (sg.publicKey !== s.wallet) throw new Error("Wallet account changed — reconnect");
    signer = sg;
    return sg;
  }
  useBurner();
  return signer!;
}

export function setIdentity(secret: Uint8Array, msgPub: string) {
  if (!current) return;
  current = { ...current, secret, msgPub };
  persist();
  emit();
}

export function disconnect(opts?: { forgetBurner?: boolean }) {
  current = null;
  signer = null;
  ss.del(SESSION_KEY);
  if (opts?.forgetBurner) forgetBurner();
  emit();
}
