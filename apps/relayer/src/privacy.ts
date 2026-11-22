import { createHmac, randomBytes } from "node:crypto";

/**
 * Turns client IPs into opaque rate-limit keys: HMAC-SHA256(secret, ip) where the
 * secret is random, held only in memory and rotated every UTC day. No raw IP is
 * ever stored, logged or kept in memory by the limiter.
 */
export class IpHasher {
  private secret = randomBytes(32);
  private day = IpHasher.today();

  constructor(private now: () => number = Date.now) {}

  static today(t = Date.now()) {
    return new Date(t).toISOString().slice(0, 10);
  }

  key(ip: string): string {
    const day = IpHasher.today(this.now());
    if (day !== this.day) this.rotate(day);
    return createHmac("sha256", this.secret).update(ip).digest("base64url");
  }

  rotate(day = IpHasher.today(this.now())) {
    this.secret = randomBytes(32);
    this.day = day;
  }
}

/** Sliding-window limiter keyed by opaque strings. */
export function makeRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  const allow = (key: string): boolean => {
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
  return Object.assign(allow, { keys: () => [...hits.keys()] });
}

/** Fastify/pino serializers that never include IPs, ports or headers. */
export const logSerializers = {
  req(req: { method?: string; url?: string; routeOptions?: { url?: string } }) {
    return { method: req.method, url: req.routeOptions?.url ?? req.url?.split("?")[0] };
  },
  res(res: { statusCode?: number }) {
    return { statusCode: res.statusCode };
  },
};

/**
 * Proxies whose X-Forwarded-For we trust: Railway's edge reaches the container from
 * private/CGNAT addresses, so we trust only private hops. A public client connecting
 * directly can't spoof its rate-limit key. (Fastify fails closed on numeric hop counts.)
 */
export const TRUST_PRIVATE_PROXIES = "loopback,linklocal,uniquelocal,100.64.0.0/10";

/** env TRUST_PROXY ("true" | "false" | proxy-addr list) overrides; default: private hops on Railway, else off. */
export function getTrustProxy(): boolean | string {
  const v = process.env.TRUST_PROXY;
  if (v !== undefined && v !== "") return v === "true" ? true : v === "false" ? false : v;
  return process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_ENVIRONMENT ? TRUST_PRIVATE_PROXIES : false;
}

export const PRIVACY_INFO = { logsIps: false, storesIps: false, rateLimitKey: "hmac-rotating-daily" } as const;
