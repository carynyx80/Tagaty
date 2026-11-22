import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { burnerWallet, signProfile, verifyProfile, type BurnerWallet, type Profile } from "@primar/core";
import { buildServer, type ServerOptions } from "../src/server.js";

process.env.RELAYER_OFFLINE = "1";

const apps: FastifyInstance[] = [];
async function make(opts: ServerOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pispt-profiles-"));
  const app = await buildServer({ offline: true, keypair: Keypair.generate(), dataPath: path.join(dir, "db.json"), ...opts });
  apps.push(app);
  return app;
}
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

let clock = Date.now() - 60_000;
async function signed(w: BurnerWallet, fields: Partial<Profile> & { username: string }) {
  const profile: Profile = { wallet: w.publicKey, updatedAt: ++clock, ...fields };
  return { profile, sig: await signProfile(w, profile) };
}
const put = (app: FastifyInstance, payload: unknown) => app.inject({ method: "PUT", url: "/v1/profile", payload: payload as any });
const get = (app: FastifyInstance, url: string) => app.inject({ method: "GET", url });

describe("profiles", () => {
  it("PUT valid profile, then GET by wallet and username", async () => {
    const app = await make();
    const w = burnerWallet();
    const body = await signed(w, { username: "alice", displayName: "Alice", bio: "gm", avatar: "data:image/png;base64,iVBORw0KGgo=" });
    const res = await put(app, body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, profile: body.profile });

    expect((await get(app, `/v1/profile/${w.publicKey}`)).json()).toEqual({ profile: body.profile, sig: body.sig });
    const byName = await get(app, "/v1/username/ALICE");
    expect(byName.statusCode).toBe(200);
    expect(byName.json()).toEqual({ wallet: w.publicKey, profile: body.profile, sig: body.sig });
    expect(verifyProfile(byName.json().profile, byName.json().sig)).toBe(true);
    expect((await get(app, "/v1/username/nobody")).statusCode).toBe(404);
    expect((await get(app, `/v1/profile/${burnerWallet().publicKey}`)).statusCode).toBe(404);
  });

  it("rejects bad or missing signature", async () => {
    const app = await make();
    const w = burnerWallet();
    const body = await signed(w, { username: "bob" });
    expect((await put(app, { ...body, profile: { ...body.profile, bio: "tampered" } })).statusCode).toBe(400);
    expect((await put(app, { profile: body.profile, sig: (await signed(burnerWallet(), { username: "bob" })).sig })).statusCode).toBe(400);
    expect((await put(app, { profile: body.profile })).statusCode).toBe(400);
  });

  it("taken username → 409; rename frees the old name", async () => {
    const app = await make();
    const a = burnerWallet();
    const b = burnerWallet();
    expect((await put(app, await signed(a, { username: "carol" }))).statusCode).toBe(200);
    const taken = await put(app, await signed(b, { username: "carol" }));
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: "username taken" });

    expect((await put(app, await signed(a, { username: "carol2" }))).statusCode).toBe(200);
    expect((await get(app, "/v1/username/carol")).statusCode).toBe(404);
    expect((await get(app, "/v1/username/carol2")).json().wallet).toBe(a.publicKey);
    expect((await put(app, await signed(b, { username: "carol" }))).statusCode).toBe(200);
    expect((await get(app, "/v1/username/carol")).json().wallet).toBe(b.publicKey);
  });

  it("rejects stale and far-future updatedAt", async () => {
    const app = await make();
    const w = burnerWallet();
    const older = await signed(w, { username: "dave" });
    const newer = await signed(w, { username: "dave", bio: "v2" });
    expect((await put(app, newer)).statusCode).toBe(200);
    const stale = await put(app, older);
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error).toMatch(/stale/);
    const future = await signed(w, { username: "dave", updatedAt: Date.now() + 10 * 60_000 });
    expect((await put(app, future)).statusCode).toBe(400);
    expect((await get(app, `/v1/profile/${w.publicKey}`)).json().profile.bio).toBe("v2");
  });

  it("oversized avatar → 400 (not 413) and bad fields → 400", async () => {
    const app = await make();
    const w = burnerWallet();
    const big = await signed(w, { username: "erin", avatar: "data:image/png;base64," + "A".repeat(150_000) });
    const res = await put(app, big);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTypeOf("string");
    expect((await put(app, await signed(w, { username: "admin" }))).statusCode).toBe(400);
    expect((await put(app, await signed(w, { username: "erin", displayName: "x".repeat(41) }))).statusCode).toBe(400);
    // a max-size valid avatar fits in the 256KB route body limit
    const ok = await signed(w, { username: "erin", avatar: "data:image/webp;base64," + "A".repeat(149_976) });
    expect((await put(app, ok)).statusCode).toBe(200);
  });

  it("username availability", async () => {
    const app = await make();
    expect((await get(app, "/v1/username/frank/available")).json()).toEqual({ available: true });
    await put(app, await signed(burnerWallet(), { username: "frank" }));
    expect((await get(app, "/v1/username/frank/available")).json()).toEqual({ available: false, reason: "username taken" });
    expect((await get(app, "/v1/username/Zed/available")).json()).toEqual({ available: false, reason: "lowercase letters, numbers and _ only" });
    expect((await get(app, "/v1/username/Frank/available")).json()).toEqual({ available: false, reason: "lowercase letters, numbers and _ only" });
    const reserved = (await get(app, "/v1/username/solana/available")).json();
    expect(reserved.available).toBe(false);
    expect(reserved.reason).toMatch(/reserved/);
    expect((await get(app, "/v1/username/a!/available")).json().available).toBe(false);
  });

  it("batch lookup by wallets", async () => {
    const app = await make();
    const a = burnerWallet();
    const b = burnerWallet();
    const ga = await signed(a, { username: "gina" });
    const hb = await signed(b, { username: "hank" });
    await put(app, ga);
    await put(app, hb);
    const res = (await get(app, `/v1/profiles?wallets=${a.publicKey},${burnerWallet().publicKey},${b.publicKey}`)).json();
    expect(res.profiles.map((p: Profile) => p.username)).toEqual(["gina", "hank"]);
    expect(res.sigs).toEqual({ [a.publicKey]: ga.sig, [b.publicKey]: hb.sig });
    for (const p of res.profiles) expect(verifyProfile(p, res.sigs[p.wallet])).toBe(true);
    expect((await get(app, "/v1/profiles")).json()).toEqual({ profiles: [], sigs: {} });
    const many = Array.from({ length: 101 }, () => burnerWallet().publicKey).join(",");
    expect((await get(app, `/v1/profiles?wallets=${many}`)).statusCode).toBe(400);
  });

  it("profile writes are rate limited to 10/min per IP", async () => {
    const app = await make();
    const w = burnerWallet();
    for (let i = 0; i < 10; i++) expect((await put(app, await signed(w, { username: "ivan" }))).statusCode).toBe(200);
    expect((await put(app, await signed(w, { username: "ivan" }))).statusCode).toBe(429);
  });

  it("profiles persist in db.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pispt-profiles-"));
    const dataPath = path.join(dir, "db.json");
    const a = await make({ dataPath });
    const w = burnerWallet();
    await put(a, await signed(w, { username: "judy" }));
    await a.close();
    apps.pop();
    const b = await make({ dataPath });
    expect((await get(b, "/v1/username/judy")).json().wallet).toBe(w.publicKey);
  });
});
