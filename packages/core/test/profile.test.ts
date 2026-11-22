import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  PROFILE_MESSAGE,
  b64,
  burnerWallet,
  signProfile,
  validateProfileFields,
  verifyProfile,
  type Profile,
} from '../src/index.ts';

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function base(wallet: string, extra: Partial<Profile> = {}): Profile {
  return { wallet, username: 'alice_1', updatedAt: 1_700_000_000_000, ...extra };
}

describe('profiles', () => {
  it('validateProfileFields accepts good profiles', () => {
    const w = burnerWallet();
    expect(validateProfileFields(base(w.publicKey))).toBeNull();
    expect(validateProfileFields(base(w.publicKey, { displayName: 'Alice', bio: 'hi', avatar: AVATAR }))).toBeNull();
  });

  it('validateProfileFields rejects bad fields', () => {
    const w = burnerWallet().publicKey;
    const bad: Partial<Profile>[] = [
      { username: 'Alice' },
      { username: 'ab' },
      { username: 'a'.repeat(21) },
      { username: 'al-ice' },
      { username: 'admin' },
      { username: 'pispt' },
      { displayName: 'x'.repeat(41) },
      { bio: 'x'.repeat(161) },
      { avatar: 'https://example.com/a.png' },
      { avatar: 'data:image/gif;base64,R0lG' },
      { avatar: 'data:image/png;base64,' + 'A'.repeat(150_000) },
      { updatedAt: 0 },
    ];
    for (const b of bad) expect(validateProfileFields(base(w, b)), JSON.stringify(b).slice(0, 60)).toBeTypeOf('string');
    expect(validateProfileFields(base('not-a-wallet'))).toBeTypeOf('string');
    expect(validateProfileFields(null)).toBeTypeOf('string');
    expect(validateProfileFields({ wallet: w, updatedAt: 1 })).toBe('username is required');
  });

  it('PROFILE_MESSAGE is canonical with hashed avatar', () => {
    const p = base('W', { displayName: 'A', avatar: AVATAR });
    const h = b64(sha256(new TextEncoder().encode(AVATAR)));
    expect(PROFILE_MESSAGE(p)).toBe(`pispt-profile:v1:${JSON.stringify(['W', 'alice_1', 'A', '', h, 1_700_000_000_000])}`);
    expect(PROFILE_MESSAGE(base('W'))).toBe('pispt-profile:v1:["W","alice_1","","","",1700000000000]');
  });

  it('verifyProfile checks signature and fields', async () => {
    const w = burnerWallet();
    const p = base(w.publicKey, { bio: 'gm', avatar: AVATAR });
    const sig = await signProfile(w, p);
    expect(verifyProfile(p, sig)).toBe(true);
    expect(verifyProfile({ ...p, bio: 'gn' }, sig)).toBe(false);
    expect(verifyProfile({ ...p, avatar: 'data:image/png;base64,AAAA' }, sig)).toBe(false);
    expect(verifyProfile({ ...p, wallet: burnerWallet().publicKey }, sig)).toBe(false);
    expect(verifyProfile(p, 'garbage')).toBe(false);
    const badField = { ...p, username: 'admin' };
    expect(verifyProfile(badField, await signProfile(w, badField))).toBe(false);
  });
});
