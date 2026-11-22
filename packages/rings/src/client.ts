// Browser-facing helpers for Pispt private payments on Solana Privacy Rings.
//
// Every transaction is built with the RELAYER as fee payer, partially signed by the user's
// key(s), then POSTed to {relayer}/v1/rings/sponsor where the relayer validates it, adds its
// fee-payer signature and submits it. Users therefore never need SOL for fees ("gas-free").
//
// Shapes follow the installed @heliuslabs/spr@0.9.0-alpha .d.ts files (buildDepositTransaction,
// buildTransferTransaction, buildWithdrawalTransaction, buildRegistrationTransaction, syncWallet,
// LocalKeys, Wallet, ShieldedKeypair, SignedTeePolicy). They type-check against that package.
// Nothing here has been run against devnet: we had no Helius API key. See UNVERIFIED notes.
import {
  createSprClient,
  buildDepositTransaction,
  buildRegistrationTransaction,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  getPrivateTokenBalances,
  syncWallet,
  LocalKeys,
  ShieldedKeypair,
  SigningKey,
  SOL_MINT,
  Wallet,
  type Bytes32,
  type ShieldedAddress,
  type WalletKeys,
} from "@heliuslabs/spr";
import { SignedTeePolicy, type SprClient } from "@heliuslabs/spr/client";
import { isWalletRegistered } from "@heliuslabs/spr/wallet";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  getBase64EncodedWireTransaction,
  partiallySignTransactionWithSigners,
  type Address,
  type Signature,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import { RINGS_DERIVE_MESSAGE, SPR_ENDPOINTS, SYSTEM_PROGRAM_ID, type RingsNetwork } from "./constants.js";

// ---------------------------------------------------------------------------------------------
// Relayer status

export interface RingsStatus {
  enabled: boolean;
  network: string;
  reason?: string;
  /** Relayer fee-payer address (additive field returned by our route). */
  feePayer?: string;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export async function getRingsStatus(relayerUrl: string): Promise<RingsStatus> {
  const base = trimSlash(relayerUrl);
  try {
    const res = await fetch(`${base}/v1/rings/status`);
    if (!res.ok) return { enabled: false, network: "unknown", reason: `status HTTP ${res.status}` };
    const s = (await res.json()) as RingsStatus;
    if (s.enabled && !s.feePayer) {
      // Fall back to the relayer's health endpoint for its address.
      const h = (await (await fetch(`${base}/v1/health`)).json()) as { relayer?: string | null };
      if (h.relayer) s.feePayer = h.relayer;
    }
    return s;
  } catch (e) {
    return { enabled: false, network: "unknown", reason: `relayer unreachable: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------------------------
// SDK client

export interface CreateRingsClientArgs {
  network: RingsNetwork;
  /** Direct mode: e.g. https://devnet.helius-rpc.com/?api-key=KEY (Node / scripts only). */
  solanaRpcUrl?: string;
  /** Browser mode: route RPC, indexer and prover through the Pispt relayer's /v1/rings proxy,
   *  so no Helius key ships to the browser. All secrets still stay client-side. */
  relayerUrl?: string;
  indexerUrl?: string;
  proverUrl?: string;
  apiKey?: string;
  /** Custom fetch for every SDK HTTP request (e.g. an IP-hiding mixnet transport). */
  fetch?: typeof globalThis.fetch;
}

export async function createRingsClient(args: CreateRingsClientArgs): Promise<SprClient> {
  // proverTee is required for every remote prover: the SDK attests the Nitro enclave and
  // HPKE-encrypts each prover request to it, so a proxy in between can't read proof inputs.
  const proverTee = SignedTeePolicy.forNetwork(args.network);
  if (args.relayerUrl) {
    const base = `${trimSlash(args.relayerUrl)}/v1/rings`;
    return createSprClient({
      solanaRpcUrl: `${base}/rpc`,
      indexerUrl: args.indexerUrl ?? `${base}/spr`,
      proverUrl: args.proverUrl ?? `${base}/spr`,
      proverTee,
      ...(args.fetch ? { fetch: args.fetch } : {}),
    });
  }
  if (!args.solanaRpcUrl) throw new Error("createRingsClient needs relayerUrl or solanaRpcUrl");
  // Helius RPC roots serve indexer + prover under /v1/spr (SDK endpoint.js); else README endpoints.
  const helius = /(^|\.)helius-rpc\.com$/.test(new URL(args.solanaRpcUrl).hostname);
  const ep = SPR_ENDPOINTS[args.network];
  return createSprClient({
    solanaRpcUrl: args.solanaRpcUrl,
    ...(args.indexerUrl || !helius ? { indexerUrl: args.indexerUrl ?? ep.indexerUrl } : {}),
    ...(args.proverUrl || !helius ? { proverUrl: args.proverUrl ?? ep.proverUrl } : {}),
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    proverTee,
  });
}

// ---------------------------------------------------------------------------------------------
// Account (the user's Rings identity)

export interface RingsAccount {
  /** Solana address that owns the shielded notes and is registered in the Rings registry. */
  owner: Address;
  shieldedAddress: ShieldedAddress;
  keys: WalletKeys;
  wallet: Wallet;
  /** Signs as owner/depositor. Fee payer is always the relayer. */
  signer: TransactionPartialSigner;
}

/**
 * Pispt derives a dedicated Rings key from a wallet signature (like the messaging key in
 * @primar/core): the wallet signs RINGS_DERIVE_MESSAGE(wallet) and seed = sha256(signature).
 * Rationale: browser wallets don't expose their seed, and the SDK requires the shielded keypair
 * and the Solana owner signer to share one Ed25519 seed. The resulting owner address is a
 * Pispt-specific Solana address (not the user's main wallet), which is what peers pay to.
 */
export { RINGS_DERIVE_MESSAGE };

export async function deriveRingsSeed(walletSignature: Uint8Array): Promise<Bytes32> {
  const digest = await crypto.subtle.digest("SHA-256", walletSignature as Uint8Array<ArrayBuffer>);
  return new Uint8Array(digest) as Bytes32;
}

export async function ringsAccountFromSeed(seed: Bytes32, client: SprClient): Promise<RingsAccount> {
  const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed));
  const signer = keypair.toSolanaSigner();
  const shieldedAddress = keypair.shieldedAddress();
  return {
    owner: signer.address,
    shieldedAddress,
    keys: LocalKeys.fromKeypair(keypair, client.proofService),
    wallet: new Wallet({ identity: shieldedAddress }),
    signer,
  };
}

// ---------------------------------------------------------------------------------------------
// Sponsored submission

export interface RingsContext {
  relayerUrl: string;
  client: SprClient;
  /** Relayer address from getRingsStatus().feePayer. */
  feePayer: Address | string;
  account: RingsAccount;
}

export interface SponsorableTx {
  transaction: Transaction;
  /** base64 wire transaction (relayer signature slot still empty). */
  wireBase64: string;
}

async function userSign(tx: Transaction, signers: readonly TransactionPartialSigner[]): Promise<SponsorableTx> {
  // Only sign with signers actually required by the tx (fee payer = relayer is left empty).
  const needed = signers.filter((s, i, all) => s.address in tx.signatures && all.findIndex((t) => t.address === s.address) === i);
  const signed = needed.length ? await partiallySignTransactionWithSigners(needed, tx) : tx;
  return { transaction: signed, wireBase64: getBase64EncodedWireTransaction(signed) };
}

export async function submitSponsored(relayerUrl: string, tx: SponsorableTx): Promise<{ signature: Signature }> {
  const res = await fetch(`${trimSlash(relayerUrl)}/v1/rings/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: tx.wireBase64 }),
  });
  const body = (await res.json().catch(() => ({}))) as { signature?: string; error?: string };
  if (!res.ok || !body.signature) throw new Error(body.error ?? `sponsor failed (HTTP ${res.status})`);
  return { signature: body.signature as Signature };
}

/** Wait for landing + indexer, then resync the wallet so the next spend sees fresh UTXOs. */
async function confirmAndSync(ctx: RingsContext, signature: Signature): Promise<bigint> {
  const slot = await ctx.client.confirmTransaction(signature);
  await syncWallet({ client: ctx.client, wallet: ctx.account.wallet, keys: ctx.account.keys, config: { requireSlot: slot } });
  return slot;
}

// ---------------------------------------------------------------------------------------------
// Registration (a recipient must be registered or transfers fail WALLET_RECIPIENT_NOT_REGISTERED)

export async function registerForRings(ctx: RingsContext): Promise<{ signature: Signature | null }> {
  const tx = await buildRegistrationTransaction({
    client: ctx.client,
    owner: ctx.account.owner,
    address: ctx.account.shieldedAddress,
    payer: address(String(ctx.feePayer)), // sponsor funds the record rent + fee
  });
  if (tx === undefined) return { signature: null }; // already registered with these keys
  const { signature } = await submitSponsored(ctx.relayerUrl, await userSign(tx, [ctx.account.signer]));
  await ctx.client.confirmTransaction(signature);
  return { signature };
}

export async function isRegisteredForRings(ctx: Pick<RingsContext, "client" | "account">): Promise<boolean> {
  return isWalletRegistered({ rpc: ctx.client, owner: ctx.account.owner });
}

// ---------------------------------------------------------------------------------------------
// Funding the Rings owner from the user's main wallet (two-step deposit).
//
// SPR builds version-1 transactions, which browser wallets may not sign yet. So "Add funds" is:
//   1. a plain legacy System transfer main wallet -> Rings owner (signed by the main wallet,
//      fee paid by the relayer), then
//   2. a Rings deposit of that SOL, signed in-browser by the Rings owner key (fee: relayer).
// If step 2 fails the SOL simply sits at the Rings owner address: retry the deposit or sweep it
// back with buildSweepToWalletTransaction. Both steps are PUBLIC on-chain.

/** Minimum first top-up: a new system account must stay rent-exempt (~0.00089 SOL). */
export const MIN_TOPUP_LAMPORTS = 1_000_000n;

function systemTransferIx(from: Address, to: Address, lamports: bigint) {
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true); // SystemInstruction::Transfer
  dv.setBigUint64(4, lamports, true);
  return {
    programAddress: address(SYSTEM_PROGRAM_ID),
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

async function legacyTransferTx(client: SprClient, feePayer: Address, from: Address, to: Address, lamports: bigint): Promise<Transaction> {
  const { value: lifetime } = await client.solanaRpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstruction(systemTransferIx(from, to, lamports), m),
  );
  return compileTransaction(msg);
}

/** Step 1: unsigned legacy tx moving `lamports` from the main wallet to the Rings owner. */
export async function buildTopUpTransaction(args: { ctx: RingsContext; from: Address | string; lamports: bigint }): Promise<Transaction> {
  return legacyTransferTx(args.ctx.client, address(String(args.ctx.feePayer)), address(String(args.from)), args.ctx.account.owner, args.lamports);
}

/** Recovery: move SOL sitting at the Rings owner address back to a wallet (owner signs in-browser). */
export async function buildSweepToWalletTransaction(args: { ctx: RingsContext; to: Address | string; lamports: bigint }): Promise<SponsorableTx> {
  const tx = await legacyTransferTx(args.ctx.client, address(String(args.ctx.feePayer)), args.ctx.account.owner, address(String(args.to)), args.lamports);
  return userSign(tx, [args.ctx.account.signer]);
}

/** Public SOL balance of the Rings owner address (funds topped up but not yet deposited). */
export async function getOwnerPublicBalance(ctx: Pick<RingsContext, "client" | "account">): Promise<bigint> {
  return ctx.client.getBalance(ctx.account.owner);
}

/** Wrap a transaction already signed elsewhere (e.g. by a Wallet Standard wallet). */
export function toSponsorable(transaction: Transaction): SponsorableTx {
  return { transaction, wireBase64: getBase64EncodedWireTransaction(transaction) };
}

/** Wait until a sponsored legacy/v0 tx is confirmed (polls signature status through the RPC). */
export async function waitForConfirmation(client: SprClient, signature: Signature, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { value } = await client.solanaRpc.getSignatureStatuses([signature]).send();
    const st = value[0];
    if (st?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(st.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("timed out waiting for confirmation");
}

// ---------------------------------------------------------------------------------------------
// Deposit (PUBLIC: amount and depositor are visible on-chain)

export interface DepositArgs {
  ctx: RingsContext;
  /** lamports */
  amount: bigint;
  /** Who funds the deposit. Defaults to the Rings owner address (must then hold SOL).
   *  Pass the user's main wallet as a kit TransactionPartialSigner to deposit straight from it.
   *  UNVERIFIED: browser wallets signing version-1 transactions. */
  depositor?: TransactionPartialSigner;
}

export async function depositToRing({ ctx, amount, depositor }: DepositArgs): Promise<{ signature: Signature; slot: bigint }> {
  const from = depositor ?? ctx.account.signer;
  const tx = await buildDepositTransaction({
    client: ctx.client,
    feePayer: address(String(ctx.feePayer)),
    depositor: from.address,
    recipient: ctx.account.shieldedAddress,
    amount,
  });
  const { signature } = await submitSponsored(ctx.relayerUrl, await userSign(tx, [from]));
  return { signature, slot: await confirmAndSync(ctx, signature) };
}

// ---------------------------------------------------------------------------------------------
// Private transfer (amount hidden; sender/recipient owner addresses public in the default ring)

export interface PrivateTransferArgs {
  ctx: RingsContext;
  /** Recipient's registered Rings owner address. */
  recipient: Address | string;
  /** lamports */
  amount: bigint;
}

/** Sync, prove and build a transfer; returns the user-signed tx ready for the relayer. */
export async function buildPrivateTransfer({ ctx, recipient, amount }: PrivateTransferArgs): Promise<SponsorableTx> {
  await syncWallet({ client: ctx.client, wallet: ctx.account.wallet, keys: ctx.account.keys });
  // Sponsored fees: feePayer != owner, so the owner is listed as a required signer (SDK README "Sponsored fees").
  const tx = await buildTransferTransaction({
    client: ctx.client,
    wallet: ctx.account.wallet,
    keys: ctx.account.keys,
    feePayer: address(String(ctx.feePayer)),
    recipient: address(String(recipient)),
    asset: SOL_MINT,
    amount,
  });
  return userSign(tx, [ctx.account.signer]);
}

export async function sendPrivateTransfer(args: PrivateTransferArgs): Promise<{ signature: Signature; slot: bigint }> {
  const tx = await buildPrivateTransfer(args);
  const { signature } = await submitSponsored(args.ctx.relayerUrl, tx);
  return { signature, slot: await confirmAndSync(args.ctx, signature) };
}

/** Body for a Pispt `kind:"payment"` message (CONTRACT §1). */
export function paymentMessageBody(amount: bigint, ringsSignature: string): string {
  return JSON.stringify({ mint: "SOL", amount: amount.toString(), ringsSignature });
}

// ---------------------------------------------------------------------------------------------
// Withdraw (private -> public Solana address)

export interface WithdrawArgs {
  ctx: RingsContext;
  recipient: Address | string;
  amount: bigint;
}

export async function withdrawFromRing({ ctx, recipient, amount }: WithdrawArgs): Promise<{ signature: Signature; slot: bigint }> {
  await syncWallet({ client: ctx.client, wallet: ctx.account.wallet, keys: ctx.account.keys });
  const tx = await buildWithdrawalTransaction({
    client: ctx.client,
    wallet: ctx.account.wallet,
    keys: ctx.account.keys,
    feePayer: address(String(ctx.feePayer)),
    recipient: address(String(recipient)),
    asset: SOL_MINT,
    amount,
  });
  const { signature } = await submitSponsored(ctx.relayerUrl, await userSign(tx, [ctx.account.signer]));
  return { signature, slot: await confirmAndSync(ctx, signature) };
}

// ---------------------------------------------------------------------------------------------
// Balance

export interface PrivateBalance {
  /** lamports, SOL only */
  sol: bigint;
  assets: { mint: string; amount: bigint }[];
}

export async function getPrivateBalance({ ctx }: { ctx: Pick<RingsContext, "client" | "account"> }): Promise<PrivateBalance> {
  await syncWallet({ client: ctx.client, wallet: ctx.account.wallet, keys: ctx.account.keys });
  const assets = getPrivateTokenBalances(ctx.account.wallet).map((b) => ({ mint: b.mint as string, amount: b.amount }));
  const sol = assets.find((a) => a.mint === SOL_MINT)?.amount ?? 0n;
  return { sol, assets };
}
