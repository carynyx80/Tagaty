// Runs only when TEST_DATABASE_URL points at a disposable Postgres database (tables are dropped!).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PgDb } from "../src/pgdb.js";
import { UsernameTakenError } from "../src/db.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgDb (TEST_DATABASE_URL)", () => {
  const dbs: PgDb[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close().catch(() => {});
  });

  async function fresh(importFrom?: string) {
    const db = new PgDb(url!, { importFrom });
    dbs.push(db);
    await db.pool.query("DROP TABLE IF EXISTS registrations, messages, profiles, usernames");
    await db.init();
    await db.init(); // migrations are idempotent
    return db;
  }

  it("imports legacy db.json once, preserving ids/order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pispt-pg-"));
    const file = path.join(dir, "db.json");
    const profile = { wallet: "W1", username: "alice", updatedAt: 5 };
    fs.writeFileSync(
      file,
      JSON.stringify({
        nextId: 8,
        registrations: { W1: { wallet: "W1", msgPub: "m", sig: "s" } },
        messages: [
          { id: "3", envelope: "PRM1:a", signature: null, ts: 1 },
          { id: "7", envelope: "PRM1:b", signature: "sig", ts: 2 },
        ],
        profiles: { W1: { profile, sig: "ps" } },
        usernames: { alice: "W1" },
      }),
    );
    const db = await fresh(file);
    expect((await db.listSince(0)).map((m) => m.id)).toEqual(["3", "7"]);
    expect(await db.getRegistration("W1")).toEqual({ wallet: "W1", msgPub: "m", sig: "s" });
    expect(await db.getProfileRecord("W1")).toEqual({ profile, sig: "ps" });
    expect(await db.walletForUsername("ALICE")).toBe("W1");
    const next = await db.appendMessage({ envelope: "PRM1:c", signature: null, ts: 3 });
    expect(next.id).toBe("8");
    await db.init(); // re-running import does not duplicate
    expect((await db.listSince(0)).length).toBe(3);
  });

  it("messages, registrations, profiles + username uniqueness", async () => {
    const db = await fresh();
    const a = await db.appendMessage({ envelope: "PRM1:x", signature: null, ts: 10 });
    const b = await db.appendMessage({ envelope: "PRM1:y", signature: "s", ts: 11 });
    expect([a.id, b.id]).toEqual(["1", "2"]);
    expect(await db.listSince(1)).toEqual([{ id: "2", envelope: "PRM1:y", signature: "s", ts: 11 }]);
    await db.putRegistration({ wallet: "A", msgPub: "p", sig: "q" });
    expect((await db.getRegistration("A"))?.msgPub).toBe("p");

    await db.putProfile({ wallet: "A", username: "carol", updatedAt: 1 }, "s1");
    await expect(db.putProfile({ wallet: "B", username: "carol", updatedAt: 1 }, "s2")).rejects.toBeInstanceOf(UsernameTakenError);
    await db.putProfile({ wallet: "A", username: "carol2", updatedAt: 2 }, "s3");
    expect(await db.walletForUsername("carol")).toBeUndefined();
    await db.putProfile({ wallet: "B", username: "carol", updatedAt: 3 }, "s4");
    expect(await db.walletForUsername("carol")).toBe("B");
    expect((await db.getProfileRecord("A"))?.profile.username).toBe("carol2");
  });
});
