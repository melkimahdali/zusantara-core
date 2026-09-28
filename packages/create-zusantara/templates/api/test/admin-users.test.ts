import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { testAdmin, type AdminTester } from "zusantara/admin";

// Tes panel admin users (dibuat oleh zusantara make:admin), dengan database SQLite di memori.
process.env.DATABASE_URL = ":memory:";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("admin: Pengguna", () => {
  let t: AdminTester;

  before(async () => {
    const { db } = await import("../src/app/db/index.js");
    const { migrateDatabase } = await import("zusantara/db");
    await migrateDatabase(db, path.join(ROOT, "drizzle"));
    t = testAdmin((await import("../src/app/admin/index.js")).admin);
  });

  it("daftar, formulir, dan hak akses", async () => {
    const admin = { role: "admin" };
    assert.equal((await t.get("/admin/users", admin)).status, 200);
    assert.equal((await t.get("/admin/users/new", admin)).status, 403);
    assert.equal((await t.get("/admin/users", { role: "guest" })).status, 403);
    assert.equal((await t.get("/admin/users")).status, 401);
  });
});
