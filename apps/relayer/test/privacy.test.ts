import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { buildServer, type ServerOptions } from "../src/server.js";
import { IpHasher, TRUST_PRIVATE_PROXIES } from "../src/privacy.js";

const apps: FastifyInstance[] = [];
async function make(opts: ServerOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pispt-privacy-"));
  const app = await buildServer({ offline: true, databaseUrl: null, keypair: Keypair.generate(), dataPath: path.join(dir, "db.json"), ...opts });
  apps.push(app);
  return app;
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const IP_A = "203.0.113.7";
const IP_B = "198.51.100.42";
const post = (app: FastifyInstance, ip: string) =>
  app.inject({ method: "POST", url: "/v1/messages", payload: { envelope: "PRM1:AQ==" }, headers: { "x-forwarded-for": ip } });

describe("IP minimization", () => {
  it("GET /v1/privacy", async () => {
    const app = await make();
    const res = await app.inject({ method: "GET", url: "/v1/privacy" });
    expect(res.json()).toEqual({ logsIps: false, storesIps: false, rateLimitKey: "hmac-rotating-daily" });
  });

  it("logs contain no IP addresses, ports or headers", async () => {
    let out = "";
    const stream = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
    const app = await make({ logger: { stream }, trustProxy: TRUST_PRIVATE_PROXIES });
    await post(app, IP_A);
    await app.inject({ method: "GET", url: "/v1/health", headers: { "x-forwarded-for": IP_B, "user-agent": "secret-agent" } });
    await app.inject({ method: "GET", url: "/v1/nope", remoteAddress: "192.0.2.99" } as any);
    expect(out).toContain("incoming request");
    for (const needle of [IP_A, IP_B, "127.0.0.1", "192.0.2.99", "remoteAddress", "remotePort", "secret-agent", "x-forwarded-for"]) {
      expect(out).not.toContain(needle);
    }
  });

  it("rate limit uses X-Forwarded-For (trustProxy) but keeps only HMAC keys in memory", async () => {
    const app = await make({ trustProxy: TRUST_PRIVATE_PROXIES, rateLimitPerMin: 2 });
    expect((await post(app, IP_A)).statusCode).toBe(200);
    expect((await post(app, IP_A)).statusCode).toBe(200);
    expect((await post(app, IP_A)).statusCode).toBe(429);
    expect((await post(app, IP_B)).statusCode).toBe(200); // different client, separate bucket
    const keys = app.rateLimitKeys();
    expect(keys.length).toBe(2);
    for (const k of keys) {
      expect(k).not.toContain(IP_A);
      expect(k).not.toContain(IP_B);
      expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("X-Forwarded-For from an untrusted (public) peer is ignored", async () => {
    const app = await make({ trustProxy: TRUST_PRIVATE_PROXIES, rateLimitPerMin: 1 });
    const fromPublic = (xff: string) =>
      app.inject({ method: "POST", url: "/v1/messages", payload: { envelope: "PRM1:AQ==" }, headers: { "x-forwarded-for": xff }, remoteAddress: "8.8.8.8" } as any);
    expect((await fromPublic(IP_A)).statusCode).toBe(200);
    expect((await fromPublic(IP_B)).statusCode).toBe(429); // spoofed XFF doesn't buy a new bucket
  });

  it("stored data contains no IPs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pispt-privacy-"));
    const dataPath = path.join(dir, "db.json");
    const app = await make({ dataPath, trustProxy: TRUST_PRIVATE_PROXIES });
    await post(app, IP_A);
    await app.close();
    apps.pop();
    expect(fs.readFileSync(dataPath, "utf8")).not.toContain(IP_A);
  });

  it("IpHasher: stable within a day, rotates daily, never returns the IP", () => {
    let t = Date.parse("2026-11-23T10:00:00Z");
    const h = new IpHasher(() => t);
    const k1 = h.key(IP_A);
    expect(h.key(IP_A)).toBe(k1);
    expect(h.key(IP_B)).not.toBe(k1);
    expect(k1).not.toContain(IP_A);
    t += 24 * 3600_000;
    expect(h.key(IP_A)).not.toBe(k1);
    expect(new IpHasher(() => t).key(IP_A)).not.toBe(h.key(IP_A)); // per-process random secret
  });
});
