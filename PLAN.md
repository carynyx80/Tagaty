# Pispt — Build Plan (working name, rename later)

> Private messaging on Solana. What you say, who you say it to, and what you
> receive stay between you and the people you choose. No gas.
> *Powered by Helius Privacy Rings on Solana.*

## Decisions (locked)

| Topic | Decision |
|---|---|
| Name | **Pispt** (working name — kept in one config constant so renaming is a one-line change) |
| Gas | **Users never pay gas.** The relayer pays every fee. |
| Message storage | Encrypted messages posted **on Solana** as transaction data (relayer-paid, ~500 chars/msg, longer messages split). |
| Helius Privacy Rings | **Private payments inside chats** — send SOL/tokens with encrypted amounts via the Default Ring. |
| Company wallet | `6T9AvUXqBnSrSxwdLmUnxttgdkSqyWDUQUcYqZf7mkpv` — **treasury only**. It tops up a separate *relayer hot wallet*; its private key never touches a server. |
| Network | **Devnet first**, mainnet via one env change. *(assumed — confirm)* |
| Helius API key | Lives in `.env` only, never in code or chat. App runs locally without one. |

## MVP features

1. Sign in with Phantom/Backpack, or a browser burner wallet for testing.
2. Sign one message → derive a private messaging key (no new seed phrase).
3. Start a chat by wallet address (`.sol` names later).
4. Send/receive end-to-end encrypted messages, gas-free, in real time.
5. Send private payments in a chat (amount hidden, via Privacy Rings).
6. "See the proof": each message links to its tx — explorer shows only
   ciphertext and the relayer's address.
7. Landing page with the manifesto.

## Privacy model

| Promise | How |
|---|---|
| What you send | Encrypted on-device (X25519 key agreement + XChaCha20-Poly1305). Relayer can't read it. |
| Who you send it to | Messages addressed to a **one-time inbox tag** derived from a secret only the two parties share — fresh per message, never a wallet address. |
| Who sent it | Relayer signs and pays the tx; sender's wallet never appears on-chain. Sender authenticity is proven *inside* the ciphertext. |
| What you receive | Client scans for tags only it can recognise; decrypts locally. |
| Payments | Privacy Rings encrypt amount + memo. **Caveat:** Default Ring keeps sender/recipient wallets public, and deposits/withdrawals are public — shown clearly in the UI. |

## Architecture

```
apps/web      Next.js + React — wallet, chat UI, ALL crypto runs here
apps/relayer  Node (Fastify) — accepts encrypted envelopes, rate-limits,
              posts to Solana, pays fees, pushes live updates
packages/core Shared TypeScript: key derivation, envelope format,
              encrypt/decrypt, inbox tags, chunking (+ unit tests)
```

- **Key directory**: wallet → public messaging key, registered with a wallet
  signature (stored by relayer + posted on-chain so it's verifiable).
- **Delivery**: relayer posts envelope via Memo-style tx → Helius websocket /
  relayer push → recipient client matches tag → decrypts.
- **Payments**: `@heliuslabs/spr@0.9.0-alpha` — deposit → `ConfidentialTransfer`
  → `proveTransact` → `transactInstruction`, with the relayer as fee payer
  where the SDK allows.

### Message flow
```
type → encrypt on device → wrap with one-time tag → relayer
     → relayer posts tx (pays gas) → Solana → websocket
     → recipient spots its tag → decrypts → shows message
```

## Relayer abuse protection
- Rate limit per messaging key + per IP.
- Daily fee budget cap; relayer refuses when hot wallet drops below a floor
  and alerts so the treasury can top it up.

## Build order (all in one pass)
1. `packages/core` crypto + tests
2. Relayer (devnet posting, key directory, rate limits)
3. Web app: sign-in, chat list, conversation view
4. Real-time delivery
5. Privacy Rings payments
6. Landing page (manifesto)
7. End-to-end test: two wallets chatting on devnet

## Known limits (v1)
- Relayer can see sender IP (fix later: Tor / mixnet).
- ~500 chars per on-chain message; longer ones are chunked.
- Rings SDK is alpha — may change; payments isolated behind one module.
- Relayer cost ≈ 0.000005 SOL per message (~5 SOL per 1M messages).
