import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import ringsRoutes from "../../../apps/relayer/src/routes/rings.js";

describe("relayer rings route (offline)", () => {
  it("status disabled without key; sponsor rejects bad tx with 400", async () => {
    delete process.env.HELIUS_API_KEY;
    const app = Fastify();
    await app.register(ringsRoutes, { prefix: "/v1/rings" });
    let r = await app.inject({ method: "GET", url: "/v1/rings/status" });
    expect(r.json()).toMatchObject({ enabled: false, network: "devnet" });

    // 64-byte keypair file
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const sk = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    const pk = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const dir = mkdtempSync(join(tmpdir(), "rings-"));
    process.env.RELAYER_KEYPAIR_PATH = join(dir, "kp.json");
    writeFileSync(process.env.RELAYER_KEYPAIR_PATH, JSON.stringify([...sk, ...pk]));
    process.env.HELIUS_API_KEY = "test-not-real";
    r = await app.inject({ method: "GET", url: "/v1/rings/status" });
    expect(r.json()).toMatchObject({ enabled: true, network: "devnet" });
    expect(typeof r.json().feePayer).toBe("string");

    r = await app.inject({ method: "POST", url: "/v1/rings/sponsor", payload: { transaction: "AQID" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("decode");
    r = await app.inject({ method: "POST", url: "/v1/rings/sponsor", payload: {} });
    expect(r.statusCode).toBe(400);
    delete process.env.HELIUS_API_KEY;
    delete process.env.RELAYER_KEYPAIR_PATH;
  });
});
