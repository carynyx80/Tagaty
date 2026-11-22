import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  APP_NAME,
  MAX_ENVELOPE_CHARS,
  MIN_ONCHAIN_LAMPORTS,
  PKG_DIR,
  TREASURY,
  getDailyCap,
  getMessageRatePerMin,
  getKeypairPath,
  getNetwork,
  getRpcUrl,
  loadEnv,
  redactRpcUrl,
  type Network,
} from "./config.js";
import { JsonDb, type MessageItem } from "./db.js";
import { loadOrCreateKeypair, postMemo, TxTooLargeError } from "./solana.js";
import { verifyRegistration } from "./verify.js";
import ringsRoutes from "./routes/rings.js";
import { registerProfileRoutes } from "./profiles.js";

export type ServerOptions = {
  /** Never touch the network; always "local" mode. Also enabled by RELAYER_OFFLINE=1. */
  offline?: boolean;
  /** Path to db.json (default apps/relayer/data/db.json). */
  dataPath?: string;
  /** Use this keypair instead of loading/creating one from disk. */
  keypair?: Keypair;
  keypairPath?: string;
  network?: Network;
  rateLimitPerMin?: number;
  profileRateLimitPerMin?: number;
  dailyCap?: number;
  balanceRefreshMs?: number;
  logger?: boolean;
};

export type RelayerContext = {
  keypair: Keypair;
  network: Network;
  connection: Connection | null;
  /** Current mode: "onchain" when the relayer holds >= 0.001 SOL. */
  getMode: () => "onchain" | "local";
};

declare module "fastify" {
  interface FastifyInstance {
    relayer: RelayerContext;
  }
}

/** Sliding-window per-key limiter. */
function makeRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      hits.set(key, arr);
      return false;
    }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
    return true;
  };
}

export async function buildServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  loadEnv();
  const offline = opts.offline ?? process.env.RELAYER_OFFLINE === "1";
  const network = opts.network ?? getNetwork();
  const rateLimitPerMin = opts.rateLimitPerMin ?? getMessageRatePerMin();
  const dailyCap = opts.dailyCap ?? getDailyCap();
  const refreshMs = opts.balanceRefreshMs ?? 60_000;

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });
  await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PUT", "OPTIONS"] });
  await app.register(websocket);

  const db = new JsonDb(opts.dataPath ?? process.env.DATA_PATH ?? path.join(PKG_DIR, "data", "db.json"));

  let keypair: Keypair;
  if (opts.keypair) keypair = opts.keypair;
  else {
    const kpPath = opts.keypairPath ?? getKeypairPath();
    const { keypair: kp, created } = loadOrCreateKeypair(kpPath);
    keypair = kp;
    app.log.info({ path: kpPath, created }, created ? "generated new relayer keypair" : "loaded relayer keypair");
  }
  const relayerPubkey = keypair.publicKey.toBase58();

  const rpcUrl = getRpcUrl(network);
  const connection = offline ? null : new Connection(rpcUrl, "confirmed");
  let balanceLamports: number | null = null;
  let mode: "onchain" | "local" = "local";

  const refreshBalance = async () => {
    if (!connection) return;
    try {
      balanceLamports = await connection.getBalance(keypair.publicKey, "confirmed");
      const next = balanceLamports >= MIN_ONCHAIN_LAMPORTS ? "onchain" : "local";
      if (next !== mode) app.log.info({ balanceLamports, mode: next }, "relayer mode changed");
      mode = next;
    } catch (err: any) {
      app.log.warn({ err: err?.message }, "balance check failed (keeping previous mode)");
    }
  };

  const tryAirdrop = async () => {
    if (!connection || network !== "devnet" || balanceLamports !== 0) return;
    try {
      app.log.info("devnet balance is 0, requesting 1 SOL airdrop");
      const sig = await connection.requestAirdrop(keypair.publicKey, LAMPORTS_PER_SOL);
      const bh = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      app.log.info({ sig }, "devnet airdrop confirmed");
      await refreshBalance();
    } catch (err: any) {
      app.log.warn({ err: err?.message }, "devnet airdrop failed (faucet is often rate limited) — fund the relayer manually");
    }
  };

  let timer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    app.log.info(
      { relayer: relayerPubkey, network, rpc: offline ? null : redactRpcUrl(rpcUrl), offline },
      `relayer public key ${relayerPubkey} — fund it from treasury ${TREASURY} (≥ 0.001 SOL enables onchain mode)`,
    );
    if (!connection) return;
    // Don't block startup on RPC.
    void (async () => {
      await refreshBalance();
      await tryAirdrop();
      app.log.info({ mode, balanceLamports }, "relayer mode");
    })();
    timer = setInterval(() => void refreshBalance(), refreshMs);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await db.flush();
  });

  app.decorate("relayer", { keypair, network, connection, getMode: () => mode } satisfies RelayerContext);

  const limiter = makeRateLimiter(rateLimitPerMin, 60_000);
  let capDay = "";
  let capCount = 0;
  const underDailyCap = () => {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== capDay) {
      capDay = day;
      capCount = 0;
    }
    return capCount < dailyCap;
  };

  // ---- routes ----
  app.get("/v1/health", async () => ({
    ok: true as const,
    app: APP_NAME,
    mode,
    network,
    relayer: relayerPubkey,
    balanceLamports,
    treasury: TREASURY,
  }));

  app.post("/v1/register", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { wallet, msgPub, sig } = body;
    if (typeof wallet !== "string" || typeof msgPub !== "string" || typeof sig !== "string") {
      return reply.code(400).send({ error: "body must be { wallet, msgPub, sig } strings" });
    }
    if (!verifyRegistration({ wallet, msgPub, sig })) {
      return reply.code(400).send({ error: "invalid registration signature" });
    }
    await db.putRegistration({ wallet, msgPub, sig });
    return { ok: true as const };
  });

  app.get<{ Params: { wallet: string } }>("/v1/keys/:wallet", async (req, reply) => {
    const rec = db.getRegistration(req.params.wallet);
    if (!rec) return reply.code(404).send({ error: "wallet not registered" });
    return rec;
  });

  app.post("/v1/messages", async (req, reply) => {
    if (!limiter(req.ip)) return reply.code(429).send({ error: `rate limit exceeded (${rateLimitPerMin} messages/min)` });
    const envelope = (req.body as any)?.envelope;
    if (typeof envelope !== "string" || !envelope.startsWith("PRM1:")) {
      return reply.code(400).send({ error: "envelope must be a string starting with PRM1:" });
    }
    if (envelope.length > MAX_ENVELOPE_CHARS) {
      return reply.code(400).send({ error: `envelope exceeds ${MAX_ENVELOPE_CHARS} chars` });
    }
    if (!underDailyCap()) return reply.code(503).send({ error: "daily message budget exhausted, try again tomorrow" });

    let signature: string | null = null;
    if (mode === "onchain" && connection) {
      try {
        signature = await postMemo(connection, keypair, envelope, (err, sig) =>
          app.log.warn({ sig, err: (err as any)?.message ?? err }, "memo tx failed to confirm"),
        );
      } catch (err: any) {
        if (err instanceof TxTooLargeError) return reply.code(413).send({ error: err.message });
        // Degrade gracefully: still store + relay, just without an on-chain signature.
        app.log.warn({ err: err?.message }, "memo tx send failed; storing locally");
        void refreshBalance();
      }
    }

    capCount++;
    const item: MessageItem = { id: db.nextId(), envelope, signature, ts: Date.now() };
    await db.appendMessage(item);
    const payload = JSON.stringify({ type: "message", item });
    for (const client of app.websocketServer.clients) {
      if (client.readyState === 1) client.send(payload);
    }
    return { id: item.id, signature: item.signature, ts: item.ts };
  });

  app.get<{ Querystring: { since?: string } }>("/v1/messages", async (req) => {
    const s = Number(req.query.since);
    const since = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
    const items = db.listSince(since, 200);
    const cursor = items.length ? items[items.length - 1].id : req.query.since ? String(since) : null;
    return { items, cursor };
  });

  app.get("/v1/stream", { websocket: true }, (socket) => {
    socket.on("message", () => {
      /* server-push only; ignore client messages */
    });
  });

  registerProfileRoutes(app, db, makeRateLimiter(opts.profileRateLimitPerMin ?? 10, 60_000));

  await app.register(ringsRoutes, { prefix: "/v1/rings" });

  return app;
}
