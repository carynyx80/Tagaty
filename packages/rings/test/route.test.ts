// Offline tests for the relayer /v1/rings endpoints (directory, Helius proxies, limits, gates).
// Upstream Helius is replaced by a stubbed fetch; nothing touches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { generateKeyPair, getAddressFromPublicKey, signBytes } from "@solana/kit";
import ringsRoutes from "../../../apps/relayer/src/routes/rings.js";
import { signRingsAddressRecord } from "../src/directory.js";

const realFetch = globalThis.fetch;
let dir: string;

function writeKeypair(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const sk = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pk = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const p = join(dir, "kp.json");
  writeFileSync(p, JSON.stringify([...sk, ...pk]));
  return p;
}

async function makeApp(env: Record<string, string | undefined> = {}): Promise<FastifyInstance> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const app = Fastify();
  await app.register(ringsRoutes, { prefix: "/v1/rings" });
  await app.ready();
  return app;
}

async function walletSigner() {
  const kp = await generateKeyPair();
  const publicKey = await getAddressFromPublicKey(kp.publicKey);
  return { publicKey: publicKey as string, sign: async (m: Uint8Array) => new Uint8Array(await signBytes(kp.privateKey, m)) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rings-route-"));
  process.env.RELAYER_KEYPAIR_PATH = writeKeypair();
  process.env.RINGS_DIRECTORY_PATH = join(dir, "dir.json");
  process.env.HELIUS_API_KEY = "test-key";
  process.env.SOLANA_NETWORK = "devnet";
  delete process.env.RINGS_MAINNET_ENABLED;
  delete process.env.RINGS_SPONSOR_PER_MIN;
});
afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
  for (const k of ["RELAYER_KEYPAIR_PATH", "RINGS_DIRECTORY_PATH", "HELIUS_API_KEY", "SOLANA_NETWORK", "RINGS_MAINNET_ENABLED", "RINGS_SPONSOR_PER_MIN"]) delete process.env[k];
});

describe("status gates", () => {
  it("mainnet stays disabled unless RINGS_MAINNET_ENABLED=1", async () => {
    let app = await makeApp({ SOLANA_NETWORK: "mainnet" });
    let r = (await app.inject({ method: "GET", url: "/v1/rings/status" })).json();
    expect(r).toMatchObject({ enabled: false, network: "mainnet" });
    app = await makeApp({ SOLANA_NETWORK: "mainnet", RINGS_MAINNET_ENABLED: "1" });
    r = (await app.inject({ method: "GET", url: "/v1/rings/status" })).json();
    expect(r).toMatchObject({ enabled: true, network: "mainnet" });
    expect(typeof r.feePayer).toBe("string");
  });

  it("proxies refuse to run while disabled", async () => {
    const app = await makeApp({ HELIUS_API_KEY: undefined });
    const r = await app.inject({ method: "POST", url: "/v1/rings/rpc", payload: { jsonrpc: "2.0", id: 1, method: "getSlot" } });
    expect(r.statusCode).toBe(503);
  });
});

describe("Rings address directory", () => {
  it("stores a wallet-signed record and serves it back", async () => {
    const app = await makeApp();
    const w = await walletSigner();
    const owner = (await walletSigner()).publicKey;
    const rec = await signRingsAddressRecord(w, owner);
    const put = await app.inject({ method: "PUT", url: "/v1/rings/address", payload: rec });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: `/v1/rings/address/${w.publicKey}` });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(rec);
    // persisted to disk: a fresh app instance still has it
    const app2 = await makeApp();
    expect((await app2.inject({ method: "GET", url: `/v1/rings/address/${w.publicKey}` })).json().ringsOwner).toBe(owner);
  });

  it("rejects forged or tampered records, and older replacements", async () => {
    const app = await makeApp();
    const w = await walletSigner();
    const other = await walletSigner();
    const rec = await signRingsAddressRecord(w, other.publicKey, 2_000);
    // tampered: different rings owner under the same signature
    const tampered = { ...rec, ringsOwner: w.publicKey };
    expect((await app.inject({ method: "PUT", url: "/v1/rings/address", payload: tampered })).statusCode).toBe(400);
    // signed by someone else
    const forged = { ...(await signRingsAddressRecord(other, other.publicKey, 2_000)), wallet: w.publicKey };
    expect((await app.inject({ method: "PUT", url: "/v1/rings/address", payload: forged })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/v1/rings/address", payload: rec })).statusCode).toBe(200);
    const older = await signRingsAddressRecord(w, w.publicKey, 1_000);
    expect((await app.inject({ method: "PUT", url: "/v1/rings/address", payload: older })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/v1/rings/address/11111111111111111111111111111112" })).statusCode).toBe(404);
  });
});

describe("Solana RPC proxy", () => {
  it("forwards allowlisted methods to Helius with the server-side key", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: new TextDecoder().decode(init.body as Uint8Array) });
      return new Response('{"jsonrpc":"2.0","id":1,"result":123456789012345678901234567890}', { headers: { "content-type": "application/json" } });
    });
    const app = await makeApp();
    const raw = '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"minContextSlot":123456789012345678}]}';
    const r = await app.inject({ method: "POST", url: "/v1/rings/rpc", payload: raw, headers: { "content-type": "application/json" } });
    expect(r.statusCode).toBe(200);
    expect(calls[0]!.url).toBe("https://devnet.helius-rpc.com/?api-key=test-key");
    expect(calls[0]!.body).toBe(raw); // raw bytes forwarded (big integers untouched)
    expect(r.body).toContain("123456789012345678901234567890");
  });

  it("blocks sendTransaction, unknown methods and foreign getProgramAccounts", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("must not be called"); });
    const app = await makeApp();
    const send = (payload: unknown) => app.inject({ method: "POST", url: "/v1/rings/rpc", payload: JSON.stringify(payload), headers: { "content-type": "application/json" } });
    expect((await send({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["x"] })).statusCode).toBe(403);
    expect((await send([{ method: "getSlot" }, { method: "requestAirdrop" }])).statusCode).toBe(403);
    expect((await send({ method: "getProgramAccounts", params: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] })).statusCode).toBe(403);
    expect((await send({ method: "getProgramAccounts", params: ["regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ"] })).statusCode).not.toBe(403);
  });
});

describe("SPR (indexer + prover) proxy", () => {
  it("forwards path, query, TEE headers and binary bodies; replaces any client api-key", async () => {
    let seen: { url: string; headers: Record<string, string>; body: Uint8Array | null; method: string } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen = { url: String(url), headers: init.headers as Record<string, string>, body: init.body ? (init.body as Uint8Array) : null, method: String(init.method) };
      return new Response(new Uint8Array([9, 8, 7]), { status: 202, headers: { "content-type": "application/octet-stream", "spr-tee": "1", "retry-after": "2" } });
    });
    const app = await makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/rings/spr/prove/transfer?job=abc&api-key=attacker",
      payload: Buffer.from([1, 2, 3, 4]),
      headers: { "content-type": "application/octet-stream", "Spr-Tee": "1", "Spr-Tee-Enc": "beef", "X-Async": "true", cookie: "nope" },
    });
    expect(r.statusCode).toBe(202);
    expect(seen!.method).toBe("POST");
    expect(seen!.url).toBe("https://devnet.helius-rpc.com/v1/spr/prove/transfer?job=abc&api-key=test-key");
    expect(seen!.headers).toMatchObject({ "content-type": "application/octet-stream", "spr-tee": "1", "spr-tee-enc": "beef", "x-async": "true" });
    expect(seen!.headers.cookie).toBeUndefined();
    expect([...seen!.body!]).toEqual([1, 2, 3, 4]);
    expect(r.headers["spr-tee"]).toBe("1");
    expect(r.headers["retry-after"]).toBe("2");
    expect(String(r.headers["access-control-expose-headers"])).toContain("Spr-Tee");
    expect([...r.rawPayload]).toEqual([9, 8, 7]);
  });

  it("forwards GET attestation requests and rejects path tricks", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { urls.push(String(url)); return new Response("{}", { headers: { "content-type": "application/json" } }); });
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/v1/rings/spr/attestation?nonce=00ff" })).statusCode).toBe(200);
    expect(urls[0]).toBe("https://devnet.helius-rpc.com/v1/spr/attestation?nonce=00ff&api-key=test-key");
    expect((await app.inject({ method: "GET", url: "/v1/rings/spr/a/..%2F..%2Fadmin" })).statusCode).toBe(400);
  });
});

describe("sponsor limits", () => {
  it("rate limits per IP before doing any work", async () => {
    const app = await makeApp({ RINGS_SPONSOR_PER_MIN: "2" });
    const hit = () => app.inject({ method: "POST", url: "/v1/rings/sponsor", payload: { transaction: "AQID" } });
    expect((await hit()).statusCode).toBe(400);
    expect((await hit()).statusCode).toBe(400);
    const third = await hit();
    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe("rate_limited");
  });
});
