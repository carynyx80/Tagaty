// Pispt private payments (Helius Solana Privacy Rings), browser side.
//
// Everything secret stays in this browser: the Rings key is derived from a wallet signature
// (seed = sha256(sign(RINGS_DERIVE_MESSAGE(wallet)))), proofs are requested from the Helius TEE
// prover with requests HPKE-encrypted by the SDK to the attested enclave, and the relayer only
// (a) proxies RPC/indexer/prover traffic so no Helius key ships here, and (b) co-signs as fee payer.
//
// The heavy SDK (@heliuslabs/spr: wasm Poseidon hasher, TEE attestation) is loaded lazily.
import { encodePaymentBody, sealMessage, unb64, verifyRegistration } from "@primar/core";
import { RINGS_DERIVE_MESSAGE } from "@primar/rings/constants";
import { signRingsAddressRecord, verifyRingsAddressRecord, type RingsAddressRecord } from "@primar/rings/directory";
import type { Address, Transaction } from "@solana/kit";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { RELAYER } from "./real";
import { getSession, getSigner, listWallets } from "./session";
import { pfetch } from "./transport";

/** Relayer traffic honours the user's privacy mode (direct or Nym mixnet). */
const rfetch: typeof globalThis.fetch = (input, init) =>
  pfetch(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init);

type RingsClientModule = typeof import("@primar/rings/client");
type RingsContext = import("@primar/rings/client").RingsContext;

const loadRings = (() => {
  let p: Promise<RingsClientModule> | null = null;
  return () => (p ??= import("@primar/rings/client"));
})();

// ---------------------------------------------------------------- amounts (base units)

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Exact decimal SOL string -> lamports. Throws on anything ambiguous. */
export function parseSol(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error("Enter an amount like 0.25 (max 9 decimals)");
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, "0"));
}

export function formatSol(lamports: bigint): string {
  const neg = lamports < 0n;
  const v = neg ? -lamports : lamports;
  const whole = v / LAMPORTS_PER_SOL;
  const frac = (v % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Per-action cap for sends and deposits. */
export const maxPerPayment = (network: string) => (network === "mainnet" ? LAMPORTS_PER_SOL : 10n * LAMPORTS_PER_SOL);

// ---------------------------------------------------------------- relayer helpers

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await rfetch(RELAYER + path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export type RingsStatus = { enabled: boolean; network: string; reason?: string; feePayer?: string };

export async function getPaymentsStatus(): Promise<RingsStatus> {
  try {
    return await http<RingsStatus>("/v1/rings/status");
  } catch (e) {
    return { enabled: false, network: "unknown", reason: `Relayer unreachable: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------- local key cache

const seedKey = (w: string) => `pispt:rings:seed:${w}`;
const recordKey = (w: string) => `pispt:rings:record:${w}`;
const b64 = (u: Uint8Array) => { let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

let ctxCache: { wallet: string; ctx: RingsContext } | null = null;

function requireWallet(): string {
  const s = getSession();
  if (!s) throw new Error("Connect a wallet first");
  return s.wallet;
}

async function buildContext(seed: Uint8Array, status: RingsStatus): Promise<RingsContext> {
  if (!status.feePayer) throw new Error("Relayer did not report its fee-payer address");
  if (status.network !== "mainnet" && status.network !== "devnet") throw new Error(`Unsupported network ${status.network}`);
  const rings = await loadRings();
  const client = await rings.createRingsClient({ network: status.network, relayerUrl: RELAYER, fetch: rfetch });
  const account = await rings.ringsAccountFromSeed(seed as Parameters<RingsClientModule["ringsAccountFromSeed"]>[0], client);
  return { relayerUrl: RELAYER, client, feePayer: status.feePayer, account };
}

/** Context from this tab's cached Rings key, or null if the user must (re)enable. No prompts. */
export async function restorePayments(status: RingsStatus): Promise<RingsContext | null> {
  const wallet = requireWallet();
  if (ctxCache?.wallet === wallet) return ctxCache.ctx;
  const saved = ss.get(seedKey(wallet));
  if (!saved) return null;
  const ctx = await buildContext(unb64(saved), status);
  ctxCache = { wallet, ctx };
  republishAddress().catch(() => {});
  return ctx;
}

/** Was private payments enabled by this wallet before (on this device)? */
export const enabledBefore = () => {
  const s = getSession();
  return !!(s && ls.get(recordKey(s.wallet)));
};

/** Re-PUT the cached signed directory record (relayer storage may be reset on redeploys). */
export async function republishAddress(): Promise<void> {
  const s = getSession();
  const raw = s && ls.get(recordKey(s.wallet));
  if (!raw) return;
  await http("/v1/rings/address", { method: "PUT", body: raw }).catch((e: { status?: number }) => {
    if (e.status !== 409) throw e;
  });
}

export type Step = (msg: string) => void;

/**
 * First-time setup: one signature to derive the Rings key, an on-chain registry entry
 * (sponsored), and a wallet-signed directory record so contacts can pay you.
 */
export async function enablePrivatePayments(status: RingsStatus, step: Step): Promise<RingsContext> {
  const wallet = requireWallet();
  const signer = await getSigner();
  step("Sign in your wallet to derive your private payments key…");
  const sig = await signer.sign(new TextEncoder().encode(RINGS_DERIVE_MESSAGE(wallet)));
  const rings = await loadRings();
  const seed = await rings.deriveRingsSeed(sig);
  step("Loading Privacy Rings…");
  const ctx = await buildContext(seed, status);
  step("Registering your Rings address on Solana (fee paid by Pispt)…");
  if (!(await rings.isRegisteredForRings(ctx))) await rings.registerForRings(ctx);
  // Directory record (wallet -> Rings owner). Reuse a cached one if it still matches.
  let record: RingsAddressRecord | null = null;
  try { record = JSON.parse(ls.get(recordKey(wallet)) ?? "null") as RingsAddressRecord | null; } catch { record = null; }
  if (!record || record.ringsOwner !== ctx.account.owner || record.wallet !== wallet) {
    step("Sign once more to publish your Rings address to your contacts…");
    record = await signRingsAddressRecord(signer, ctx.account.owner);
  }
  await http("/v1/rings/address", { method: "PUT", body: JSON.stringify(record) }).catch((e: { status?: number }) => {
    if (e.status !== 409) throw e;
  });
  ls.set(recordKey(wallet), JSON.stringify(record));
  ss.set(seedKey(wallet), b64(seed));
  ctxCache = { wallet, ctx };
  return ctx;
}

export function forgetPaymentsKey() {
  const s = getSession();
  if (s) ss.del(seedKey(s.wallet));
  ctxCache = null;
}

// ---------------------------------------------------------------- balances

export type Balances = { privateLamports: bigint; pendingPublicLamports: bigint };

export async function getBalances(ctx: RingsContext): Promise<Balances> {
  const rings = await loadRings();
  const [priv, pending] = await Promise.all([rings.getPrivateBalance({ ctx }), rings.getOwnerPublicBalance(ctx)]);
  return { privateLamports: priv.sol, pendingPublicLamports: pending };
}

// ---------------------------------------------------------------- main-wallet signing

type SignTxFeature = {
  supportedTransactionVersions?: readonly (string | number)[];
  signTransaction(...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]): Promise<readonly { signedTransaction: Uint8Array }[]>;
};
type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };

/** Main wallet signs a legacy transaction (Wallet Standard `solana:signTransaction`; burner on devnet). */
async function signWithMainWallet(tx: Transaction, network: string): Promise<Transaction> {
  const kit = await import("@solana/kit");
  const s = getSession();
  if (!s) throw new Error("Not connected");
  const wire = new Uint8Array(kit.getTransactionEncoder().encode(tx));
  let signature: Uint8Array;
  if (s.kind === "burner") {
    if (network === "mainnet") throw new Error("Burner wallets can't add funds on mainnet. Connect a real wallet.");
    const signer = await getSigner();
    signature = await signer.sign(Uint8Array.from(tx.messageBytes));
  } else {
    const w: Wallet | undefined = listWallets().find((x) => x.name === s.walletName);
    if (!w) throw new Error(`${s.walletName ?? "Wallet"} not found. Please reconnect.`);
    const feat = w.features["solana:signTransaction"] as SignTxFeature | undefined;
    if (!feat) throw new Error(`${w.name} can't sign transactions (no solana:signTransaction)`);
    const connect = w.features["standard:connect"] as ConnectFeature;
    const { accounts } = await connect.connect({ silent: true }).catch(() => connect.connect());
    const account = [...accounts, ...w.accounts].find((a) => kit.getBase58Decoder().decode(new Uint8Array(a.publicKey)) === s.wallet);
    if (!account) throw new Error("Wallet account changed. Please reconnect.");
    const [out] = await feat.signTransaction({ account, transaction: wire, chain: `solana:${network}` });
    const signed = kit.getTransactionDecoder().decode(out.signedTransaction);
    const same = signed.messageBytes.length === tx.messageBytes.length && signed.messageBytes.every((b, i) => b === tx.messageBytes[i]);
    if (!same) throw new Error("Your wallet modified the transaction; refusing to submit it");
    const sig = signed.signatures[s.wallet as Address];
    if (!sig) throw new Error("Wallet did not return a signature");
    signature = sig;
  }
  return { ...tx, signatures: { ...tx.signatures, [s.wallet]: signature } } as Transaction;
}

// ---------------------------------------------------------------- actions

/** "Add funds": PUBLIC top-up main wallet -> Rings owner, then deposit into the ring. */
export async function addFunds(ctx: RingsContext, lamports: bigint, network: string, step: Step): Promise<{ topUp: string; deposit: string }> {
  const rings = await loadRings();
  if (lamports < rings.MIN_TOPUP_LAMPORTS) throw new Error(`Minimum is ${formatSol(rings.MIN_TOPUP_LAMPORTS)} SOL`);
  if (lamports > maxPerPayment(network)) throw new Error(`Maximum is ${formatSol(maxPerPayment(network))} SOL per deposit`);
  const wallet = requireWallet();
  step("Approve the transfer from your wallet (fee paid by Pispt)…");
  const unsigned = await rings.buildTopUpTransaction({ ctx, from: wallet, lamports });
  const signed = await signWithMainWallet(unsigned, network);
  step("Sending SOL to your Rings account…");
  const { signature: topUp } = await rings.submitSponsored(ctx.relayerUrl, rings.toSponsorable(signed));
  await rings.waitForConfirmation(ctx.client, topUp as never);
  step("Depositing into Privacy Rings…");
  const { signature: deposit } = await rings.depositToRing({ ctx, amount: lamports });
  return { topUp, deposit };
}

/** Deposit SOL already sitting at the Rings owner address (e.g. after an interrupted add-funds). */
export async function depositPending(ctx: RingsContext, lamports: bigint, step: Step): Promise<string> {
  const rings = await loadRings();
  step("Depositing into Privacy Rings…");
  return (await rings.depositToRing({ ctx, amount: lamports })).signature;
}

/** Return SOL sitting at the Rings owner address to the main wallet. */
export async function returnPending(ctx: RingsContext, lamports: bigint, step: Step): Promise<string> {
  const rings = await loadRings();
  step("Returning SOL to your wallet…");
  const tx = await rings.buildSweepToWalletTransaction({ ctx, to: requireWallet(), lamports });
  const { signature } = await rings.submitSponsored(ctx.relayerUrl, tx);
  await rings.waitForConfirmation(ctx.client, signature);
  return signature;
}

/** Look up and verify a contact's Rings address (wallet-signed record). */
export async function lookupRingsAddress(wallet: string): Promise<string | null> {
  try {
    const rec = await http<RingsAddressRecord>(`/v1/rings/address/${wallet}`);
    if (rec.wallet !== wallet || !(await verifyRingsAddressRecord(rec))) throw new Error("Rings address record failed verification");
    return rec.ringsOwner;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

const proofs = new Map<string, { lamports: bigint; signature: string }>();

/** Confidential transfer to a contact. On success the proof is queued for the chat announcement. */
export async function sendPrivately(ctx: RingsContext, toWallet: string, lamports: bigint, network: string, step: Step): Promise<string> {
  if (lamports <= 0n) throw new Error("Amount must be positive");
  if (lamports > maxPerPayment(network)) throw new Error(`Maximum is ${formatSol(maxPerPayment(network))} SOL per payment`);
  step("Looking up their Rings address…");
  const ringsOwner = await lookupRingsAddress(toWallet);
  if (!ringsOwner) throw new Error("They haven't enabled private payments yet. Ask them to open Pay once.");
  const rings = await loadRings();
  step("Syncing your private balance and generating the zero-knowledge proof (can take a while)…");
  const tx = await rings.buildPrivateTransfer({ ctx, recipient: ringsOwner, amount: lamports });
  step("Submitting (fee paid by Pispt)…");
  const { signature } = await rings.submitSponsored(ctx.relayerUrl, tx);
  step("Waiting for confirmation…");
  await ctx.client.confirmTransaction(signature);
  proofs.set(toWallet, { lamports, signature });
  return signature;
}

export async function withdrawToWallet(ctx: RingsContext, lamports: bigint, step: Step): Promise<string> {
  if (lamports <= 0n) throw new Error("Amount must be positive");
  const rings = await loadRings();
  step("Generating the withdrawal proof…");
  const { signature } = await rings.withdrawFromRing({ ctx, recipient: requireWallet(), amount: lamports });
  return signature;
}

// ---------------------------------------------------------------- chat announcement

/**
 * Seal and post a kind:"payment" chat message for the confirmed transfer queued by
 * sendPrivately(). Throws if there is no confirmed transfer (never announces a fake payment).
 */
export async function sendPaymentEnvelope(chatId: string): Promise<{ id: string; ts: number; signature: string | null; body: string; ringsSignature: string }> {
  const proof = proofs.get(chatId);
  if (!proof) throw new Error("No confirmed private transfer to announce");
  const s = getSession();
  if (!s?.secret) throw new Error("Not signed in");
  const rec = await http<{ wallet: string; msgPub: string; sig: string }>(`/v1/keys/${chatId}`);
  if (rec.wallet !== chatId || !verifyRegistration(rec)) throw new Error("Recipient key record failed verification");
  const body = encodePaymentBody({ mint: "SOL", amount: proof.lamports.toString(), ringsSignature: proof.signature });
  const ts = Date.now();
  const wires = sealMessage({ senderWallet: s.wallet, senderSecret: s.secret, recipientMsgPub: unb64(rec.msgPub), text: body, kind: "payment", ts });
  let first: { id: string; signature: string | null; ts: number } | null = null;
  for (const envelope of wires) {
    const r = await http<{ id: string; signature: string | null; ts: number }>("/v1/messages", { method: "POST", body: JSON.stringify({ envelope }) });
    first ??= r;
  }
  proofs.delete(chatId);
  return { id: first!.id, ts, signature: first!.signature, body, ringsSignature: proof.signature };
}
