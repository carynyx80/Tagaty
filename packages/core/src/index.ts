/**
 * @primar/core — crypto core for Primar (gas-free private messaging on Solana).
 * Implements CONTRACT.md section 1. Browser + Node compatible (no Buffer, no node:crypto).
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const APP_NAME = 'Pispt' as const;

/** Wire prefix for envelopes. */
export const WIRE_PREFIX = 'PRM1:';
/** Envelope version byte (first byte of the binary). */
export const ENVELOPE_VERSION = 0x01;
/** Max wire string length (chars), per contract. */
export const MAX_WIRE_LENGTH = 700;

export const DERIVE_MESSAGE = (wallet: string): string => 'Pispt messaging key v1\n' + wallet;
export const REGISTER_MESSAGE = (msgPubB64: string): string => 'primar-register:v1:' + msgPubB64;

const TAG_LABEL = utf8ToBytes('primar-tag');
const KEY_INFO = utf8ToBytes('primar-key');
const AUTH_LABEL = utf8ToBytes('primar-auth');

const E_LEN = 32;
const TAG_LEN = 16;
const NONCE_LEN = 24;
const HEADER_LEN = 1 + E_LEN + TAG_LEN + NONCE_LEN; // 73
const AEAD_TAG_LEN = 16;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) B64_LOOKUP[B64_ALPHABET[i]!] = i;

/** Standard base64 (with padding). */
export function b64(u: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < u.length; i += 3) {
    const n = (u[i]! << 16) | (u[i + 1]! << 8) | u[i + 2]!;
    out +=
      B64_ALPHABET[(n >> 18) & 63]! +
      B64_ALPHABET[(n >> 12) & 63]! +
      B64_ALPHABET[(n >> 6) & 63]! +
      B64_ALPHABET[n & 63]!;
  }
  const rem = u.length - i;
  if (rem === 1) {
    const n = u[i]! << 16;
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (u[i]! << 16) | (u[i + 1]! << 8);
    out +=
      B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + B64_ALPHABET[(n >> 6) & 63]! + '=';
  }
  return out;
}

/** Decode standard base64 (padding optional, whitespace ignored). Throws on invalid input. */
export function unb64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '').replace(/=+$/, '');
  if (clean.length % 4 === 1) throw new Error('invalid base64');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buf = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_LOOKUP[clean[i]!];
    if (v === undefined) throw new Error('invalid base64');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

function decodeWallet(wallet: string): Uint8Array | null {
  try {
    const pk = bs58.decode(wallet);
    return pk.length === 32 ? pk : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Key derivation & registration
// ---------------------------------------------------------------------------

/**
 * Derive the X25519 messaging keypair from the wallet's ed25519 signature over
 * `DERIVE_MESSAGE(wallet)`. msgSecret = sha256(signature).
 */
export function deriveMessagingKey(signature: Uint8Array): { secret: Uint8Array; publicKey: Uint8Array } {
  const secret = sha256(signature);
  const publicKey = x25519.getPublicKey(secret);
  return { secret, publicKey };
}

/** Verify an ed25519 signature by a base58 wallet. Never throws. */
export function verifyWalletSignature(walletBase58: string, message: Uint8Array, sig: Uint8Array): boolean {
  const pk = decodeWallet(walletBase58);
  if (!pk || sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, message, pk);
  } catch {
    return false;
  }
}

/** Verify a key-directory record: wallet signed `REGISTER_MESSAGE(msgPub)`. Never throws. */
export function verifyRegistration(rec: { wallet: string; msgPub: string; sig: string }): boolean {
  try {
    if (!rec || typeof rec.wallet !== 'string' || typeof rec.msgPub !== 'string' || typeof rec.sig !== 'string')
      return false;
    if (unb64(rec.msgPub).length !== 32) return false;
    const sig = unb64(rec.sig);
    return verifyWalletSignature(rec.wallet, textEncoder.encode(REGISTER_MESSAGE(rec.msgPub)), sig);
  } catch {
    return false;
  }
}

/** Something that can sign bytes with a wallet's ed25519 key (wallet adapter or burner). */
export type Signer = { publicKey: string; sign(msg: Uint8Array): Uint8Array | Promise<Uint8Array> };

/**
 * Convenience: sign DERIVE_MESSAGE + REGISTER_MESSAGE with a signer and return the
 * messaging keypair plus a ready-to-POST registration record.
 */
export async function setupMessagingIdentity(signer: Signer): Promise<{
  secret: Uint8Array;
  publicKey: Uint8Array;
  record: { wallet: string; msgPub: string; sig: string };
}> {
  const deriveSig = await signer.sign(textEncoder.encode(DERIVE_MESSAGE(signer.publicKey)));
  const { secret, publicKey } = deriveMessagingKey(deriveSig);
  const msgPub = b64(publicKey);
  const regSig = await signer.sign(textEncoder.encode(REGISTER_MESSAGE(msgPub)));
  return { secret, publicKey, record: { wallet: signer.publicKey, msgPub, sig: b64(regSig) } };
}

// ---------------------------------------------------------------------------
// Burner wallet & misc helpers
// ---------------------------------------------------------------------------

export type BurnerWallet = {
  /** base58 ed25519 public key (Solana address). */
  publicKey: string;
  /** 64-byte Solana-style secret key: seed(32) || publicKey(32). */
  secretKey: Uint8Array;
  /** 32-byte ed25519 seed. */
  seed: Uint8Array;
  sign(msg: Uint8Array): Uint8Array;
};

/** Burner wallet from a 32-byte seed (or a 64-byte Solana secret key; first 32 bytes used). */
export function burnerFromSeed(seed: Uint8Array): BurnerWallet {
  if (seed.length !== 32 && seed.length !== 64) throw new Error('seed must be 32 or 64 bytes');
  const s = seed.slice(0, 32);
  const pub = ed25519.getPublicKey(s);
  return {
    publicKey: bs58.encode(pub),
    secretKey: concatBytes(s, pub),
    seed: s,
    sign: (msg: Uint8Array) => ed25519.sign(msg, s),
  };
}

/** Fresh random burner wallet (for running without a browser extension). */
export function burnerWallet(): BurnerWallet {
  return burnerFromSeed(randomBytes(32));
}

/** "AbCd…WxYz" */
export function shortAddress(addr: string, chars = 4): string {
  if (!addr) return '';
  if (addr.length <= chars * 2 + 1) return addr;
  return addr.slice(0, chars) + '…' + addr.slice(-chars);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type Kind = 'text' | 'payment';

export type Opened = {
  from: string;
  fromMsgPub: string;
  id: string;
  part: number;
  total: number;
  ts: number;
  kind: 'text' | 'payment';
  body: string;
};

type Inner = Opened & { v: 1; auth: string };

function computeAuth(senderSecret: Uint8Array, recipientPub: Uint8Array, E: Uint8Array, id: string, part: number) {
  const k = x25519.getSharedSecret(senderSecret, recipientPub);
  return hmac(sha256, k, concatBytes(AUTH_LABEL, E, utf8ToBytes(id), u32be(part)));
}

function serializeInner(inner: Inner): Uint8Array {
  // Fixed key order (as in the contract).
  return textEncoder.encode(
    JSON.stringify({
      v: inner.v,
      from: inner.from,
      fromMsgPub: inner.fromMsgPub,
      id: inner.id,
      part: inner.part,
      total: inner.total,
      ts: inner.ts,
      kind: inner.kind,
      body: inner.body,
      auth: inner.auth,
    }),
  );
}

function sealOne(
  inner: Omit<Inner, 'auth'>,
  senderSecret: Uint8Array,
  recipientMsgPub: Uint8Array,
): string {
  const e = x25519.utils.randomSecretKey();
  const E = x25519.getPublicKey(e);
  const shared = x25519.getSharedSecret(e, recipientMsgPub);
  const tag = hmac(sha256, shared, TAG_LABEL).slice(0, TAG_LEN);
  const key = hkdf(sha256, shared, E, KEY_INFO, 32);
  const auth = b64(computeAuth(senderSecret, recipientMsgPub, E, inner.id, inner.part));
  const pt = serializeInner({ ...inner, auth });
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce).encrypt(pt);
  const bin = concatBytes(new Uint8Array([ENVELOPE_VERSION]), E, tag, nonce, ct);
  return WIRE_PREFIX + b64(bin);
}

/** Max binary bytes that fit in a wire string of MAX_WIRE_LENGTH chars. */
const MAX_BINARY = Math.floor((MAX_WIRE_LENGTH - WIRE_PREFIX.length) / 4) * 3; // 519
/** Max inner JSON bytes per envelope. */
const MAX_INNER = MAX_BINARY - HEADER_LEN - AEAD_TAG_LEN; // 430

/** UTF-8 byte length of a code point once JSON-string-escaped. */
function escapedLen(cp: string): number {
  const j = JSON.stringify(cp);
  return textEncoder.encode(j).length - 2;
}

function splitBody(body: string, budget: number): string[] {
  if (budget < 16) throw new Error('message metadata too large to fit an envelope');
  const chunks: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const cp of body) {
    const l = escapedLen(cp);
    if (curLen + l > budget) {
      chunks.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += cp;
    curLen += l;
  }
  if (cur.length > 0 || chunks.length === 0) chunks.push(cur);
  return chunks;
}

/**
 * Encrypt (and chunk) a message to a recipient. Returns one or more wire strings
 * (`"PRM1:" + base64`), each ≤ 700 chars. Parts share `id`; `part` is 0-based.
 */
export function sealMessage(args: {
  senderWallet: string;
  senderSecret: Uint8Array;
  recipientMsgPub: Uint8Array;
  text: string;
  kind?: Kind;
}): string[] {
  const { senderWallet, senderSecret, recipientMsgPub, text } = args;
  const kind: Kind = args.kind ?? 'text';
  if (recipientMsgPub.length !== 32) throw new Error('recipientMsgPub must be 32 bytes');
  if (senderSecret.length !== 32) throw new Error('senderSecret must be 32 bytes');
  const fromMsgPub = b64(x25519.getPublicKey(senderSecret));
  const id = bytesToHex(randomBytes(8));
  const ts = Date.now();

  // Compute body budget using worst-case part/total digits, then fall back if the
  // number of parts is larger than assumed.
  let digits = 3;
  for (;;) {
    const maxNum = Number('9'.repeat(digits));
    const overhead = serializeInner({
      v: 1,
      from: senderWallet,
      fromMsgPub,
      id,
      part: maxNum,
      total: maxNum,
      ts,
      kind,
      body: '',
      auth: 'A'.repeat(44),
    }).length;
    const chunks = splitBody(text, MAX_INNER - overhead);
    if (chunks.length > maxNum) {
      digits++;
      continue;
    }
    const total = chunks.length;
    return chunks.map((body, part) =>
      sealOne({ v: 1, from: senderWallet, fromMsgPub, id, part, total, ts, kind, body }, senderSecret, recipientMsgPub),
    );
  }
}

function isValidInner(x: unknown): x is Inner {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.from === 'string' &&
    typeof o.fromMsgPub === 'string' &&
    typeof o.id === 'string' &&
    /^[0-9a-f]{16}$/.test(o.id) &&
    Number.isInteger(o.part) &&
    Number.isInteger(o.total) &&
    (o.part as number) >= 0 &&
    (o.total as number) >= 1 &&
    (o.part as number) < (o.total as number) &&
    typeof o.ts === 'number' &&
    Number.isFinite(o.ts) &&
    (o.kind === 'text' || o.kind === 'payment') &&
    typeof o.body === 'string' &&
    typeof o.auth === 'string'
  );
}

/**
 * Try to open a wire string. Returns null if it is not addressed to `mySecret`,
 * is malformed, fails decryption, or the sender auth does not verify.
 * NOTE: the caller must still check `fromMsgPub` against the directory record for
 * `from` (see `checkSender`).
 */
export function openMessage(args: { wire: string; mySecret: Uint8Array }): Opened | null {
  try {
    const { wire, mySecret } = args;
    if (typeof wire !== 'string' || !wire.startsWith(WIRE_PREFIX)) return null;
    const bin = unb64(wire.slice(WIRE_PREFIX.length));
    if (bin.length < HEADER_LEN + AEAD_TAG_LEN || bin[0] !== ENVELOPE_VERSION) return null;
    const E = bin.subarray(1, 1 + E_LEN);
    const tag = bin.subarray(1 + E_LEN, 1 + E_LEN + TAG_LEN);
    const nonce = bin.subarray(1 + E_LEN + TAG_LEN, HEADER_LEN);
    const ct = bin.subarray(HEADER_LEN);

    const shared = x25519.getSharedSecret(mySecret, E);
    const expectedTag = hmac(sha256, shared, TAG_LABEL).slice(0, TAG_LEN);
    if (!equalBytes(tag, expectedTag)) return null; // not for me

    const key = hkdf(sha256, shared, E, KEY_INFO, 32);
    const pt = xchacha20poly1305(key, nonce).decrypt(ct);
    const inner: unknown = JSON.parse(textDecoder.decode(pt));
    if (!isValidInner(inner)) return null;

    const senderPub = unb64(inner.fromMsgPub);
    if (senderPub.length !== 32) return null;
    // auth key = x25519(senderSecret, recipientPub) == x25519(mySecret, senderPub)
    const k = x25519.getSharedSecret(mySecret, senderPub);
    const expectedAuth = hmac(sha256, k, concatBytes(AUTH_LABEL, E, utf8ToBytes(inner.id), u32be(inner.part)));
    if (!equalBytes(unb64(inner.auth), expectedAuth)) return null;

    return {
      from: inner.from,
      fromMsgPub: inner.fromMsgPub,
      id: inner.id,
      part: inner.part,
      total: inner.total,
      ts: inner.ts,
      kind: inner.kind,
      body: inner.body,
    };
  } catch {
    return null;
  }
}

/**
 * Check that an opened message's claimed sender matches a (verified) directory record:
 * record signature valid, record.wallet === opened.from, record.msgPub === opened.fromMsgPub.
 */
export function checkSender(
  opened: Pick<Opened, 'from' | 'fromMsgPub'>,
  record: { wallet: string; msgPub: string; sig: string } | null | undefined,
): boolean {
  if (!record) return false;
  return record.wallet === opened.from && record.msgPub === opened.fromMsgPub && verifyRegistration(record);
}

/**
 * Group opened parts into full messages (by sender + id). Only messages whose parts
 * 0..total-1 are all present are returned; duplicates are ignored. Sorted by ts asc.
 */
export function reassemble(parts: Opened[]): { id: string; from: string; ts: number; kind: string; body: string }[] {
  const groups = new Map<string, Opened[]>();
  for (const p of parts) {
    if (!p) continue;
    const key = p.from + '\u0000' + p.fromMsgPub + '\u0000' + p.id;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(p);
  }
  const out: { id: string; from: string; ts: number; kind: string; body: string }[] = [];
  for (const g of groups.values()) {
    const total = g[0]!.total;
    const byPart = new Map<number, Opened>();
    for (const p of g) if (p.total === total && Number.isInteger(p.part) && p.part >= 0 && p.part < total && !byPart.has(p.part)) byPart.set(p.part, p);
    if (byPart.size !== total) continue;
    let body = '';
    for (let i = 0; i < total; i++) body += byPart.get(i)!.body;
    const first = byPart.get(0)!;
    out.push({ id: first.id, from: first.from, ts: first.ts, kind: first.kind, body });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// ---------------------------------------------------------------------------
// Payment body helpers
// ---------------------------------------------------------------------------

export type PaymentBody = { mint: 'SOL' | string; amount: string; ringsSignature: string };

export function encodePaymentBody(p: PaymentBody): string {
  return JSON.stringify({ mint: p.mint, amount: p.amount, ringsSignature: p.ringsSignature });
}

export function parsePaymentBody(body: string): PaymentBody | null {
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    if (typeof o.mint !== 'string' || typeof o.amount !== 'string' || typeof o.ringsSignature !== 'string')
      return null;
    if (!/^\d+$/.test(o.amount)) return null;
    return { mint: o.mint, amount: o.amount, ringsSignature: o.ringsSignature };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Profiles (PUBLIC directory data — not encrypted; username → wallet is discoverable by design)
// ---------------------------------------------------------------------------

export type Profile = {
  wallet: string;
  username: string;
  displayName?: string;
  bio?: string;
  avatar?: string;
  updatedAt: number;
};

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const RESERVED_USERNAMES: readonly string[] = ['admin', 'pispt', 'support', 'helius', 'solana'];
export const MAX_DISPLAY_NAME = 40;
export const MAX_BIO = 160;
export const MAX_AVATAR_CHARS = 150_000;
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Username format + reserved check. Returns an error message or null. */
export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string') return 'username is required';
  if (!USERNAME_RE.test(username)) return 'username must be 3-20 chars of a-z, 0-9, _ (lowercase)';
  if (RESERVED_USERNAMES.includes(username)) return 'username is reserved';
  return null;
}

/** Validates profile fields. Returns an error message or null. */
export function validateProfileFields(p: unknown): string | null {
  if (!p || typeof p !== 'object') return 'profile must be an object';
  const o = p as Record<string, unknown>;
  if (typeof o.wallet !== 'string' || !decodeWallet(o.wallet)) return 'wallet must be a base58 ed25519 address';
  const u = validateUsername(o.username);
  if (u) return u;
  if (o.displayName !== undefined) {
    if (typeof o.displayName !== 'string') return 'displayName must be a string';
    if ([...o.displayName].length > MAX_DISPLAY_NAME) return `displayName must be ≤ ${MAX_DISPLAY_NAME} chars`;
  }
  if (o.bio !== undefined) {
    if (typeof o.bio !== 'string') return 'bio must be a string';
    if ([...o.bio].length > MAX_BIO) return `bio must be ≤ ${MAX_BIO} chars`;
  }
  if (o.avatar !== undefined) {
    if (typeof o.avatar !== 'string') return 'avatar must be a string';
    if (o.avatar.length > MAX_AVATAR_CHARS) return `avatar must be ≤ ${MAX_AVATAR_CHARS} chars`;
    if (!AVATAR_RE.test(o.avatar)) return 'avatar must be a data:image/(png|jpeg|webp);base64 URL';
  }
  if (typeof o.updatedAt !== 'number' || !Number.isSafeInteger(o.updatedAt) || o.updatedAt <= 0)
    return 'updatedAt must be a positive integer (ms)';
  return null;
}

/** Canonical message the wallet signs for a profile. */
export function PROFILE_MESSAGE(p: Profile): string {
  return (
    'pispt-profile:v1:' +
    JSON.stringify([
      p.wallet,
      p.username,
      p.displayName ?? '',
      p.bio ?? '',
      p.avatar ? b64(sha256(textEncoder.encode(p.avatar))) : '',
      p.updatedAt,
    ])
  );
}

/** Validates fields and the wallet's ed25519 signature (base64) over PROFILE_MESSAGE. Never throws. */
export function verifyProfile(p: Profile, sigB64: string): boolean {
  try {
    if (validateProfileFields(p) !== null || typeof sigB64 !== 'string') return false;
    return verifyWalletSignature(p.wallet, textEncoder.encode(PROFILE_MESSAGE(p)), unb64(sigB64));
  } catch {
    return false;
  }
}

/** Convenience: sign a profile with a signer (wallet adapter or burner). Returns base64 sig. */
export async function signProfile(signer: Signer, p: Profile): Promise<string> {
  return b64(await signer.sign(textEncoder.encode(PROFILE_MESSAGE(p))));
}
