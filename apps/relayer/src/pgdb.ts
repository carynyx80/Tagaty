import pg from "pg";
import type { Profile } from "@primar/core";
import { readJsonDbFile, UsernameTakenError, type MessageItem, type ProfileRecord, type Store } from "./db.js";
import type { RegistrationRecord } from "./verify.js";

type Log = { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
const noopLog: Log = { info() {}, warn() {} };

/** Idempotent migrations (run in order on every boot). */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS registrations (
     wallet  text PRIMARY KEY,
     msg_pub text NOT NULL,
     sig     text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id        bigserial PRIMARY KEY,
     envelope  text NOT NULL,
     signature text,
     ts        bigint NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS profiles (
     wallet     text PRIMARY KEY,
     profile    jsonb NOT NULL,
     sig        text NOT NULL,
     updated_at bigint NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS usernames (
     username text PRIMARY KEY,
     wallet   text NOT NULL UNIQUE
   )`,
];

const LOCK_KEY = 74_717_874; // arbitrary advisory-lock id for migrations/import

const toItem = (r: any): MessageItem => ({ id: String(r.id), envelope: r.envelope, signature: r.signature ?? null, ts: Number(r.ts) });

export class PgDb implements Store {
  readonly kind = "postgres" as const;
  readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private opts: { importFrom?: string; log?: Log } = {},
  ) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    this.pool.on("error", (err) => (opts.log ?? noopLog).warn({ err: err.message }, "postgres pool error"));
  }

  private get log() {
    return this.opts.log ?? noopLog;
  }

  async init() {
    const c = await this.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
      for (const sql of MIGRATIONS) await c.query(sql);
      this.log.info({ tables: ["registrations", "messages", "profiles", "usernames"] }, "postgres migrations applied");
      if (this.opts.importFrom) await this.importJson(c, this.opts.importFrom);
    } finally {
      await c.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
      c.release();
    }
  }

  /** One-time import of a legacy db.json, only when every table is empty. */
  private async importJson(c: pg.PoolClient, file: string) {
    const { rows } = await c.query(
      `SELECT (SELECT count(*) FROM registrations) + (SELECT count(*) FROM messages)
            + (SELECT count(*) FROM profiles) + (SELECT count(*) FROM usernames) AS n`,
    );
    if (Number(rows[0].n) > 0) return;
    const data = readJsonDbFile(file);
    if (!data) {
      this.log.info({}, "no legacy db.json to import");
      return;
    }
    await c.query("BEGIN");
    try {
      for (const r of Object.values(data.registrations)) {
        await c.query("INSERT INTO registrations (wallet, msg_pub, sig) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [r.wallet, r.msgPub, r.sig]);
      }
      const msgs = [...data.messages].sort((a, b) => Number(a.id) - Number(b.id));
      for (const m of msgs) {
        await c.query("INSERT INTO messages (id, envelope, signature, ts) VALUES ($1,$2,$3,$4)", [Number(m.id), m.envelope, m.signature ?? null, m.ts]);
      }
      if (msgs.length) {
        await c.query("SELECT setval(pg_get_serial_sequence('messages','id'), $1)", [Math.max(Number(msgs[msgs.length - 1].id), data.nextId - 1)]);
      }
      let profiles = 0;
      for (const [wallet, rec] of Object.entries(data.profiles)) {
        const name = rec.profile.username.toLowerCase();
        const r = await c.query("INSERT INTO usernames (username, wallet) VALUES ($1,$2) ON CONFLICT DO NOTHING", [name, wallet]);
        if (r.rowCount === 0) continue; // conflicting legacy username; skip
        await c.query("INSERT INTO profiles (wallet, profile, sig, updated_at) VALUES ($1,$2,$3,$4)", [wallet, rec.profile, rec.sig, rec.profile.updatedAt]);
        profiles++;
      }
      await c.query("COMMIT");
      this.log.info(
        { registrations: Object.keys(data.registrations).length, messages: msgs.length, profiles },
        "imported legacy db.json into postgres",
      );
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  }

  async close() {
    await this.pool.end();
  }

  async getRegistration(wallet: string): Promise<RegistrationRecord | undefined> {
    const { rows } = await this.pool.query("SELECT wallet, msg_pub, sig FROM registrations WHERE wallet = $1", [wallet]);
    return rows[0] ? { wallet: rows[0].wallet, msgPub: rows[0].msg_pub, sig: rows[0].sig } : undefined;
  }

  async putRegistration(rec: RegistrationRecord) {
    await this.pool.query(
      `INSERT INTO registrations (wallet, msg_pub, sig) VALUES ($1,$2,$3)
       ON CONFLICT (wallet) DO UPDATE SET msg_pub = EXCLUDED.msg_pub, sig = EXCLUDED.sig`,
      [rec.wallet, rec.msgPub, rec.sig],
    );
  }

  async appendMessage(msg: Omit<MessageItem, "id">) {
    const { rows } = await this.pool.query(
      "INSERT INTO messages (envelope, signature, ts) VALUES ($1,$2,$3) RETURNING id, envelope, signature, ts",
      [msg.envelope, msg.signature, msg.ts],
    );
    return toItem(rows[0]);
  }

  async listSince(since: number, limit = 200) {
    const { rows } = await this.pool.query(
      "SELECT id, envelope, signature, ts FROM messages WHERE id > $1 ORDER BY id ASC LIMIT $2",
      [since, limit],
    );
    return rows.map(toItem);
  }

  async getProfileRecord(wallet: string): Promise<ProfileRecord | undefined> {
    const { rows } = await this.pool.query("SELECT profile, sig FROM profiles WHERE wallet = $1", [wallet]);
    return rows[0] ? { profile: rows[0].profile as Profile, sig: rows[0].sig } : undefined;
  }

  async walletForUsername(name: string) {
    const { rows } = await this.pool.query("SELECT wallet FROM usernames WHERE username = $1", [name.toLowerCase()]);
    return rows[0]?.wallet as string | undefined;
  }

  async putProfile(profile: Profile, sig: string) {
    const name = profile.username.toLowerCase();
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM usernames WHERE wallet = $1 AND username <> $2", [profile.wallet, name]);
      const r = await c.query(
        "INSERT INTO usernames (username, wallet) VALUES ($1,$2) ON CONFLICT (username) DO NOTHING RETURNING wallet",
        [name, profile.wallet],
      );
      if (r.rowCount === 0) {
        const { rows } = await c.query("SELECT wallet FROM usernames WHERE username = $1", [name]);
        if (rows[0]?.wallet !== profile.wallet) throw new UsernameTakenError();
      }
      await c.query(
        `INSERT INTO profiles (wallet, profile, sig, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (wallet) DO UPDATE SET profile = EXCLUDED.profile, sig = EXCLUDED.sig, updated_at = EXCLUDED.updated_at`,
        [profile.wallet, profile, sig, profile.updatedAt],
      );
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
}
