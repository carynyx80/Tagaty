import { describe, expect, it } from 'vitest';
import {
  MAX_WIRE_LENGTH,
  burnerWallet,
  checkSender,
  newMessageId,
  openMessage,
  reassemble,
  sealMessage,
  sealSelfCopy,
  setupMessagingIdentity,
  type Opened,
} from '../src/index.ts';

async function identity() {
  const w = burnerWallet();
  const id = await setupMessagingIdentity(w);
  return { wallet: w, ...id };
}

describe('self-copies', () => {
  it('opens for the sender with the correct `to`, and the recipient cannot open it', async () => {
    const alice = await identity();
    const bob = await identity();
    const id = newMessageId();
    const ts = Date.now();
    const text = 'hello bob';
    const out = sealMessage({ senderWallet: alice.wallet.publicKey, senderSecret: alice.secret, recipientMsgPub: bob.publicKey, text, id, ts });
    const self = sealSelfCopy({
      senderWallet: alice.wallet.publicKey, senderSecret: alice.secret, senderMsgPub: alice.publicKey,
      recipientWallet: bob.wallet.publicKey, text, id, ts,
    });
    expect(self).toHaveLength(out.length);

    const mine = openMessage({ wire: self[0]!, mySecret: alice.secret })!;
    expect(mine).not.toBeNull();
    expect(mine.to).toBe(bob.wallet.publicKey);
    expect(mine.from).toBe(alice.wallet.publicKey);
    expect(mine.id).toBe(id);
    expect(mine.ts).toBe(ts);
    expect(mine.body).toBe(text);
    expect(checkSender(mine, alice.record)).toBe(true);

    expect(openMessage({ wire: self[0]!, mySecret: bob.secret })).toBeNull();
    // Outgoing message has no `to` and is not openable by the sender.
    const bobs = openMessage({ wire: out[0]!, mySecret: bob.secret })!;
    expect(bobs.to).toBeUndefined();
    expect(bobs.id).toBe(id);
    expect(openMessage({ wire: out[0]!, mySecret: alice.secret })).toBeNull();
  });

  it('chunks identically to the outgoing message and reassembles', async () => {
    const alice = await identity();
    const bob = await identity();
    const id = newMessageId();
    const ts = Date.now();
    const text = 'long message ✦ '.repeat(150);
    const out = sealMessage({ senderWallet: alice.wallet.publicKey, senderSecret: alice.secret, recipientMsgPub: bob.publicKey, text, id, ts });
    const self = sealSelfCopy({
      senderWallet: alice.wallet.publicKey, senderSecret: alice.secret, senderMsgPub: alice.publicKey,
      recipientWallet: bob.wallet.publicKey, text, id, ts,
    });
    expect(out.length).toBeGreaterThan(1);
    expect(self).toHaveLength(out.length);
    for (const w of [...out, ...self]) expect(w.length).toBeLessThanOrEqual(MAX_WIRE_LENGTH);

    const parts = self.map((w) => openMessage({ wire: w, mySecret: alice.secret })) as Opened[];
    const outParts = out.map((w) => openMessage({ wire: w, mySecret: bob.secret })) as Opened[];
    outParts.forEach((p, i) => { expect(p.part).toBe(parts[i]!.part); expect(p.body).toBe(parts[i]!.body); });

    const [msg] = reassemble(parts.reverse());
    expect(msg!.body).toBe(text);
    expect(msg!.to).toBe(bob.wallet.publicKey);
    expect(msg!.id).toBe(id);
    expect(reassemble(outParts)[0]!.to).toBeUndefined();
  });
});
