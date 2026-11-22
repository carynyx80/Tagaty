// Relayer-side fee sponsorship. Uses only @solana/kit (no SPR SDK), so the relayer stays light.
//
// Threat model: anyone can POST a transaction. The relayer only adds its fee-payer signature,
// so the danger is a tx that spends the relayer's lamports beyond the fee (e.g. a System transfer
// from the relayer, a Rings deposit with the relayer as depositor, a huge priority fee, many signers).
import {
  address,
  createKeyPairFromBytes,
  createSolanaRpc,
  decompileTransactionMessage,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  verifySignature,
  AccountRole,
  type Address,
  type Instruction,
  type Transaction,
} from "@solana/kit";
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  PRIVACY_PROGRAM_ID,
  PrivacyIx,
  REGISTRY_PAYER_INDEX,
  REGISTRY_PROGRAM_ID,
  SPONSOR_LIMITS,
  SYSTEM_PROGRAM_ID,
} from "./constants.js";

export class SponsorRejectedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SponsorRejectedError";
  }
}

export interface SponsorPolicy {
  /** The relayer's address; must be the fee payer. */
  relayer: Address | string;
  maxPriorityFeeLamports?: bigint;
  maxSignatures?: number;
  /** Allow top-level System program instructions that do not touch the relayer. Default true. */
  allowSystem?: boolean;
}

export interface ValidatedSponsorTx {
  transaction: Transaction;
  version: "legacy" | 0 | 1;
  feePayer: Address;
  programs: string[];
  priorityFeeLamports: bigint;
}

const reject = (code: string, message: string): never => {
  throw new SponsorRejectedError(code, message);
};

function u32le(d: ArrayLike<number>, o: number): number {
  return (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16)) + d[o + 3]! * 0x1000000;
}
function u64le(d: ArrayLike<number>, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]!);
  return v;
}

function indicesOf(ix: Instruction, who: string): number[] {
  const out: number[] = [];
  (ix.accounts ?? []).forEach((a, i) => {
    if (a.address === who) out.push(i);
  });
  return out;
}

/**
 * Decode and check a transaction the relayer is asked to pay for. Throws SponsorRejectedError.
 *
 * Rules:
 *  - legacy / v0 (no lookup tables) / v1 only; size <= 4096 bytes.
 *  - fee payer (static account 0) == relayer; <= maxSignatures signers.
 *  - every top-level instruction's program ∈ { Privacy Program, Registry, ComputeBudget, System* }.
 *  - Privacy Program: only deposit / transact / mergeTransact.
 *      deposit: relayer may not appear at all (account 1 is the depositor = lamport source).
 *      transact / mergeTransact: relayer may appear only at index 0 (payer of nullifier-PDA rent).
 *  - Registry: relayer may appear only at index 2 (`register` payer, funds the record rent).
 *  - System: relayer may not appear in the instruction at all (blocks transfers FROM the relayer).
 *  - ComputeBudget: only limit / price / heap / loaded-data; total priority fee capped.
 *  - v1 config priorityFeeLamports capped.
 */
export function validateSponsorableTx(txBytes: Uint8Array, policy: SponsorPolicy): ValidatedSponsorTx {
  const relayer = address(String(policy.relayer));
  const maxFee = policy.maxPriorityFeeLamports ?? SPONSOR_LIMITS.maxPriorityFeeLamports;
  const maxSigs = policy.maxSignatures ?? SPONSOR_LIMITS.maxSignatures;
  const allowSystem = policy.allowSystem ?? true;

  if (!(txBytes instanceof Uint8Array) || txBytes.length === 0) reject("decode", "empty transaction");
  if (txBytes.length > SPONSOR_LIMITS.maxTxBytes) reject("size", `transaction too large (${txBytes.length} bytes)`);

  let transaction: Transaction;
  let compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    transaction = getTransactionDecoder().decode(txBytes) as Transaction;
    compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch (e) {
    return reject("decode", `could not decode transaction: ${(e as Error).message}`);
  }

  if (compiled.version === 0 && (compiled.addressTableLookups?.length ?? 0) > 0) {
    reject("lookup_tables", "address lookup tables are not allowed");
  }

  const feePayer = compiled.staticAccounts[0];
  if (feePayer !== relayer) reject("fee_payer", `fee payer must be the relayer ${relayer}, got ${feePayer ?? "none"}`);

  const signers = Object.keys(transaction.signatures);
  if (signers.length > maxSigs) reject("too_many_signers", `too many signers (${signers.length} > ${maxSigs})`);

  let message: ReturnType<typeof decompileTransactionMessage>;
  try {
    message = decompileTransactionMessage(compiled as Parameters<typeof decompileTransactionMessage>[0]);
  } catch (e) {
    return reject("decode", `could not decompile message: ${(e as Error).message}`);
  }

  // Any instruction that names the relayer as a *writable* account outside the allowed slot
  // could debit it, so the per-program rules below are strict allowlists of positions.
  let cuLimit: number | undefined;
  let cuPriceMicroLamports = 0n;
  const programs: string[] = [];

  message.instructions.forEach((ix, n) => {
    const program = ix.programAddress as string;
    const data = ix.data ?? new Uint8Array();
    const at = indicesOf(ix, relayer);
    programs.push(program);

    switch (program) {
      case PRIVACY_PROGRAM_ID: {
        const tag = data[0];
        if (tag === PrivacyIx.deposit) {
          if (at.length > 0) reject("relayer_debit", `instruction ${n}: deposit may not reference the relayer (it would fund the deposit)`);
        } else if (tag === PrivacyIx.transact || tag === PrivacyIx.mergeTransact) {
          if (at.some((i) => i !== 0)) reject("relayer_debit", `instruction ${n}: relayer may only be the payer (account 0) of a transact`);
        } else {
          reject("privacy_ix", `instruction ${n}: Privacy Program instruction tag ${String(tag)} is not sponsorable`);
        }
        break;
      }
      case REGISTRY_PROGRAM_ID: {
        if (at.some((i) => i !== REGISTRY_PAYER_INDEX)) {
          reject("relayer_debit", `instruction ${n}: relayer may only be the registry payer (account ${REGISTRY_PAYER_INDEX})`);
        }
        break;
      }
      case COMPUTE_BUDGET_PROGRAM_ID: {
        const d = data[0];
        if (d === 1 /* RequestHeapFrame */ || d === 4 /* SetLoadedAccountsDataSizeLimit */) {
          // harmless
        } else if (d === 2 /* SetComputeUnitLimit */ && data.length >= 5) {
          cuLimit = u32le(data, 1);
        } else if (d === 3 /* SetComputeUnitPrice */ && data.length >= 9) {
          cuPriceMicroLamports = u64le(data, 1);
        } else {
          reject("compute_budget", `instruction ${n}: unsupported ComputeBudget instruction`);
        }
        break;
      }
      case SYSTEM_PROGRAM_ID: {
        if (!allowSystem) reject("program", `instruction ${n}: System program not allowed`);
        if (at.length > 0) reject("relayer_debit", `instruction ${n}: System instruction may not reference the relayer`);
        break;
      }
      default:
        reject("program", `instruction ${n}: program ${program} is not allowed`);
    }
  });

  // Priority fee. Legacy/v0: price (µlamports/CU) * limit. Worst-case limit when unset.
  let priorityFeeLamports = 0n;
  if (cuPriceMicroLamports > 0n) {
    const limit = BigInt(cuLimit ?? 1_400_000);
    priorityFeeLamports += (cuPriceMicroLamports * limit + 999_999n) / 1_000_000n;
  }
  const cfg = (message as { config?: { priorityFeeLamports?: bigint } }).config;
  if (cfg?.priorityFeeLamports !== undefined) priorityFeeLamports += BigInt(cfg.priorityFeeLamports);
  if (priorityFeeLamports > maxFee) {
    reject("priority_fee", `priority fee ${priorityFeeLamports} lamports exceeds cap ${maxFee}`);
  }

  // Defence in depth: the relayer must never be a writable non-fee-payer account via an
  // instruction we did not explicitly reason about above (all cases handled, but keep the check).
  for (const ix of message.instructions) {
    for (const [i, a] of (ix.accounts ?? []).entries()) {
      if (a.address !== relayer) continue;
      const writable = a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER;
      const okSlot =
        (ix.programAddress === PRIVACY_PROGRAM_ID && i === 0 && ix.data?.[0] !== PrivacyIx.deposit) ||
        (ix.programAddress === REGISTRY_PROGRAM_ID && i === REGISTRY_PAYER_INDEX);
      if (writable && !okSlot) reject("relayer_debit", "relayer referenced as writable account");
    }
  }

  return { transaction, version: compiled.version, feePayer: relayer, programs, priorityFeeLamports };
}

/** Verify every non-relayer signer already signed (cheap spam filter before hitting RPC). */
export async function verifyUserSignatures(transaction: Transaction, relayer: Address | string): Promise<void> {
  for (const [signer, sig] of Object.entries(transaction.signatures)) {
    if (signer === relayer) continue;
    if (!sig) reject("missing_signature", `missing signature from ${signer}`);
    const pub = await getPublicKeyFromAddress(address(signer));
    const ok = await verifySignature(pub, sig!, transaction.messageBytes);
    if (!ok) reject("bad_signature", `invalid signature from ${signer}`);
  }
}

export interface RelayerSigner {
  address: Address;
  keyPair: CryptoKeyPair;
}

/** From a 64-byte Solana secret key (the JSON-array keypair file format). */
export async function createRelayerSigner(secretKey64: Uint8Array): Promise<RelayerSigner> {
  if (secretKey64.length !== 64) throw new Error("relayer keypair must be 64 bytes");
  const keyPair = await createKeyPairFromBytes(secretKey64);
  return { address: await getAddressFromPublicKey(keyPair.publicKey), keyPair };
}

export interface SponsorAndSendArgs {
  txBytes: Uint8Array;
  relayer: RelayerSigner;
  rpcUrl: string;
  policy?: Omit<SponsorPolicy, "relayer">;
  skipPreflight?: boolean;
}

/** Validate, verify user signatures, add the relayer's fee-payer signature, submit. */
export async function sponsorAndSend(args: SponsorAndSendArgs): Promise<{ signature: string }> {
  const { transaction } = validateSponsorableTx(args.txBytes, { ...args.policy, relayer: args.relayer.address });
  await verifyUserSignatures(transaction, args.relayer.address);
  const signed = await partiallySignTransaction([args.relayer.keyPair], transaction);
  const wire = getBase64EncodedWireTransaction(signed);
  const rpc = createSolanaRpc(args.rpcUrl);
  // UNVERIFIED live: SPR builds version-1 transactions; the RPC must accept v1 (Helius devnet per SDK README).
  await rpc
    .sendTransaction(wire, {
      encoding: "base64",
      skipPreflight: args.skipPreflight ?? false,
      preflightCommitment: "confirmed",
    })
    .send();
  return { signature: getSignatureFromTransaction(signed) };
}

export function decodeBase64(b64: string): Uint8Array {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new SponsorRejectedError("decode", "transaction must be standard base64");
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
