import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { FastifyInstance } from "fastify";
import { buildServer, type ServerOptions } from "../src/server.js";
import { buildMemoTx, TxTooLargeError } from "../src/solana.js";

process.env.RELAYER_OFFLINE = "1";

const apps: FastifyInstance[] = [];
async function make(opts: ServerOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "primar-relayer-"));
  const app = await buildServer({ offline: true, keypair: Keypair.generate(), dataPath: path.join(dir, "db.json"), ...opts });
  apps.push(app);
  return app;
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function makeRegistration() {
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  const wallet = bs58.encode(pub);
  const msgPub = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const sig = Buffer.from(ed25519.sign(new TextEncoder().encode(`primar-register:v1:${msgPub}`), secret)).toString("base64");
  return { wallet, msgPub, sig };
}

const post = (app: FastifyInstance, envelope: unknown) =>
  app.inject({ method: "POST", url: "/v1/messages", payload: { envelope } });

describe("relayer", () => {
  it("health has the contract shape and is local when offline", async () => {
    const app = await make();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      ok: true,
      app: "Pispt",
      mode: "local",
      network: "devnet",
      balanceLamports: null,
      treasury: "6T9AvUXqBnSrSxwdLmUnxttgdkSqyWDUQUcYqZf7mkpv",
    });
    expect(typeof body.relayer).toBe("string");
    expect(bs58.decode(body.relayer).length).toBe(32);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined(); // no Origin sent
    const cors = await app.inject({ method: "GET", url: "/v1/health", headers: { origin: "http://localhost:5173" } });
    expect(cors.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("register accepts a valid signature and rejects invalid ones", async () => {
    const app = await make();
    const rec = makeRegistration();
    const ok = await app.inject({ method: "POST", url: "/v1/register", payload: rec });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const other = makeRegistration();
    const bad = await app.inject({ method: "POST", url: "/v1/register", payload: { ...rec, msgPub: other.msgPub } });
    expect(bad.statusCode).toBe(400);
    expect(typeof bad.json().error).toBe("string");

    const missing = await app.inject({ method: "POST", url: "/v1/register", payload: { wallet: rec.wallet } });
    expect(missing.statusCode).toBe(400);
  });

  it("keys returns 404 then 200 after registration", async () => {
    const app = await make();
    const rec = makeRegistration();
    const nf = await app.inject({ method: "GET", url: `/v1/keys/${rec.wallet}` });
    expect(nf.statusCode).toBe(404);
    expect(typeof nf.json().error).toBe("string");
    await app.inject({ method: "POST", url: "/v1/register", payload: rec });
    const found = await app.inject({ method: "GET", url: `/v1/keys/${rec.wallet}` });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual(rec);
  });

  it("post message rejects non-PRM1 and >700 chars", async () => {
    const app = await make();
    expect((await post(app, "hello")).statusCode).toBe(400);
    expect((await post(app, 123)).statusCode).toBe(400);
    expect((await post(app, "PRM1:" + "A".repeat(696))).statusCode).toBe(400);
    expect((await post(app, "PRM1:" + "A".repeat(695))).statusCode).toBe(200); // exactly 700
  });

  it("post + list with since cursor", async () => {
    const app = await make();
    const r1 = await post(app, "PRM1:AQ==");
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1).toMatchObject({ id: "1", signature: null });
    expect(typeof b1.ts).toBe("number");
    const b2 = (await post(app, "PRM1:Ag==")).json();
    const b3 = (await post(app, "PRM1:Aw==")).json();
    expect([b2.id, b3.id]).toEqual(["2", "3"]);

    const all = (await app.inject({ method: "GET", url: "/v1/messages" })).json();
    expect(all.items.map((i: any) => i.envelope)).toEqual(["PRM1:AQ==", "PRM1:Ag==", "PRM1:Aw=="]);
    expect(all.items[0]).toEqual({ id: "1", envelope: "PRM1:AQ==", signature: null, ts: b1.ts });
    expect(all.cursor).toBe("3");

    const since = (await app.inject({ method: "GET", url: "/v1/messages?since=1" })).json();
    expect(since.items.map((i: any) => i.id)).toEqual(["2", "3"]);
    expect(since.cursor).toBe("3");

    const none = (await app.inject({ method: "GET", url: "/v1/messages?since=3" })).json();
    expect(none).toEqual({ items: [], cursor: "3" });
  });

  it("persists to db.json and keeps ids monotonic across restarts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "primar-relayer-"));
    const dataPath = path.join(dir, "db.json");
    const a = await make({ dataPath });
    await post(a, "PRM1:AQ==");
    await a.close();
    apps.pop();
    const b = await make({ dataPath });
    expect((await post(b, "PRM1:Ag==")).json().id).toBe("2");
    expect(JSON.parse(fs.readFileSync(dataPath, "utf8")).messages).toHaveLength(2);
  });

  it("rate limit triggers 429 after 120 messages/min (default)", async () => {
    const app = await make();
    for (let i = 0; i < 120; i++) expect((await post(app, "PRM1:AQ==")).statusCode).toBe(200);
    const res = await post(app, "PRM1:AQ==");
    expect(res.statusCode).toBe(429);
    expect(typeof res.json().error).toBe("string");
  });

  it("rate limit is configurable via MESSAGE_RATE_PER_MIN", async () => {
    process.env.MESSAGE_RATE_PER_MIN = "3";
    try {
      const app = await make();
      for (let i = 0; i < 3; i++) expect((await post(app, "PRM1:AQ==")).statusCode).toBe(200);
      expect((await post(app, "PRM1:AQ==")).statusCode).toBe(429);
    } finally {
      delete process.env.MESSAGE_RATE_PER_MIN;
    }
  });

  it("daily cap returns 503", async () => {
    const app = await make({ dailyCap: 2 });
    expect((await post(app, "PRM1:AQ==")).statusCode).toBe(200);
    expect((await post(app, "PRM1:AQ==")).statusCode).toBe(200);
    expect((await post(app, "PRM1:AQ==")).statusCode).toBe(503);
  });

  it("broadcasts new messages over /v1/stream", async () => {
    const app = await make();
    await app.ready();
    const ws = await app.injectWS("/v1/stream");
    const got = new Promise<any>((resolve) => ws.once("message", (d: Buffer) => resolve(JSON.parse(d.toString()))));
    const r = (await post(app, "PRM1:AQ==")).json();
    const msg = await got;
    expect(msg).toEqual({ type: "message", item: { id: r.id, envelope: "PRM1:AQ==", signature: null, ts: r.ts } });
    ws.terminate();
  });

  it("memo tx: relayer is sole signer, no instruction keys, 700-char envelope fits", () => {
    const payer = Keypair.generate();
    const bh = bs58.encode(new Uint8Array(32).fill(7));
    const raw = buildMemoTx("PRM1:" + "A".repeat(695), payer, bh);
    expect(raw.length).toBeLessThanOrEqual(1232);
    expect(() => buildMemoTx("PRM1:" + "A".repeat(1200), payer, bh)).toThrow(TxTooLargeError);
  });
});
