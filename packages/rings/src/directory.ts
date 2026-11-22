// Pispt Rings address directory: wallet -> Rings owner address, signed by the wallet.
// Browser + Node safe. The relayer only stores records; every reader re-verifies the signature,
// so a malicious relayer can't redirect payments (it can only withhold records).
import { address, getPublicKeyFromAddress, verifySignature, type SignatureBytes } from "@solana/kit";

const b64 = (u: Uint8Array) => { let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export type RingsAddressRecord = {
  wallet: string;
  /** Solana address registered in the Rings registry (derived from RINGS_DERIVE_MESSAGE). */
  ringsOwner: string;
  /** ms since epoch; a newer record replaces an older one. */
  ts: number;
  /** base64 ed25519 signature by `wallet` over RINGS_ADDRESS_MESSAGE(record). */
  sig: string;
};

export const RINGS_ADDRESS_MESSAGE = (r: Pick<RingsAddressRecord, "wallet" | "ringsOwner" | "ts">) =>
  `Pispt rings address v1\nwallet:${r.wallet}\nrings:${r.ringsOwner}\nts:${r.ts}`;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Never throws. Uses WebCrypto Ed25519 (Node 20+, current browsers). */
export async function verifyRingsAddressRecord(r: unknown): Promise<boolean> {
  try {
    const x = r as RingsAddressRecord;
    if (!x || typeof x !== "object") return false;
    if (typeof x.wallet !== "string" || !BASE58.test(x.wallet)) return false;
    if (typeof x.ringsOwner !== "string" || !BASE58.test(x.ringsOwner)) return false;
    if (typeof x.ts !== "number" || !Number.isSafeInteger(x.ts) || x.ts <= 0) return false;
    if (typeof x.sig !== "string") return false;
    const msg = new TextEncoder().encode(RINGS_ADDRESS_MESSAGE(x));
    const sig = unb64(x.sig);
    if (sig.length !== 64) return false;
    const pub = await getPublicKeyFromAddress(address(x.wallet));
    return await verifySignature(pub, sig as SignatureBytes, msg);
  } catch {
    return false;
  }
}

export async function signRingsAddressRecord(
  signer: { publicKey: string; sign(msg: Uint8Array): Uint8Array | Promise<Uint8Array> },
  ringsOwner: string,
  ts = Date.now(),
): Promise<RingsAddressRecord> {
  const base = { wallet: signer.publicKey, ringsOwner, ts };
  const sig = await signer.sign(new TextEncoder().encode(RINGS_ADDRESS_MESSAGE(base)));
  return { ...base, sig: b64(sig) };
}
