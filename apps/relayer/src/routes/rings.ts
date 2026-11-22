// Rings payments routes — owned by the rings agent. Mounted at /v1/rings by the relayer.
//
//   GET  /status                 -> { enabled, network, reason?, feePayer? }
//   POST /sponsor                -> body { transaction: base64 } -> { signature } | 400 { error, code }
//   GET  /address/:wallet        -> RingsAddressRecord | 404   (wallet -> Rings owner, wallet-signed)
//   PUT  /address                -> body RingsAddressRecord -> { ok: true } | 400
//   POST /rpc                    -> Solana JSON-RPC proxy (read-only method allowlist) to Helius
//   ANY  /spr/*                  -> Helius /v1/spr proxy (Photon indexer + TEE prover)
//
// Why a proxy: the SPR SDK runs in the browser (all user secrets stay there), but Helius needs
// an API key, which must not ship to browsers. The relayer only forwards; prover payloads are
// HPKE-encrypted by the SDK to the attested enclave, and the SDK binds the route *below* the
// prover URL with api-key pairs excluded, explicitly so "a proxy can serve the prover under any
// path" and "move the credential" (@heliuslabs/spr dist/client/prover/tee/encryption.js).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  SponsorRejectedError,
  createRelayerSigner,
  decodeBase64,
  sponsorAndSend,
  type RelayerSigner,
} from "@primar/rings/sponsor";
import { verifyRingsAddressRecord, type RingsAddressRecord } from "@primar/rings/directory";
import { type RingsNetwork } from "@primar/rings/constants";

function network(): RingsNetwork {
  return process.env.SOLANA_NETWORK === "mainnet" ? "mainnet" : "devnet";
}
const heliusRoot = (net: RingsNetwork) => `https://${net}.helius-rpc.com`;

// ------------------------------------------------------------------ relayer key

function keypairPath(): string {
  if (process.env.RELAYER_KEYPAIR_PATH) return resolve(process.env.RELAYER_KEYPAIR_PATH);
  return fileURLToPath(new URL("../../.relayer-keypair.json", import.meta.url));
}

let signerPromise: Promise<RelayerSigner | null> | null = null;
async function loadSigner(app: FastifyInstance): Promise<RelayerSigner | null> {
  signerPromise ??= (async () => {
    try {
      // Prefer the keypair the relayer already loaded (same key that posts messages).
      const sk = (app as unknown as { relayer?: { keypair?: { secretKey?: Uint8Array } } }).relayer?.keypair?.secretKey;
      if (sk && sk.length === 64) return await createRelayerSigner(Uint8Array.from(sk));
      const raw = JSON.parse(await readFile(keypairPath(), "utf8")) as unknown;
      if (!Array.isArray(raw) || raw.length !== 64) return null;
      return await createRelayerSigner(Uint8Array.from(raw as number[]));
    } catch {
      return null;
    }
  })();
  const s = await signerPromise;
  if (!s) signerPromise = null;
  return s;
}

// ------------------------------------------------------------------ limits

function limiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.size > 20_000) hits.clear();
    if (arr.length >= limit) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}
const envInt = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// ------------------------------------------------------------------ directory store

function directoryPath(): string {
  if (process.env.RINGS_DIRECTORY_PATH) return resolve(process.env.RINGS_DIRECTORY_PATH);
  if (process.env.DATA_PATH) return join(dirname(resolve(process.env.DATA_PATH)), "rings-addresses.json");
  return fileURLToPath(new URL("../../data/rings-addresses.json", import.meta.url));
}
class Directory {
  private data: Record<string, RingsAddressRecord> | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  private async load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await readFile(this.file, "utf8")) as Record<string, RingsAddressRecord>;
    } catch {
      this.data = {};
    }
    return this.data;
  }
  async get(wallet: string) {
    return (await this.load())[wallet];
  }
  async put(rec: RingsAddressRecord) {
    const d = await this.load();
    d[rec.wallet] = rec;
    const snapshot = JSON.stringify(d);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, this.file);
    }).catch(() => {});
    await this.writing;
  }
}

// ------------------------------------------------------------------ proxy helpers

/** Read-only Solana RPC methods the SPR SDK needs. No sendTransaction: submission goes through /sponsor. */
export const RPC_METHODS = new Set([
  "getAccountInfo", "getMultipleAccounts", "getLatestBlockhash", "getSlot", "getBlockHeight", "getBalance",
  "getSignatureStatuses", "getTransaction", "getMinimumBalanceForRentExemption", "getEpochInfo",
  "isBlockhashValid", "getFeeForMessage", "getHealth", "getVersion", "getGenesisHash",
  "getTokenAccountBalance", "getTokenAccountsByOwner", "getProgramAccounts",
]);
/** getProgramAccounts only for the Rings programs (the SDK scans the registry). */
const GPA_PROGRAMS = new Set(["regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ", "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW"]);

function checkRpcBody(body: unknown): string | null {
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > 20) return "batch must have 1-20 calls";
  for (const c of calls) {
    const m = (c as { method?: unknown })?.method;
    if (typeof m !== "string" || !RPC_METHODS.has(m)) return `RPC method not allowed: ${String(m)}`;
    if (m === "getProgramAccounts") {
      const p = (c as { params?: unknown[] }).params?.[0];
      if (typeof p !== "string" || !GPA_PROGRAMS.has(p)) return "getProgramAccounts only allowed for Rings programs";
    }
  }
  return null;
}

/** Request headers the SDK uses towards the indexer/prover (TEE envelope + async/sync mode). */
const FWD_REQ_HEADERS = ["content-type", "accept", "spr-tee", "spr-tee-enc", "spr-tee-ciphertext", "x-sync", "x-async"];
const FWD_RES_HEADERS = ["content-type", "spr-tee", "spr-tee-enc", "retry-after", "location"];
const EXPOSE = "Spr-Tee, Spr-Tee-Enc, Retry-After, Location";

async function forward(reply: FastifyReply, upstream: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetch(upstream, { ...init, redirect: "manual" });
  } catch (e) {
    return reply.code(502).send({ error: `upstream unreachable: ${(e as Error).message}` });
  }
  reply.code(res.status);
  for (const h of FWD_RES_HEADERS) {
    const v = res.headers.get(h);
    if (v) reply.header(h, v);
  }
  reply.header("access-control-expose-headers", EXPOSE);
  return reply.send(Buffer.from(await res.arrayBuffer()));
}

// ------------------------------------------------------------------ routes

export default async function ringsRoutes(app: FastifyInstance) {
  const sponsorLimit = limiter(envInt("RINGS_SPONSOR_PER_MIN", 12), 60_000);
  const dailyCap = envInt("RINGS_SPONSOR_DAILY_CAP", 500);
  let day = new Date().toISOString().slice(0, 10);
  let sponsoredToday = 0;
  const proxyLimit = limiter(envInt("RINGS_PROXY_PER_MIN", 600), 60_000);
  const dirLimit = limiter(30, 60_000);
  const directory = new Directory(directoryPath());

  async function status() {
    const net = network();
    if (!process.env.HELIUS_API_KEY) {
      return { enabled: false, network: net, reason: "HELIUS_API_KEY not set (Privacy Rings needs a Helius RPC)" };
    }
    if (net === "mainnet" && process.env.RINGS_MAINNET_ENABLED !== "1") {
      return { enabled: false, network: net, reason: "Private payments are paused on mainnet until a live test payment succeeds" };
    }
    const signer = await loadSigner(app);
    if (!signer) return { enabled: false, network: net, reason: "relayer keypair missing or invalid" };
    return { enabled: true, network: net, feePayer: signer.address as string };
  }
  const key = (req: FastifyRequest) => req.ip;

  app.get("/status", async () => status());

  app.post("/sponsor", async (req, reply) => {
    const s = await status();
    if (!s.enabled) return reply.code(503).send({ error: `rings disabled: ${s.reason}` });
    const body = req.body as { transaction?: unknown } | undefined;
    if (!body || typeof body.transaction !== "string") {
      return reply.code(400).send({ error: "body must be { transaction: base64 }", code: "bad_request" });
    }
    if (!sponsorLimit(key(req))) return reply.code(429).send({ error: "too many sponsored transactions, slow down", code: "rate_limited" });
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) { day = today; sponsoredToday = 0; }
    if (sponsoredToday >= dailyCap) return reply.code(429).send({ error: "daily sponsorship cap reached, try tomorrow", code: "daily_cap" });
    const signer = (await loadSigner(app))!;
    try {
      const txBytes = decodeBase64(body.transaction);
      const { signature } = await sponsorAndSend({
        txBytes,
        relayer: signer,
        rpcUrl: `${heliusRoot(s.network as RingsNetwork)}/?api-key=${encodeURIComponent(process.env.HELIUS_API_KEY!)}`,
      });
      sponsoredToday++;
      return { signature };
    } catch (e) {
      if (e instanceof SponsorRejectedError) {
        req.log.warn({ code: e.code }, `rings sponsor rejected: ${e.message}`);
        return reply.code(400).send({ error: `rejected: ${e.message}`, code: e.code });
      }
      const msg = (e as Error).message ?? String(e);
      // Kit RPC errors carry simulation logs in `context`; surface them so the user sees the real cause.
      const logs = (e as { context?: { logs?: string[] } }).context?.logs;
      req.log.error({ err: e }, "rings sponsor submit failed");
      return reply.code(400).send({ error: `submit failed: ${msg}`, code: "submit_failed", ...(logs ? { logs: logs.slice(-12) } : {}) });
    }
  });

  // -------- directory
  app.get("/address/:wallet", async (req, reply) => {
    const { wallet } = req.params as { wallet: string };
    const rec = await directory.get(wallet);
    if (!rec) return reply.code(404).send({ error: "this wallet hasn't enabled private payments yet" });
    return rec;
  });

  app.put("/address", async (req, reply) => {
    if (!dirLimit(key(req))) return reply.code(429).send({ error: "rate limited" });
    const rec = req.body as RingsAddressRecord;
    if (!(await verifyRingsAddressRecord(rec))) return reply.code(400).send({ error: "invalid or unsigned Rings address record" });
    if (rec.ts > Date.now() + 5 * 60_000) return reply.code(400).send({ error: "record timestamp is in the future" });
    const prev = await directory.get(rec.wallet);
    if (prev && prev.ts > rec.ts) return reply.code(409).send({ error: "a newer record exists", record: prev });
    await directory.put({ wallet: rec.wallet, ringsOwner: rec.ringsOwner, ts: rec.ts, sig: rec.sig });
    return { ok: true };
  });

  // -------- Helius proxies (raw bodies; own content-type parsers in this encapsulated scope)
  await app.register(async (proxy) => {
    proxy.removeAllContentTypeParsers();
    proxy.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    proxy.post("/rpc", async (req, reply) => {
      const s = await status();
      if (!s.enabled) return reply.code(503).send({ error: `rings disabled: ${s.reason}` });
      if (!proxyLimit(key(req))) return reply.code(429).send({ error: "rate limited" });
      const raw = req.body as Buffer | undefined;
      let parsed: unknown;
      try { parsed = JSON.parse(raw?.toString("utf8") ?? ""); } catch { return reply.code(400).send({ error: "invalid JSON-RPC body" }); }
      const bad = checkRpcBody(parsed);
      if (bad) return reply.code(403).send({ error: bad });
      return forward(reply, `${heliusRoot(s.network as RingsNetwork)}/?api-key=${encodeURIComponent(process.env.HELIUS_API_KEY!)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Uint8Array(raw!),
      });
    });

    const spr = async (req: FastifyRequest, reply: FastifyReply) => {
      const s = await status();
      if (!s.enabled) return reply.code(503).send({ error: `rings disabled: ${s.reason}` });
      if (!proxyLimit(key(req))) return reply.code(429).send({ error: "rate limited" });
      const rest = (req.params as { "*"?: string })["*"] ?? "";
      if (rest.includes("..") || /[^A-Za-z0-9/_\-.]/.test(rest)) return reply.code(400).send({ error: "bad path" });
      const u = new URL(req.url, "http://x");
      const q = new URLSearchParams(u.search);
      q.delete("api-key"); // never let a client choose the credential
      q.set("api-key", process.env.HELIUS_API_KEY!);
      const upstream = `${heliusRoot(s.network as RingsNetwork)}/v1/spr${rest ? `/${rest}` : ""}?${q.toString()}`;
      const headers: Record<string, string> = {};
      for (const h of FWD_REQ_HEADERS) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && Buffer.isBuffer(req.body);
      return forward(reply, upstream, { method: req.method, headers, ...(hasBody ? { body: new Uint8Array(req.body as Buffer) } : {}) });
    };
    proxy.route({ method: ["GET", "POST"], url: "/spr", handler: spr });
    proxy.route({ method: ["GET", "POST"], url: "/spr/*", handler: spr });
  });
}
