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
import {
  address,
  getBase64EncodedWireTransaction,
  partiallySignTransactionWithSigners,
  type Address,
  type Signature,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import { RINGS_DERIVE_MESSAGE, SPR_ENDPOINTS, type RingsNetwork } from "./constants.js";

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
  /** e.g. https://devnet.helius-rpc.com/?api-key=KEY. A browser app should use a proxy or a
   *  restricted key; never ship the relayer's key. */
  solanaRpcUrl: string;
  indexerUrl?: string;
  proverUrl?: string;
  apiKey?: string;
}

export async function createRingsClient(args: CreateRingsClientArgs): Promise<SprClient> {
  const ep = SPR_ENDPOINTS[args.network];
  // UNVERIFIED live: endpoints come from the SDK README; proverTee is required for remote provers.
  return createSprClient({
    solanaRpcUrl: args.solanaRpcUrl,
    indexerUrl: args.indexerUrl ?? ep.indexerUrl,
    proverUrl: args.proverUrl ?? ep.proverUrl,
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    proverTee: SignedTeePolicy.forNetwork(args.network),
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
