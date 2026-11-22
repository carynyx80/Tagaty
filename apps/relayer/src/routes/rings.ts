// Rings payments routes — owned by the rings agent. Mounted at /v1/rings by the relayer.
//   GET  /status  -> { enabled, network, reason?, feePayer? }
//   POST /sponsor -> body { transaction: base64 } -> { signature } | 400 { error, code }
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import {
  SponsorRejectedError,
  createRelayerSigner,
  decodeBase64,
  sponsorAndSend,
  type RelayerSigner,
} from "@primar/rings/sponsor";
import { heliusRpcUrl, type RingsNetwork } from "@primar/rings/constants";

function network(): RingsNetwork {
  return process.env.SOLANA_NETWORK === "mainnet" ? "mainnet" : "devnet";
}

function keypairPath(): string {
  if (process.env.RELAYER_KEYPAIR_PATH) return resolve(process.env.RELAYER_KEYPAIR_PATH);
  // Default per CONTRACT: apps/relayer/.relayer-keypair.json. Resolve relative to this file so it
  // works whether the relayer is started from the repo root or from apps/relayer.
  return fileURLToPath(new URL("../../.relayer-keypair.json", import.meta.url));
}

let signerPromise: Promise<RelayerSigner | null> | null = null;
async function loadSigner(): Promise<RelayerSigner | null> {
  signerPromise ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(keypairPath(), "utf8")) as unknown;
      if (!Array.isArray(raw) || raw.length !== 64) return null;
      return await createRelayerSigner(Uint8Array.from(raw as number[]));
    } catch {
      return null;
    }
  })();
  const s = await signerPromise;
  if (!s) signerPromise = null; // retry next time (keypair may be created later)
  return s;
}

async function status() {
  const net = network();
  if (!process.env.HELIUS_API_KEY) {
    return { enabled: false, network: net, reason: "HELIUS_API_KEY not set (Privacy Rings needs a Helius RPC)" };
  }
  const signer = await loadSigner();
  if (!signer) return { enabled: false, network: net, reason: "relayer keypair missing or invalid" };
  return { enabled: true, network: net, feePayer: signer.address as string };
}

export default async function ringsRoutes(app: FastifyInstance) {
  app.get("/status", async () => status());

  app.post("/sponsor", async (req, reply) => {
    const s = await status();
    if (!s.enabled) return reply.code(503).send({ error: `rings disabled: ${s.reason}` });
    const signer = (await loadSigner())!;

    const body = req.body as { transaction?: unknown } | undefined;
    if (!body || typeof body.transaction !== "string") {
      return reply.code(400).send({ error: "body must be { transaction: base64 }", code: "bad_request" });
    }
    try {
      const txBytes = decodeBase64(body.transaction);
      const { signature } = await sponsorAndSend({
        txBytes,
        relayer: signer,
        rpcUrl: heliusRpcUrl(s.network as RingsNetwork, process.env.HELIUS_API_KEY!),
      });
      return { signature };
    } catch (e) {
      if (e instanceof SponsorRejectedError) {
        req.log.warn({ code: e.code }, `rings sponsor rejected: ${e.message}`);
        return reply.code(400).send({ error: `rejected: ${e.message}`, code: e.code });
      }
      // RPC / simulation failure — the tx was well-formed but did not land.
      const msg = (e as Error).message ?? String(e);
      req.log.error({ err: e }, "rings sponsor submit failed");
      return reply.code(400).send({ error: `submit failed: ${msg}`, code: "submit_failed" });
    }
  });
}
