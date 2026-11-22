import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  APP_NAME,
  DERIVE_MESSAGE,
  REGISTER_MESSAGE,
  b64,
  burnerFromSeed,
  burnerWallet,
  checkSender,
  deriveMessagingKey,
  encodePaymentBody,
  openMessage,
  parsePaymentBody,
  reassemble,
  sealMessage,
  setupMessagingIdentity,
  shortAddress,
  unb64,
  verifyRegistration,
  verifyWalletSignature,
  type Opened,
} from '../src/index.ts';

const enc = new TextEncoder();

async function identity(seedByte?: number) {
  const w = seedByte === undefined ? burnerWallet() : burnerFromSeed(new Uint8Array(32).fill(seedByte));
  const id = await setupMessagingIdentity(w);
  return { wallet: w, ...id };
}

describe('encoding', () => {
  it('b64 roundtrip matches standard base64', () => {
    for (let n = 0; n < 40; n++) {
      const u = randomBytes(n);
      expect(unb64(b64(u))).toEqual(u);
    }
    expect(b64(enc.encode('hello'))).toBe('aGVsbG8=');
    expect(APP_NAME).toBe('Pispt');
  });
  it('shortAddress', () => {
    expect(shortAddress('6T9AvUXqBnSrSxwdLmUnxttgdkSqyWDUQUcYqZf7mkpv')).toBe('6T9A…mkpv');
  });
});

describe('key derivation', () => {
  it('is deterministic for the same wallet', () => {
    const w = burnerFromSeed(new Uint8Array(32).fill(7));
    const msg = enc.encode(DERIVE_MESSAGE(w.publicKey));
    const a = deriveMessagingKey(w.sign(msg));
    const b = deriveMessagingKey(burnerFromSeed(new Uint8Array(32).fill(7)).sign(msg));
    expect(a.secret).toEqual(b.secret);
    expect(a.publicKey).toEqual(b.publicKey);
    expect(a.publicKey).toEqual(x25519.getPublicKey(sha256(w.sign(msg))));
    const other = burnerFromSeed(new Uint8Array(32).fill(8));
    const c = deriveMessagingKey(other.sign(enc.encode(DERIVE_MESSAGE(other.publicKey))));
    expect(c.publicKey).not.toEqual(a.publicKey);
    expect(DERIVE_MESSAGE('X')).toBe('Pispt messaging key v1\nX');
  });

  it('burner wallet signs verifiable signatures', () => {
    const w = burnerWallet();
    expect(w.secretKey.length).toBe(64);
    const m = enc.encode('hi');
    expect(verifyWalletSignature(w.publicKey, m, w.sign(m))).toBe(true);
    expect(verifyWalletSignature(w.publicKey, enc.encode('ho'), w.sign(m))).toBe(false);
    expect(verifyWalletSignature('not-base58!', m, w.sign(m))).toBe(false);
  });
});

describe('registration', () => {
  it('verifies a valid record and rejects tampered ones', async () => {
    const a = await identity();
    expect(a.record.msgPub).toBe(b64(a.publicKey));
    expect(REGISTER_MESSAGE(a.record.msgPub)).toBe('primar-register:v1:' + a.record.msgPub);
    expect(verifyRegistration(a.record)).toBe(true);

    const other = await identity();
    expect(verifyRegistration({ ...a.record, msgPub: other.record.msgPub })).toBe(false);
    expect(verifyRegistration({ ...a.record, wallet: other.record.wallet })).toBe(false);
    const sig = unb64(a.record.sig);
    sig[0]! ^= 1;
    expect(verifyRegistration({ ...a.record, sig: b64(sig) })).toBe(false);
    expect(verifyRegistration({ ...a.record, sig: 'garbage' })).toBe(false);
  });
});

describe('envelope', () => {
  it('seal/open roundtrip between two burner identities', async () => {
    const alice = await identity();
    const bob = await identity();
    const wires = sealMessage({
      senderWallet: alice.wallet.publicKey,
      senderSecret: alice.secret,
      recipientMsgPub: bob.publicKey,
      text: 'gm bob 👋',
    });
    expect(wires.length).toBe(1);
    const w = wires[0]!;
    expect(w.startsWith('PRM1:')).toBe(true);
    expect(unb64(w.slice(5))[0]).toBe(0x01);
    expect(w.length).toBeLessThanOrEqual(700);

    const o = openMessage({ wire: w, mySecret: bob.secret });
    expect(o).not.toBeNull();
    expect(o!.from).toBe(alice.wallet.publicKey);
    expect(o!.fromMsgPub).toBe(b64(alice.publicKey));
    expect(o!.body).toBe('gm bob 👋');
    expect(o!.kind).toBe('text');
    expect(o!.part).toBe(0);
    expect(o!.total).toBe(1);
    expect(o!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(checkSender(o!, alice.record)).toBe(true);
  });

  it('third party gets null', async () => {
    const alice = await identity();
    const bob = await identity();
    const eve = await identity();
    const [w] = sealMessage({
      senderWallet: alice.wallet.publicKey,
      senderSecret: alice.secret,
      recipientMsgPub: bob.publicKey,
      text: 'secret',
    });
    expect(openMessage({ wire: w!, mySecret: eve.secret })).toBeNull();
    // sender cannot open their own outbound envelope either
    expect(openMessage({ wire: w!, mySecret: alice.secret })).toBeNull();
  });

  it('tampered ciphertext → null', async () => {
    const alice = await identity();
    const bob = await identity();
    const [w] = sealMessage({
      senderWallet: alice.wallet.publicKey,
      senderSecret: alice.secret,
      recipientMsgPub: bob.publicKey,
      text: 'do not touch',
    });
    const bin = unb64(w!.slice(5));
    for (const idx of [bin.length - 1, 80, 60 /* nonce */, 40 /* tag */, 5 /* E */, 0 /* version */]) {
      const t = bin.slice();
      t[idx]! ^= 0x01;
      expect(openMessage({ wire: 'PRM1:' + b64(t), mySecret: bob.secret })).toBeNull();
    }
    expect(openMessage({ wire: 'PRM1:!!!', mySecret: bob.secret })).toBeNull();
    expect(openMessage({ wire: w!.replace('PRM1:', 'PRM2:'), mySecret: bob.secret })).toBeNull();
  });

  it('forged auth is rejected or detectable', async () => {
    const alice = await identity();
    const bob = await identity();
    const eve = await identity();

    // (a) Eve claims Alice's wallet AND Alice's msgPub but signs auth with her own secret.
    // Hand-build the envelope following the contract so only `auth` is wrong.
    const forge = (fromMsgPub: string, authSecret: Uint8Array) => {
      const e = x25519.utils.randomSecretKey();
      const E = x25519.getPublicKey(e);
      const shared = x25519.getSharedSecret(e, bob.publicKey);
      const tag = hmac(sha256, shared, utf8ToBytes('primar-tag')).slice(0, 16);
      const key = hkdf(sha256, shared, E, utf8ToBytes('primar-key'), 32);
      const id = '0123456789abcdef';
      const part = 0;
      const k = x25519.getSharedSecret(authSecret, bob.publicKey);
      const partBytes = new Uint8Array(4);
      new DataView(partBytes.buffer).setUint32(0, part);
      const auth = hmac(sha256, k, concatBytes(utf8ToBytes('primar-auth'), E, utf8ToBytes(id), partBytes));
      const inner = JSON.stringify({
        v: 1,
        from: alice.wallet.publicKey,
        fromMsgPub,
        id,
        part,
        total: 1,
        ts: Date.now(),
        kind: 'text',
        body: 'send me money',
        auth: b64(auth),
      });
      const nonce = randomBytes(24);
      const ct = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(inner));
      return 'PRM1:' + b64(concatBytes(new Uint8Array([1]), E, tag, nonce, ct));
    };

    expect(openMessage({ wire: forge(b64(alice.publicKey), eve.secret), mySecret: bob.secret })).toBeNull();
    // sanity: the same construction with Alice's real secret opens (proves the forge helper matches the format)
    const genuine = openMessage({ wire: forge(b64(alice.publicKey), alice.secret), mySecret: bob.secret });
    expect(genuine).not.toBeNull();
    expect(checkSender(genuine!, alice.record)).toBe(true);

    // (b) Eve claims Alice's wallet but uses her own msgPub (auth valid for Eve's key):
    // opens, but the directory check exposes it.
    const [w] = sealMessage({
      senderWallet: alice.wallet.publicKey,
      senderSecret: eve.secret,
      recipientMsgPub: bob.publicKey,
      text: 'its me alice',
    });
    const o = openMessage({ wire: w!, mySecret: bob.secret });
    expect(o).not.toBeNull();
    expect(o!.fromMsgPub).toBe(b64(eve.publicKey));
    expect(checkSender(o!, alice.record)).toBe(false);
  });

  it('chunks a 3000-char message and reassembles it', async () => {
    const alice = await identity();
    const bob = await identity();
    const base = 'Privacy is a right, not a feature. ünïcødé ✓ 🚀 "quotes" \\ \n';
    let text = '';
    while (text.length < 3000) text += base;
    text = Array.from(text).slice(0, 3000).join('');
    const wires = sealMessage({
      senderWallet: alice.wallet.publicKey,
      senderSecret: alice.secret,
      recipientMsgPub: bob.publicKey,
      text,
    });
    expect(wires.length).toBeGreaterThan(1);
    for (const w of wires) {
      expect(w.length).toBeLessThanOrEqual(700);
      expect(w.startsWith('PRM1:')).toBe(true);
      expect(unb64(w.slice(5))[0]).toBe(0x01);
    }
    const opened = wires.map((w) => openMessage({ wire: w, mySecret: bob.secret }));
    expect(opened.every((o) => o !== null)).toBe(true);
    const parts = opened as Opened[];
    expect(new Set(parts.map((p) => p.id)).size).toBe(1);
    expect(parts.every((p) => p.total === wires.length)).toBe(true);

    // shuffled + duplicated input still reassembles
    const shuffled = [...parts].reverse().concat(parts[0]!);
    const msgs = reassemble(shuffled);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toBe(text);
    expect(msgs[0]!.from).toBe(alice.wallet.publicKey);

    // incomplete → not returned
    expect(reassemble(parts.slice(1))).toHaveLength(0);
  });

  it('long ASCII message parts fit the limit', async () => {
    const alice = await identity();
    const bob = await identity();
    const text = 'x'.repeat(3000);
    const wires = sealMessage({
      senderWallet: alice.wallet.publicKey,
      senderSecret: alice.secret,
      recipientMsgPub: bob.publicKey,
      text,
    });
    expect(Math.max(...wires.map((w) => w.length))).toBeLessThanOrEqual(700);
    const msgs = reassemble(wires.map((w) => openMessage({ wire: w, mySecret: bob.secret })!));
    expect(msgs[0]!.body).toBe(text);
  });

  it('empty message roundtrips', async () => {
    const alice = await identity();
    const bob = await identity();
    const wires = sealMessage({
      senderWallet: alice.wallet.publicKey,
      senderSecret: alice.secret,
      recipientMsgPub: bob.publicKey,
      text: '',
    });
    expect(wires).toHaveLength(1);
    expect(reassemble([openMessage({ wire: wires[0]!, mySecret: bob.secret })!])[0]!.body).toBe('');
  });

  it('payment kind roundtrip', async () => {
    const alice = await identity();
    const bob = await identity();
    const pay = { mint: 'SOL', amount: '1500000', ringsSignature: '5'.repeat(88) };
    const wires = sealMessage({
      senderWallet: alice.wallet.publicKey,
      senderSecret: alice.secret,
      recipientMsgPub: bob.publicKey,
      text: encodePaymentBody(pay),
      kind: 'payment',
    });
    const parts = wires.map((w) => openMessage({ wire: w, mySecret: bob.secret })!);
    expect(parts.every((p) => p.kind === 'payment')).toBe(true);
    const [m] = reassemble(parts);
    expect(m!.kind).toBe('payment');
    expect(parsePaymentBody(m!.body)).toEqual(pay);
    expect(parsePaymentBody('{"mint":"SOL","amount":"1.5","ringsSignature":"x"}')).toBeNull();
  });
});
