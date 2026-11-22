import fs from "node:fs";
import path from "node:path";
import type { Profile } from "@primar/core";
import type { RegistrationRecord } from "./verify.js";

export type MessageItem = { id: string; envelope: string; signature: string | null; ts: number };
export type ProfileRecord = { profile: Profile; sig: string };

export class UsernameTakenError extends Error {
  constructor() {
    super("username taken");
  }
}

/** Storage backend used by the HTTP API. JsonDb (local/tests) or PgDb (DATABASE_URL). */
export interface Store {
  readonly kind: "json" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;
  getRegistration(wallet: string): Promise<RegistrationRecord | undefined>;
  putRegistration(rec: RegistrationRecord): Promise<void>;
  /** Assigns the next monotonically increasing id and stores the message. */
  appendMessage(msg: Omit<MessageItem, "id">): Promise<MessageItem>;
  listSince(since: number, limit?: number): Promise<MessageItem[]>;
  getProfileRecord(wallet: string): Promise<ProfileRecord | undefined>;
  walletForUsername(name: string): Promise<string | undefined>;
  /** Stores a profile, claiming its username and freeing the wallet's previous one. Throws UsernameTakenError. */
  putProfile(profile: Profile, sig: string): Promise<void>;
}

export type JsonDbShape = {
  nextId: number;
  registrations: Record<string, RegistrationRecord>;
  messages: MessageItem[];
  /** wallet -> signed profile */
  profiles: Record<string, ProfileRecord>;
  /** lowercase username -> wallet */
  usernames: Record<string, string>;
};

/** Reads a db.json file (returns null if it does not exist). */
export function readJsonDbFile(file: string): JsonDbShape | null {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  const data: JsonDbShape = {
    nextId: Number(raw.nextId) || 1,
    registrations: raw.registrations ?? {},
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    profiles: raw.profiles ?? {},
    usernames: raw.usernames ?? {},
  };
  const maxId = data.messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
  if (data.nextId <= maxId) data.nextId = maxId + 1;
  return data;
}

/** Tiny JSON-file store. All state is kept in memory; writes are atomic (tmp + rename). */
export class JsonDb implements Store {
  readonly kind = "json" as const;
  private data: JsonDbShape;
  private writing: Promise<void> = Promise.resolve();

  constructor(private file: string) {
    this.data = readJsonDbFile(file) ?? { nextId: 1, registrations: {}, messages: [], profiles: {}, usernames: {} };
  }

  async init() {}

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    this.writing = this.writing.then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, snapshot);
      await fs.promises.rename(tmp, this.file);
    });
    return this.writing;
  }

  async close() {
    await this.writing;
  }

  async getRegistration(wallet: string) {
    return this.data.registrations[wallet];
  }

  async putRegistration(rec: RegistrationRecord) {
    this.data.registrations[rec.wallet] = { wallet: rec.wallet, msgPub: rec.msgPub, sig: rec.sig };
    await this.persist();
  }

  async appendMessage(msg: Omit<MessageItem, "id">) {
    const item: MessageItem = { id: String(this.data.nextId++), envelope: msg.envelope, signature: msg.signature, ts: msg.ts };
    this.data.messages.push(item);
    await this.persist();
    return item;
  }

  async listSince(since: number, limit = 200) {
    const out: MessageItem[] = [];
    for (const m of this.data.messages) {
      if (Number(m.id) > since) {
        out.push(m);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async getProfileRecord(wallet: string) {
    return this.data.profiles[wallet];
  }

  async walletForUsername(name: string) {
    return this.data.usernames[name.toLowerCase()];
  }

  async putProfile(profile: Profile, sig: string) {
    const name = profile.username.toLowerCase();
    const holder = this.data.usernames[name];
    if (holder && holder !== profile.wallet) throw new UsernameTakenError();
    const prev = this.data.profiles[profile.wallet]?.profile;
    if (prev) {
      const old = prev.username.toLowerCase();
      if (old !== name && this.data.usernames[old] === profile.wallet) delete this.data.usernames[old];
    }
    this.data.usernames[name] = profile.wallet;
    this.data.profiles[profile.wallet] = { profile, sig };
    await this.persist();
  }
}
