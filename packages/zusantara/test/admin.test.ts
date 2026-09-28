import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { AdminError, defineAdmin, defineResource, defaultFields, inspectTable, isSecretColumn, testAdmin, type AdminPanel } from "../src/admin/index.js";
import { blockHash, findBlock, renderBlock, replaceBlock } from "../src/admin/blocks.js";
import { describeApp, formatManifest } from "../src/admin/describe.js";
import { makeAdmin } from "../src/admin/generate.js";
import { closeDatabase, createSqlite } from "../src/db/index.js";

const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

const products = sqliteTable(
  "products",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    sku: text("sku").notNull(),
    price: integer("price").notNull().default(0),
    status: text("status", { enum: ["draft", "live"] }).notNull().default("draft"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    categoryId: integer("category_id").references(() => categories.id),
    description: text("description"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("products_sku_unique").on(t.sku)],
);

const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  apiToken: text("api_token"),
});

describe("admin: skema dan field", () => {
  it("mengenali kolom rahasia per kata", () => {
    for (const name of ["password", "password_hash", "passwordHash", "api_token", "apiKey", "totp_secret", "recovery_codes", "salt"]) assert.ok(isSecretColumn(name), name);
    for (const name of ["email", "passenger", "tokenizer_name", "status", "hashtag"]) assert.equal(isSecretColumn(name), false, name);
  });

  it("membaca tabel Drizzle: pk, unik, enum, relasi, dan kolom rahasia", () => {
    const info = inspectTable(products);
    assert.equal(info.name, "products");
    assert.equal(info.primaryKey, "id");
    assert.deepEqual(info.columns.find((c) => c.key === "status")?.enumValues, ["draft", "live"]);
    assert.equal(info.columns.find((c) => c.key === "categoryId")?.references?.table, "categories");
    assert.ok(info.indexed.includes("sku"));
    assert.ok(inspectTable(accounts).columns.find((c) => c.key === "passwordHash")?.secret);
  });

  it("field bawaan: tanpa kolom rahasia, filter per tipe, inline untuk enum/boolean", () => {
    const fields = defaultFields(inspectTable(products), new Map([["categories", inspectTable(categories)]]), "id");
    const by = (n: string) => fields.find((f) => f.name === n)!;
    assert.equal(by("status").type, "enum");
    assert.ok(by("status").filter && by("status").inline);
    assert.equal(by("active").type, "boolean");
    assert.equal(by("categoryId").type, "relation");
    assert.equal(by("categoryId").label, "Kategori");
    assert.equal(by("description").list, false);
    assert.equal(by("createdAt").form, false);
    assert.ok(by("createdAt").filter);
    assert.equal(by("id").form, false);
    assert.ok(!defaultFields(inspectTable(accounts)).some((f) => f.name === "passwordHash" || f.name === "apiToken"));
  });
});

describe("admin: blok bertanda", () => {
  it("memperbarui blok, lalu menolak menimpa blok yang diubah tangan", () => {
    const text = `a\n${renderBlock("x", "satu")}\nb\n`;
    assert.equal(findBlock(text, "x")?.edited, false);
    const next = replaceBlock(text, "x", "dua");
    assert.equal(next.status, "updated");
    assert.match(next.text!, /^a\n\/\/ zusantara:generated:begin x sha256=[0-9a-f]{12}\ndua\n\/\/ zusantara:generated:end x\nb\n$/);
    assert.equal(replaceBlock(next.text!, "x", "dua").status, "unchanged");
    const edited = next.text!.replace("\ndua\n", "\ndua diubah\n");
    assert.equal(findBlock(edited, "x")?.edited, true);
    assert.equal(replaceBlock(edited, "x", "tiga").status, "edited");
    assert.equal(replaceBlock(edited, "x", "tiga", true).status, "updated");
    assert.equal(replaceBlock("tanpa blok", "x", "y").status, "missing");
    // Spasi di akhir baris dan CRLF tidak dihitung sebagai perubahan.
    assert.equal(blockHash("a  \r\nb"), blockHash("a\nb"));
    // File ber-CRLF (checkout git di Windows): isi sama tidak menyentuh file, isi baru tetap CRLF.
    const crlf = `a\r\n${renderBlock("x", "satu\ndua").replace(/\n/g, "\r\n")}\r\nb\r\n`;
    assert.deepEqual(replaceBlock(crlf, "x", "satu\ndua"), { status: "unchanged", text: crlf });
    const crlfNext = replaceBlock(crlf, "x", "tiga\nempat");
    assert.equal(crlfNext.status, "updated");
    assert.doesNotMatch(crlfNext.text!.replace(/\r\n/g, ""), /\n/);
  });
});

describe("admin: panel", () => {
  const db = createSqlite(":memory:", { categories, products, accounts });
  let panel: AdminPanel;
  let t: ReturnType<typeof testAdmin>;
  const admin = { id: 1, role: "admin" };
  const staff = { id: 2, role: "staff" };

  before(async () => {
    await db.run(sql`CREATE TABLE categories (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, name text NOT NULL)`);
    await db.run(
      sql`CREATE TABLE products (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, name text NOT NULL, sku text NOT NULL, price integer DEFAULT 0 NOT NULL, status text DEFAULT 'draft' NOT NULL, active integer DEFAULT 1 NOT NULL, category_id integer REFERENCES categories(id), description text, created_at integer NOT NULL)`,
    );
    await db.run(sql`CREATE UNIQUE INDEX products_sku_unique ON products (sku)`);
    await db.run(sql`CREATE TABLE accounts (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, email text NOT NULL, password_hash text NOT NULL, api_token text)`);
    await db.run(sql`PRAGMA foreign_keys = ON`);
    await db.insert(categories).values([{ name: "Kopi" }, { name: "Teh" }]);
    for (let i = 1; i <= 30; i++) {
      await db.insert(products).values({ name: `Produk ${i}`, sku: `SKU-${i}`, price: i * 1000, status: i % 2 ? "live" : "draft", categoryId: i % 2 ? 1 : 2 });
    }
    await db.insert(accounts).values({ email: "a@b.id", passwordHash: "rahasia-hash", apiToken: "tok_123" });
    panel = defineAdmin({
      resources: [
        defineResource({
          table: products,
          db,
          access: { view: ["admin", "staff"], delete: ["admin"] },
          beforeSave(values) {
            if (typeof values.name === "string" && values.name.toLowerCase() === "terlarang") throw new AdminError("Nama ini tidak boleh.", "name");
          },
        }),
        defineResource({ table: categories, db }),
        defineResource({ table: accounts, db }),
      ],
    });
    t = testAdmin(panel);
  });

  after(() => closeDatabase(db));

  it("dasbor: jumlah dan data terbaru; hanya tabel yang boleh dilihat", async () => {
    const dash = await t.get("/admin", admin);
    assert.equal(dash.status, 200);
    assert.match(dash.body, /<b>30<\/b>/);
    assert.match(dash.body, /Produk 30/);
    assert.equal(dash.headers["x-robots-tag"], "noindex, nofollow");
    assert.equal(dash.headers["cache-control"], "no-store");
    const forStaff = await t.get("/admin", staff);
    assert.equal(forStaff.status, 200);
    assert.doesNotMatch(forStaff.body, /href="\/admin\/categories"/);
    assert.equal((await t.get("/admin", { role: "guest" })).status, 403);
    assert.equal((await t.get("/admin")).status, 401);
  });

  it("daftar: cari, filter, urut, halaman, dan potongan htmx", async () => {
    const list = await t.get("/admin/products", admin);
    assert.equal(list.status, 200);
    assert.match(list.body, /30 data/);
    assert.match(list.body, /hx-get="\/admin\/products"/);
    const search = await t.get("/admin/products?q=Produk%2012", admin);
    assert.match(search.body, /1 data/);
    const filtered = await t.get("/admin/products?f_status=draft", admin);
    assert.match(filtered.body, /15 data/);
    const sorted = await t.get("/admin/products?sort=price&dir=asc", admin);
    assert.ok(sorted.body.indexOf(">Produk 1<") < sorted.body.indexOf(">Produk 2<"));
    assert.match(sorted.body, /aria-sort="ascending"/);
    // Nilai pencarian dengan karakter LIKE diperlakukan apa adanya.
    assert.match((await t.get("/admin/products?q=%25", admin)).body, /0 data|Tidak ada/);
    const frag = await t.get("/admin/products?q=Produk%2012&f_status=", admin, { htmx: true, target: "zu-admin-results" });
    assert.doesNotMatch(frag.body, /<html/);
    assert.match(frag.body, /id="zu-admin-results"/);
    assert.equal(frag.headers["hx-push-url"], "/admin/products?q=Produk+12");
    assert.equal(frag.headers.vary, "HX-Request");
    // Kolom rahasia tidak pernah tampil.
    const acc = await t.get("/admin/accounts", admin);
    assert.doesNotMatch(acc.body, /rahasia-hash|tok_123|password_hash|api_token/i);
    assert.doesNotMatch(acc.body, /<a [^>]*>[^<]*<a /, "tidak ada tautan bersarang");
    // Kolom wajib password_hash tidak ada di formulir, jadi tambah data dimatikan otomatis.
    assert.doesNotMatch(acc.body, /href="\/admin\/accounts\/new"/);
    assert.equal((await t.get("/admin/accounts/new", admin)).status, 403);
  });

  it("tambah, validasi 422, galat unik ramah, ubah, dan hapus", async () => {
    const invalid = await t.post("/admin/products", { name: "", sku: "BARU-1", price: "abc" }, admin);
    assert.equal(invalid.status, 422);
    assert.match(invalid.body, /aria-invalid="true"/);
    const dupe = await t.post("/admin/products", { name: "Ganda", sku: "SKU-1", price: 1, status: "live", categoryId: 1 }, admin);
    assert.equal(dupe.status, 422);
    assert.match(dupe.body, /sudah dipakai/);
    const rejected = await t.post("/admin/products", { name: "Terlarang", sku: "X-1", price: 1, status: "live" }, admin);
    assert.equal(rejected.status, 422);
    assert.match(rejected.body, /Nama ini tidak boleh/);
    const created = await t.post("/admin/products", { name: "Kopi susu", sku: "KS-1", price: 18000, status: "live", active: "1", categoryId: 1 }, admin);
    assert.equal(created.status, 303);
    assert.equal(created.headers.location, "/admin/products");
    const [row] = await db.select().from(products).where(sql`sku = 'KS-1'`);
    assert.equal(row!.price, 18000);
    assert.equal((await t.get(`/admin/products/${row!.id}`, admin)).status, 200);
    const htmxSave = await t.post(`/admin/products/${row!.id}`, { name: "Kopi susu gula aren", sku: "KS-1", price: 20000, status: "live", categoryId: 1 }, admin, { htmx: true });
    assert.equal(htmxSave.status, 200);
    assert.equal(htmxSave.headers["hx-location"], "/admin/products");
    const deleted = await t.post(`/admin/products/${row!.id}/delete`, {}, admin);
    assert.equal(deleted.status, 303);
    assert.equal((await t.get(`/admin/products/${row!.id}`, admin)).status, 404);
  });

  it("ubah langsung di tabel (inline) dan hak akses per aksi", async () => {
    const inline = await t.post("/admin/products/1/field/status", { status: "draft" }, admin, { htmx: true });
    assert.equal(inline.status, 200);
    assert.match(inline.body, /zu-inline-edit/);
    const bad = await t.post("/admin/products/1/field/status", { status: "hilang" }, admin, { htmx: true });
    assert.equal(bad.status, 422);
    assert.equal((await t.post("/admin/products/1/field/name", { name: "Terlarang" }, admin, { htmx: true })).status, 404);
    // staff boleh melihat produk, tidak boleh mengubah atau menghapus.
    assert.equal((await t.get("/admin/products", staff)).status, 200);
    assert.equal((await t.post("/admin/products/1", { name: "x" }, staff)).status, 403);
    assert.equal((await t.post("/admin/products/1/delete", {}, staff)).status, 403);
    assert.equal((await t.get("/admin/categories", staff)).status, 403);
  });

  it("relasi: pilihan Combobox dari server, dan hapus yang masih dipakai ditolak dengan pesan", async () => {
    const options = await t.get("/admin/products/_options/categoryId?q=te", admin, { htmx: true });
    assert.equal(options.status, 200);
    assert.match(options.body, /Teh/);
    assert.doesNotMatch(options.body, /Kopi/);
    const inUse = await t.post("/admin/categories/1/delete", {}, admin);
    assert.equal(inUse.status, 303);
    assert.equal((await db.select().from(categories)).length, 2);
  });
});

describe("admin: make:admin dan describe", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Di dalam paket agar import drizzle-orm dari schema proyek contoh bisa ditemukan.
  const root = fs.mkdtempSync(path.join(here, "..", ".tmp-admin-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  before(() => {
    const w = (f: string, s: string) => {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), s);
    };
    w("package.json", JSON.stringify({ name: "toko", version: "1.0.0", type: "module" }));
    w(
      "src/app/db/schema.ts",
      `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  status: text("status", { enum: ["draft", "live"] }).notNull().default("draft"),
});
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
});
`,
    );
    w("src/app/db/index.ts", `export const db = {} as never;\n`);
    w("src/app/routes/index.ts", `export const GET = () => "hai";\n`);
    w(
      "src/app/lib/ui.ts",
      `import type { NavItem } from "zusantara/ui";
function navFor(user: { role: string }): NavItem[] {
  const nav: NavItem[] = [{ href: "/", label: "Beranda" }];
  return nav;
}
export function appPage(..._: unknown[]): string {
  return String(navFor);
}
`,
    );
  });

  it("membuat file, menambah menu, lalu hanya memperbarui blok saat dijalankan ulang", async () => {
    const first = await makeAdmin(root, ["products"]);
    assert.ok(first.ok, first.lines.join("\n"));
    const file = path.join(root, "src/app/admin/products.ts");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /zusantara:generated:begin admin-resource sha256=/);
    assert.match(text, /name: "status", label: "Status", type: "enum"/);
    assert.ok(fs.existsSync(path.join(root, "src/app/routes/admin/index.ts")));
    assert.ok(fs.existsSync(path.join(root, "src/app/routes/admin/[...path].ts")));
    assert.match(fs.readFileSync(path.join(root, "src/app/lib/ui.ts"), "utf8"), /nav\.push\(\.\.\.adminNav\(user\)\);\n {2}return nav;/);

    // Ubahan di luar blok dipertahankan saat dijalankan ulang.
    fs.writeFileSync(file, text.replace("overrides: {},", 'overrides: { name: { label: "Nama produk" } },'));
    const again = await makeAdmin(root, ["products"]);
    assert.ok(again.ok);
    assert.match(fs.readFileSync(file, "utf8"), /label: "Nama produk"/);

    // Blok yang diubah tangan tidak ditimpa tanpa --force.
    const handEdited = fs.readFileSync(file, "utf8").replace('label: "Produk"', 'label: "Barang"');
    fs.writeFileSync(file, handEdited);
    const skipped = await makeAdmin(root, ["products"]);
    assert.equal(fs.readFileSync(file, "utf8"), handEdited);
    assert.match(skipped.lines.join("\n"), /diubah/);
    await makeAdmin(root, ["products"], { force: true });
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /label: "Barang"/);

    // Registry memuat kedua tabel; tabel dengan kolom wajib rahasia tidak bisa ditambah dari panel.
    await makeAdmin(root, [], { all: true });
    assert.match(fs.readFileSync(path.join(root, "src/app/admin/index.ts"), "utf8"), /const resources = \[productsAdmin, usersAdmin\];/);
    assert.match(fs.readFileSync(path.join(root, "src/app/admin/users.ts"), "utf8"), /create: false/);
    assert.equal((await makeAdmin(root, ["tidak-ada"])).ok, false);
  });

  it("describe: route, tabel tanpa kolom rahasia, panel admin, dan saran index", async () => {
    const m = await describeApp(root, "0.13.0");
    assert.equal(m.manifestVersion, 1);
    assert.equal(m.app.version, "1.0.0");
    assert.ok(m.routes.some((r) => r.pattern === "/" && r.methods.includes("GET")));
    const users = m.tables.find((x) => x.name === "users")!;
    assert.deepEqual(users.columns.map((c) => c.name), ["id", "email"]);
    assert.equal(users.hiddenColumns, 1);
    assert.doesNotMatch(JSON.stringify(m), /password/i);
    assert.deepEqual(m.admin?.resources.map((r) => r.name), ["products", "users"]);
    assert.deepEqual(m.admin?.resources[0]!.access.view, ["admin"]);
    assert.ok(m.suggestions.indexes.some((s) => s.table === "products" && s.column === "status"));
    assert.match(formatManifest(m), /products/);
  });
});
