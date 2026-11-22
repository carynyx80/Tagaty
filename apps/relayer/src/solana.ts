import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { MEMO_PROGRAM_ID } from "./config.js";

const MEMO_PROGRAM = new PublicKey(MEMO_PROGRAM_ID);
const MAX_TX_BYTES = 1232; // PACKET_DATA_SIZE

export class TxTooLargeError extends Error {
  constructor(public size: number) {
    super(`transaction too large (${size} > ${MAX_TX_BYTES} bytes)`);
  }
}

/** Loads a solana-keygen style JSON keypair (array of 64 bytes); creates one if missing. */
export function loadOrCreateKeypair(file: string): { keypair: Keypair; created: boolean } {
  if (fs.existsSync(file)) {
    const arr = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(arr) || arr.length !== 64) throw new Error(`invalid keypair file: ${file}`);
    return { keypair: Keypair.fromSecretKey(Uint8Array.from(arr)), created: false };
  }
  const keypair = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return { keypair, created: true };
}

/**
 * Builds + signs a tx containing one Memo instruction with the envelope as data.
 * The instruction has NO account keys, so no user wallet is ever referenced;
 * the relayer is the sole signer and fee payer.
 */
export function buildMemoTx(envelope: string, payer: Keypair, recentBlockhash: string): Buffer {
  const ix = new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [],
    data: Buffer.from(envelope, "utf8"),
  });
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash }).add(ix);
  tx.sign(payer);
  let raw: Buffer;
  try {
    raw = tx.serialize();
  } catch (e: any) {
    // web3.js throws "Transaction too large: N > 1232"
    const m = /(\d+)\s*>\s*\d+/.exec(String(e?.message));
    throw new TxTooLargeError(m ? Number(m[1]) : MAX_TX_BYTES + 1);
  }
  if (raw.length > MAX_TX_BYTES) throw new TxTooLargeError(raw.length);
  return raw;
}

export async function postMemo(
  conn: Connection,
  payer: Keypair,
  envelope: string,
  onConfirmError: (err: unknown, sig: string) => void,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const raw = buildMemoTx(envelope, payer, blockhash);
  const signature = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  // Confirm in the background; do not block the HTTP response.
  conn
    .confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")
    .then((res) => {
      if (res.value.err) onConfirmError(res.value.err, signature);
    })
    .catch((err) => onConfirmError(err, signature));
  return signature;
}

export { LAMPORTS_PER_SOL };
