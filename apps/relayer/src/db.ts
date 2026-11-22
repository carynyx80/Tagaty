import fs from "node:fs";
import path from "node:path";
import type { Profile } from "@primar/core";
import type { RegistrationRecord } from "./verify.js";

export type MessageItem = { id: string; envelope: string; signature: string | null; ts: number };

type DbShape = {
  nextId: number;
  registrations: Record<string, RegistrationRecord>;
  messages: MessageItem[];
  /** wallet -> signed profile */
  profiles: Record<string, { profile: Profile; sig: string }>;
  /** lowercase username -> wallet */
  usernames: Record<string, string>;
};

/** Tiny JSON-file store. All state is kept in memory; writes are atomic (tmp + rename). */
export class JsonDb {
  private data: DbShape;
  private writing: Promise<void> = Promise.resolve();

  constructor(private file: string) {
    this.data = { nextId: 1, registrations: {}, messages: [], profiles: {}, usernames: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      this.data = {
        nextId: Number(raw.nextId) || 1,
        registrations: raw.registrations ?? {},
        messages: Array.isArray(raw.messages) ? raw.messages : [],
        profiles: raw.profiles ?? {},
        usernames: raw.usernames ?? {},
      };
      const maxId = this.data.messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
      if (this.data.nextId <= maxId) this.data.nextId = maxId + 1;
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }

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

  async flush() {
    await this.writing;
  }

  getRegistration(wallet: string): RegistrationRecord | undefined {
    return this.data.registrations[wallet];
  }

  async putRegistration(rec: RegistrationRecord) {
    this.data.registrations[rec.wallet] = { wallet: rec.wallet, msgPub: rec.msgPub, sig: rec.sig };
    await this.persist();
  }

  /** Reserves the next monotonically increasing id. */
  nextId(): string {
    return String(this.data.nextId++);
  }

  async appendMessage(item: MessageItem) {
    this.data.messages.push(item);
    await this.persist();
  }

  getProfile(wallet: string): Profile | undefined {
    return this.data.profiles[wallet]?.profile;
  }

  getProfileRecord(wallet: string): { profile: Profile; sig: string } | undefined {
    return this.data.profiles[wallet];
  }

  walletForUsername(name: string): string | undefined {
    return this.data.usernames[name.toLowerCase()];
  }

  /** Stores a profile, claiming its username and freeing the wallet's previous one. */
  async putProfile(profile: Profile, sig: string) {
    const prev = this.data.profiles[profile.wallet]?.profile;
    if (prev && prev.username.toLowerCase() !== profile.username.toLowerCase()) {
      if (this.data.usernames[prev.username.toLowerCase()] === profile.wallet) delete this.data.usernames[prev.username.toLowerCase()];
    }
    this.data.usernames[profile.username.toLowerCase()] = profile.wallet;
    this.data.profiles[profile.wallet] = { profile, sig };
    await this.persist();
  }

  listSince(since: number, limit = 200): MessageItem[] {
    const out: MessageItem[] = [];
    for (const m of this.data.messages) {
      if (Number(m.id) > since) {
        out.push(m);
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}
