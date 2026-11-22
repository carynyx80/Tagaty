# Pispt — shared contract (all agents MUST follow this exactly)

Monorepo, npm workspaces, Node 22, TypeScript, ESM (`"type": "module"`).
Run TS with `tsx`. Tests with `vitest`. Name constant: `APP_NAME = "Pispt"`.

| Path | Package name | Owner |
|---|---|---|
| `packages/core` | `@primar/core` | core agent |
| `packages/rings` | `@primar/rings` | rings agent |
| `apps/relayer` | `@primar/relayer` | relayer agent (except `src/routes/rings.ts` → rings agent) |
| `apps/web` | `@primar/web` | frontend agent |

Do not edit files outside your own path. Do NOT run `npm install` at the repo root
in parallel with others — install with `npm install <pkgs> -w <your-package>`.

Company treasury wallet (public address only, never holds server keys):
`6T9AvUXqBnSrSxwdLmUnxttgdkSqyWDUQUcYqZf7mkpv`

Default network: **devnet**. Relayer port **8787**. Web port **5173**.
Env (relayer `.env`, all optional): `HELIUS_API_KEY`, `SOLANA_NETWORK=devnet|mainnet`,
`RELAYER_KEYPAIR_PATH` (default `apps/relayer/.relayer-keypair.json`), `PORT=8787`.
RPC = `https://{network}.helius-rpc.com/?api-key=KEY` if key set, else
`https://api.devnet.solana.com`.

## 1. Crypto (`@primar/core`) — libs: @noble/curves, @noble/ciphers, @noble/hashes, bs58

Encoding: base64 = standard base64; wallet addresses = base58.

- **Messaging key derivation**: wallet signs UTF-8 message
  `"Pispt messaging key v1\n" + walletBase58` (ed25519, 64-byte sig).
  `msgSecret = sha256(signature)` → X25519 secret (32 bytes). `msgPub = x25519.getPublicKey(msgSecret)`.
- **Registration**: wallet signs UTF-8 `"primar-register:v1:" + base64(msgPub)`.
  Record: `{ wallet: string, msgPub: string(base64), sig: string(base64) }`.
- **Envelope (sealed sender)**, per message:
  1. ephemeral X25519 keypair `(e, E)`.
  2. `shared = x25519(e, recipientMsgPub)`.
  3. `tag = HMAC-SHA256(shared, "primar-tag")[0..16]`
     `key = HKDF-SHA256(ikm=shared, salt=E, info="primar-key", 32)`.
  4. inner JSON (UTF-8):
     `{ v:1, from: walletBase58, fromMsgPub: base64, id: string(16 hex), part: number, total: number, ts: number(ms), kind: "text"|"payment", body: string, auth: base64 }`
     where `auth = HMAC-SHA256(x25519(senderMsgSecret, recipientMsgPub), "primar-auth" || E || id || part)` (proves the sender without any on-chain signature).
  5. `nonce` 24 random bytes; `ct = XChaCha20-Poly1305(key, nonce, innerJSON)`.
  6. binary = `0x01 | E(32) | tag(16) | nonce(24) | ct`; wire string = `"PRM1:" + base64(binary)`.
- **Opening**: recipient computes `shared = x25519(mySecret, E)`, checks tag (cheap reject),
  decrypts, then verifies `auth` using sender's `fromMsgPub` (and the client must check
  `fromMsgPub` matches the directory record for `from`).
- **Chunking**: max wire string length **700 chars**; long text split into parts sharing `id`.
- **Payment message**: `kind:"payment"`, body = JSON `{ mint: "SOL"|string, amount: string(base units), ringsSignature: string }`.

Exports required (`packages/core/src/index.ts`):
```ts
export const APP_NAME: "Pispt";
export const DERIVE_MESSAGE: (wallet: string) => string;
export const REGISTER_MESSAGE: (msgPubB64: string) => string;
export function deriveMessagingKey(signature: Uint8Array): { secret: Uint8Array; publicKey: Uint8Array };
export function verifyRegistration(rec: { wallet: string; msgPub: string; sig: string }): boolean;
export function sealMessage(args: { senderWallet: string; senderSecret: Uint8Array; recipientMsgPub: Uint8Array; text: string; kind?: "text"|"payment" }): string[]; // wire strings (chunked)
export type Opened = { from: string; fromMsgPub: string; id: string; part: number; total: number; ts: number; kind: "text"|"payment"; body: string };
export function openMessage(args: { wire: string; mySecret: Uint8Array }): Opened | null; // null = not for me / invalid auth
export function reassemble(parts: Opened[]): { id: string; from: string; ts: number; kind: string; body: string }[];
export function b64(u: Uint8Array): string; export function unb64(s: string): Uint8Array;
```
Must work in both browser and Node (no Node-only APIs).

## 2. Relayer HTTP API (`@primar/relayer`, Fastify, base `http://localhost:8787`)

CORS open. JSON everywhere.
- `GET  /v1/health` → `{ ok: true, app: "Pispt", mode: "onchain"|"local", network, relayer: base58|null, balanceLamports: number|null, treasury: string }`
  - `onchain` when relayer keypair has ≥ 0.001 SOL; otherwise `local` (store only, still works).
- `POST /v1/register` body `{ wallet, msgPub, sig }` → `200 { ok: true }` | `400 { error }`.
- `GET  /v1/keys/:wallet` → `{ wallet, msgPub, sig }` | `404 { error }`.
- `POST /v1/messages` body `{ envelope: string }` (must start `PRM1:`, ≤ 700 chars)
  → `200 { id: string, signature: string|null, ts: number }`.
  In `onchain` mode the relayer posts a Memo-program tx (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`)
  with the envelope as data, **relayer as sole signer/fee payer**, returns the tx signature.
- `GET  /v1/messages?since=<id>` → `{ items: { id, envelope, signature, ts }[], cursor: string|null }` (ascending, max 200).
- `WS   /v1/stream` → server pushes `{ type: "message", item: { id, envelope, signature, ts } }`.
- Rate limit: 120 messages/min per IP (env `MESSAGE_RATE_PER_MIN`; long texts are chunked into many envelopes); `429 { error }`.
- Storage: simple JSON file `apps/relayer/data/db.json` (fine for MVP).
- **Profiles** (PUBLIC directory data — NOT encrypted; anyone can look up username → wallet, by design for discovery).
  `Profile = { wallet, username, displayName?, bio?, avatar?, updatedAt }` — validated/signed with `@primar/core`
  (`validateProfileFields`, `PROFILE_MESSAGE`, `verifyProfile`, `signProfile`). Rules: `username` required,
  `/^[a-z0-9_]{3,20}$/`, unique (case-insensitive), reserved `admin|pispt|support|helius|solana`; `displayName` ≤ 40;
  `bio` ≤ 160; `avatar` = `data:image/(png|jpeg|webp);base64,...` ≤ 150000 chars (client resizes to 256px); `updatedAt` ms.
  Signed message: `"pispt-profile:v1:" + JSON.stringify([wallet, username, displayName ?? "", bio ?? "", avatar ? b64(sha256(utf8(avatar))) : "", updatedAt])`.
  - `PUT  /v1/profile` body `{ profile, sig: base64 }` (body limit 256KB) → `200 { ok: true, profile }` |
    `400 { error }` (invalid fields / bad sig / `updatedAt` older than stored or > now+5min) | `409 { error: "username taken" }` |
    `429` (10 writes/min per IP). Changing username frees the old one.
  - `GET  /v1/profile/:wallet` → `{ profile, sig }` | `404 { error }`. (`sig` lets clients run `verifyProfile` themselves.)
  - `GET  /v1/username/:name` → `{ wallet, profile, sig }` | `404 { error }` (start a chat with @username).
  - `GET  /v1/username/:name/available` → `{ available: boolean, reason?: string }` (uppercase/invalid chars → `available:false, reason:"lowercase letters, numbers and _ only"`; not lowercased).
  - `GET  /v1/profiles?wallets=a,b,c` → `{ profiles: Profile[], sigs: Record<wallet, string> }` (max 100 wallets, unknown wallets omitted; >100 → 400).
  - Stored in `apps/relayer/data/db.json` alongside messages.

## 3. Rings payments (`@primar/rings` + relayer route `src/routes/rings.ts`)

Uses `@heliuslabs/spr@0.9.0-alpha` + `@solana/kit@^8.3.0`. Exposed as relayer Fastify plugin
(default export `async function ringsRoutes(app)`), mounted at `/v1/rings`:
- `GET  /v1/rings/status` → `{ enabled: boolean, network, reason?: string }` (enabled only with HELIUS_API_KEY).
- `POST /v1/rings/sponsor` body `{ transaction: base64 }` → relayer validates the tx only touches the
  Privacy Program `ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW` (+ compute budget / system for fees),
  adds its fee-payer signature, submits → `{ signature }`. This is how payments are gas-free.
Client helpers live in `packages/rings/src/client.ts` (browser-safe) for building deposit /
confidential transfer / withdraw with the relayer as fee payer, and reading private balance.
