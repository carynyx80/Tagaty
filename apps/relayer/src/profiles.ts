import type { FastifyInstance } from "fastify";
import { validateUsername, verifyProfile, type Profile } from "@primar/core";
import { UsernameTakenError, type Store } from "./db.js";

const MAX_FUTURE_MS = 5 * 60_000;
const MAX_BATCH = 100;

/** Keeps only the contract fields (extra props are not covered by the signature). */
function pick(p: any): Profile {
  const out: Profile = { wallet: p.wallet, username: p.username, updatedAt: p.updatedAt };
  if (p.displayName !== undefined) out.displayName = p.displayName;
  if (p.bio !== undefined) out.bio = p.bio;
  if (p.avatar !== undefined) out.avatar = p.avatar;
  return out;
}

export function registerProfileRoutes(
  app: FastifyInstance,
  db: Store,
  allowWrite: (ip: string) => boolean,
  now: () => number = Date.now,
) {
  app.put("/v1/profile", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    if (!allowWrite(req.ip)) return reply.code(429).send({ error: "rate limit exceeded (10 profile writes/min)" });
    const body = (req.body ?? {}) as { profile?: unknown; sig?: unknown };
    if (!body.profile || typeof body.profile !== "object" || typeof body.sig !== "string") {
      return reply.code(400).send({ error: "body must be { profile, sig }" });
    }
    const profile = pick(body.profile);
    if (!verifyProfile(profile, body.sig)) {
      return reply.code(400).send({ error: "invalid profile or signature" });
    }
    if (profile.updatedAt > now() + MAX_FUTURE_MS) {
      return reply.code(400).send({ error: "updatedAt is too far in the future" });
    }
    const existing = (await db.getProfileRecord(profile.wallet))?.profile;
    if (existing && profile.updatedAt < existing.updatedAt) {
      return reply.code(400).send({ error: "stale profile (updatedAt older than stored)" });
    }
    try {
      await db.putProfile(profile, body.sig);
    } catch (err) {
      if (err instanceof UsernameTakenError) return reply.code(409).send({ error: "username taken" });
      throw err;
    }
    return { ok: true as const, profile };
  });

  app.get<{ Params: { wallet: string } }>("/v1/profile/:wallet", async (req, reply) => {
    const rec = await db.getProfileRecord(req.params.wallet);
    if (!rec) return reply.code(404).send({ error: "profile not found" });
    return { profile: rec.profile, sig: rec.sig };
  });

  app.get<{ Params: { name: string } }>("/v1/username/:name", async (req, reply) => {
    const wallet = await db.walletForUsername(req.params.name);
    const rec = wallet ? await db.getProfileRecord(wallet) : undefined;
    if (!wallet || !rec) return reply.code(404).send({ error: "username not found" });
    return { wallet, profile: rec.profile, sig: rec.sig };
  });

  app.get<{ Params: { name: string } }>("/v1/username/:name/available", async (req) => {
    const name = req.params.name;
    if (!/^[a-z0-9_]*$/.test(name)) return { available: false, reason: "lowercase letters, numbers and _ only" };
    const err = validateUsername(name);
    if (err) return { available: false, reason: err };
    if (await db.walletForUsername(name)) return { available: false, reason: "username taken" };
    return { available: true };
  });

  app.get<{ Querystring: { wallets?: string } }>("/v1/profiles", async (req, reply) => {
    const wallets = [...new Set((req.query.wallets ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
    if (wallets.length > MAX_BATCH) return reply.code(400).send({ error: `max ${MAX_BATCH} wallets` });
    const profiles: Profile[] = [];
    const sigs: Record<string, string> = {};
    for (const w of wallets) {
      const rec = await db.getProfileRecord(w);
      if (rec) {
        profiles.push(rec.profile);
        sigs[w] = rec.sig;
      }
    }
    return { profiles, sigs };
  });
}
