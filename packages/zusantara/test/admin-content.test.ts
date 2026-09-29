import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { asc, eq, sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { AdminError, defineAdmin, defineResource, testAdmin, type AdminPanel } from "../src/admin/index.js";
import { closeDatabase, createSqlite } from "../src/db/index.js";
import { run } from "../src/cli.js";
import { fileURLToPath } from "node:url";
import { makeAdmin } from "../src/admin/generate.js";
import { cliArgs, parseColumnArg, parseColumnLines, planSchemaChange } from "../src/admin/schema-apply.js";
import { configureMail, outbox } from "../src/backend/mail.js";

const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  titleEn: text("title_en"),
  slug: text("slug").notNull().unique(),
  status: text("status", { enum: ["draft", "review", "published"] }).notNull().default("draft"),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  price: integer("price").notNull().default(0),
  categoryId: integer("category_id").references(() => categories.id),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

const postTags = sqliteTable(
  "post_tags",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);

const comments = sqliteTable("comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id")
    .notNull()
    .references(() => posts.id),
  body: text("body").notNull(),
});

const ADMIN = { role: "admin", id: 1, name: "Ana" };
const EDITOR = { role: "editor", id: 2, name: "Budi" };

describe("admin 0.13.1: konten, jejak data, relasi, dan data massal", () => {
  const db = createSqlite(":memory:", { categories, tags, posts, postTags, comments });
  const ran: string[] = [];
  let admin: AdminPanel;
  let t: ReturnType<typeof testAdmin>;
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), "zusantara-media-"));

  before(async () => {
    configureMail({ url: "memory" });
    await db.run(sql`CREATE TABLE categories (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, name text NOT NULL)`);
    await db.run(sql`CREATE TABLE tags (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, name text NOT NULL)`);
    await db.run(
      sql`CREATE TABLE posts (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, title text NOT NULL, title_en text, slug text NOT NULL UNIQUE, status text DEFAULT 'draft' NOT NULL, published_at integer, meta_title text, meta_description text, price integer DEFAULT 0 NOT NULL, category_id integer REFERENCES categories(id), deleted_at integer)`,
    );
    await db.run(sql`CREATE TABLE post_tags (post_id integer NOT NULL REFERENCES posts(id), tag_id integer NOT NULL REFERENCES tags(id), PRIMARY KEY (post_id, tag_id))`);
    await db.run(sql`CREATE TABLE comments (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, post_id integer NOT NULL REFERENCES posts(id), body text NOT NULL)`);
    await db.run(sql`INSERT INTO categories (name) VALUES ('Berita'), ('Opini')`);
    await db.run(sql`INSERT INTO tags (name) VALUES ('kopi'), ('teh'), ('susu')`);

    admin = defineAdmin({
      resources: [
        defineResource({
          table: posts,
          db,
          many: { tags: { through: postTags, label: "Tag" } },
          access: { view: ["admin", "editor"], create: ["admin", "editor"], update: ["admin", "editor"], delete: ["admin"] },
          previewUrl: (row) => `/blog/${String(row.slug)}?preview=1`,
          workflow: {
            field: "status",
            transitions: [
              { from: "draft", to: "review", label: "Ajukan" },
              { from: "review", to: "published", label: "Setujui", roles: ["admin"] },
              { from: ["review", "published"], to: "draft" },
            ],
          },
          actions: [
            { name: "feature", label: "Jadikan unggulan", run: (rows) => void ran.push(...rows.map((r) => String(r.id))) },
            { name: "boom", label: "Gagal", run: () => { throw new AdminError("Tidak bisa sekarang."); }, bulk: false },
          ],
          automations: [{ on: "update", when: (row, change) => row.status === "published" && "status" in change.changes, email: { to: "redaksi@example.test", subject: "Terbit: {title}", text: "Artikel {id} terbit." } }],
        }),
        defineResource({ table: categories, db }),
        defineResource({ table: comments, db }),
      ],
      settings: { fields: [{ name: "siteName", label: "Nama situs", default: "Situs" }, { name: "email", label: "Email", type: "email" }, { name: "open", label: "Buka", type: "boolean" }] },
      media: { dir: uploads },
    });
    t = testAdmin(admin);
  });

  after(async () => {
    await closeDatabase(db);
    fs.rmSync(uploads, { recursive: true, force: true });
  });

  it("formulir: slug otomatis, grup SEO, pasangan dua bahasa, pilihan many-to-many, dan status hanya lewat transisi", async () => {
    const res = await t.get("/admin/posts/new", ADMIN);
    assert.equal(res.status, 200);
    assert.match(res.body, /Kosongkan untuk dibuat otomatis dari judul/);
    assert.match(res.body, /<legend>Mesin pencari \(SEO\)<\/legend>/);
    assert.match(res.body, /Title \(English\)|Judul \(English\)/);
    assert.match(res.body, /name="m_tags" value="2"/);
    assert.doesNotMatch(res.body, /name="status"/, "status diubah lewat tombol transisi");
  });

  it("tambah data: slug unik dibuat dari judul, tag tersimpan, log audit tercatat", async () => {
    for (const title of ["Kopi Susu Enak", "Kopi Susu Enak"]) {
      const res = await t.post("/admin/posts", { title, price: "15000", m_tags: ["", "1", "3"] }, ADMIN);
      assert.equal(res.status, 303, res.body);
    }
    const slugs = (await db.select().from(posts).orderBy(asc(posts.id))).map((r) => r.slug);
    assert.deepEqual(slugs, ["kopi-susu-enak", "kopi-susu-enak-2"]);
    const list = await t.get("/admin/posts", ADMIN);
    assert.match(list.body, /zu-tag[^>]*>kopi</);
    assert.match(list.body, /Draf/);
    const history = await admin.store!.history("posts", "1");
    assert.equal(history[0]?.action, "create");
    assert.equal(history[0]?.userName, "Ana");
  });

  it("ubah data: diff di riwayat, lalu kembalikan versi lama", async () => {
    assert.equal((await t.post("/admin/posts/1", { title: "Kopi Susu Gula Aren", slug: "kopi-susu-enak", price: "18000", m_tags: ["", "1"] }, ADMIN)).status, 303);
    const page = await t.get("/admin/posts/1/history", ADMIN);
    assert.equal(page.status, 200);
    assert.match(page.body, /Kopi Susu Enak/);
    assert.match(page.body, /Kopi Susu Gula Aren/);
    assert.match(page.body, /Kembalikan versi ini/);
    const entries = await admin.store!.history("posts", "1");
    assert.deepEqual(Object.keys(entries[0]!.changes!).sort(), ["price", "tags", "title"]);
    const created = entries.find((e) => e.action === "create")!;
    assert.equal((await t.post(`/admin/posts/1/revert/${created.id}`, {}, ADMIN)).status, 303);
    const [row] = await db.select().from(posts).where(eq(posts.id, 1));
    assert.equal(row!.title, "Kopi Susu Enak");
    assert.equal(row!.price, 15000);
  });

  it("hapus lunak dengan Urungkan, tempat sampah, lalu pulihkan", async () => {
    const res = await t.post("/admin/posts/2/delete", {}, ADMIN);
    assert.equal(res.status, 303);
    assert.match(res.headers["set-cookie"] ?? "", /zen_flash/);
    const flash = JSON.parse(Buffer.from(/zen_flash=([^;]+)/.exec(res.headers["set-cookie"]!)![1]!, "base64url").toString());
    assert.deepEqual(flash.action, { label: "Urungkan", action: "/admin/posts/2/restore" });
    assert.doesNotMatch((await t.get("/admin/posts", ADMIN)).body, /kopi-susu-enak-2/);
    const trash = await t.get("/admin/posts?trash=1", ADMIN);
    assert.match(trash.body, /Posts di tempat sampah|di tempat sampah/);
    assert.match(trash.body, /Pulihkan/);
    assert.match((await t.get("/admin/posts/2", ADMIN)).body, /ada di tempat sampah/);
    assert.equal((await t.post("/admin/posts/2", { title: "x" }, ADMIN)).status, 409);
    assert.equal((await t.post("/admin/posts/2/restore", {}, ADMIN)).status, 303);
    assert.match((await t.get("/admin/posts", ADMIN)).body, /kopi-susu-enak-2/);
  });

  it("hapus permanen tanpa kolom deletedAt tetap bisa diurungkan dari salinan log", async () => {
    assert.equal((await t.post("/admin/categories/2/delete", {}, ADMIN)).status, 303);
    assert.equal((await db.select().from(categories).where(eq(categories.id, 2))).length, 0);
    assert.equal((await t.post("/admin/categories/2/restore", {}, ADMIN)).status, 303);
    const [back] = await db.select().from(categories).where(eq(categories.id, 2));
    assert.equal(back?.name, "Opini");
  });

  it("alur kerja: transisi sesuai role, persetujuan admin, waktu terbit diisi, otomasi email", async () => {
    assert.equal((await t.post("/admin/posts/1/transition/review", {}, EDITOR)).status, 303);
    assert.equal((await t.post("/admin/posts/1/transition/published", {}, EDITOR)).status, 403, "editor tidak boleh menyetujui");
    const page = await t.get("/admin/posts/1", ADMIN);
    assert.match(page.body, /Setujui/);
    assert.match(page.body, /href="\/blog\/kopi-susu-enak\?preview=1"/);
    const before = outbox.length;
    assert.equal((await t.post("/admin/posts/1/transition/published", {}, ADMIN)).status, 303);
    await admin.idle();
    const [row] = await db.select().from(posts).where(eq(posts.id, 1));
    assert.equal(row!.status, "published");
    assert.ok(row!.publishedAt instanceof Date, "waktu terbit diisi otomatis");
    assert.equal(outbox.length, before + 1);
    assert.equal(outbox.at(-1)!.subject, "Terbit: Kopi Susu Enak");
    assert.match((await t.get("/admin/posts", ADMIN)).body, /Terbit/);
  });

  it("status terjadwal bila waktu terbit di masa depan", async () => {
    const future = Math.floor(Date.now() / 1000) + 86_400;
    await db.run(sql`UPDATE posts SET status = 'published', published_at = ${future} WHERE id = 2`);
    assert.match((await t.get("/admin/posts", ADMIN)).body, /Terjadwal/);
  });

  it("aksi khusus per data dan aksi massal dengan konfirmasi jumlah", async () => {
    assert.equal((await t.post("/admin/posts/1/action/feature", {}, ADMIN)).status, 303);
    assert.deepEqual(ran, ["1"]);
    assert.equal((await t.post("/admin/posts/1/action/boom", {}, ADMIN)).status, 303);
    const confirm = await t.post("/admin/posts/_bulk", { ids: ["1", "2"], bulk: "action:feature" }, ADMIN);
    assert.equal(confirm.status, 200);
    assert.match(confirm.body, /Ya, jalankan untuk 2 data/);
    assert.deepEqual(ran, ["1"], "belum dijalankan sebelum dikonfirmasi");
    assert.equal((await t.post("/admin/posts/_bulk", { ids: ["1", "2"], bulk: "action:feature", confirm: "1" }, ADMIN)).status, 303);
    assert.deepEqual(ran.slice(1).sort(), ["1", "2"]);
    assert.equal((await t.post("/admin/posts/_bulk", { ids: ["1"], bulk: "action:boom", confirm: "1" }, ADMIN)).status, 303, "aksi non-massal tidak ada di pilihan");
    assert.equal((await t.post("/admin/posts/_bulk", { ids: ["1"], bulk: "delete", confirm: "1" }, EDITOR)).status, 303);
    assert.equal((await db.select().from(posts).where(eq(posts.id, 1)))[0]!.deletedAt, null, "editor tidak boleh menghapus");
  });

  it("ekspor CSV mengikuti filter, impor dengan pratinjau lalu simpan", async () => {
    const csv = await t.get("/admin/posts/_export?q=Kopi", ADMIN);
    assert.equal(csv.status, 200);
    assert.match(csv.headers["content-type"] ?? "", /text\/csv/);
    assert.match(csv.headers["content-disposition"] ?? "", /attachment; filename="posts-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.match(csv.body, /^﻿ID,Title|^﻿ID,Judul/);

    const file = "ID;Judul;Harga;Category\n;Teh Tarik;Rp 12.000;Berita\n1;Kopi Susu Enak;20000;\n;;abc;Tidak ada\n";
    const upload = await t.post("/admin/posts/_import", {}, ADMIN, { files: { file: { name: "posts.csv", type: "text/csv", content: file } } });
    assert.equal(upload.status, 200, upload.body);
    assert.match(upload.body, /Cocokkan kolom/);
    const data = /name="data" value="([^"]+)"/.exec(upload.body)![1]!;
    assert.match(upload.body, /<option value="1" selected>Judul<\/option>/);
    const preview = await t.post("/admin/posts/_import", { step: "check", data, map_id: "0", map_title: "1", map_price: "2", map_categoryId: "3" }, ADMIN);
    assert.equal(preview.status, 200, preview.body);
    assert.match(preview.body, /1 data baru, 1 diperbarui, 1 baris bermasalah/);
    const mapping = /name="mapping" value="([^"]+)"/.exec(preview.body)![1]!.replace(/&quot;/g, '"');
    assert.equal((await t.post("/admin/posts/_import", { step: "save", data, mapping }, ADMIN)).status, 303);
    const rows = await db.select().from(posts);
    const tea = rows.find((r) => r.title === "Teh Tarik")!;
    assert.equal(tea.price, 12000);
    assert.equal(tea.slug, "teh-tarik");
    assert.equal(tea.categoryId, 1);
    assert.equal(rows.find((r) => r.title === "Kopi Susu Enak")!.price, 20000);
  });

  it("filter dengan kalimat diarahkan ke URL filter biasa", async () => {
    const res = await t.get(`/admin/posts?nl=${encodeURIComponent("harga di atas 15 ribu")}`, ADMIN);
    assert.equal(res.status, 303);
    assert.match(res.headers.location ?? "", /f_price_from=/);
  });

  it("data anak di halaman induk, dengan tautan tambah yang sudah terisi", async () => {
    await db.run(sql`INSERT INTO comments (post_id, body) VALUES (1, 'Mantap sekali')`);
    const page = await t.get("/admin/posts/1", ADMIN);
    assert.match(page.body, /Mantap sekali/);
    assert.match(page.body, /href="\/admin\/comments\/new\?f_postId=1"/);
    const form = await t.get("/admin/comments/new?f_postId=1", ADMIN);
    assert.match(form.body, /name="postId" value="1" checked/);
  });

  it("catatan internal, cetak, cari global, dan log audit", async () => {
    assert.equal((await t.post("/admin/posts/1/notes", { body: "Cek ulang harga." }, EDITOR)).status, 303);
    assert.match((await t.get("/admin/posts/1", ADMIN)).body, /Cek ulang harga\./);
    const print = await t.get("/admin/posts/1/print", ADMIN);
    assert.match(print.body, /data-zu-print/);
    assert.match(print.body, /kopi, |kopi</);
    const search = await t.get("/admin/_search?q=kopi", ADMIN);
    assert.match(search.body, /Kopi Susu Enak/);
    assert.match(search.body, /data-zu-hotkey="k"/);
    const log = await t.get("/admin/_log", ADMIN);
    assert.equal(log.status, 200);
    assert.match(log.body, /Diimpor|Diubah/);
    assert.match((await t.get("/admin", ADMIN)).body, /Log audit/);
  });

  it("pengaturan situs: nilai bawaan, validasi, simpan, dan dibaca aplikasi", async () => {
    assert.deepEqual(await admin.settings(), { siteName: "Situs", email: null, open: null });
    assert.equal((await t.post("/admin/_settings", { siteName: "Kopi Nusantara", email: "bukan email", open: "1" }, ADMIN)).status, 422);
    assert.equal((await t.post("/admin/_settings", { siteName: "Kopi Nusantara", email: "halo@kopi.test", open: "1" }, ADMIN)).status, 303);
    assert.deepEqual(await admin.settings(), { siteName: "Kopi Nusantara", email: "halo@kopi.test", open: true });
    assert.equal((await t.get("/admin/_settings", EDITOR)).status, 403);
  });

  it("pustaka media: unggah, tampil, dan hapus", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const res = await t.post("/admin/_media", {}, ADMIN, { files: { files: { name: "logo.png", type: "image/png", content: png } } });
    assert.equal(res.status, 303, res.body);
    const [name] = fs.readdirSync(uploads);
    assert.ok(name);
    assert.match((await t.get("/admin/_media", ADMIN)).body, new RegExp(name!.replace(".", "\\.")));
    assert.equal((await t.post(`/admin/_media/delete/${name}`, {}, ADMIN)).status, 303);
    assert.deepEqual(fs.readdirSync(uploads), []);
    assert.equal((await t.post("/admin/_media/delete/..%2Fx", {}, ADMIN)).status, 400);
  });
});

describe("admin 0.13.1: pengubah schema", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zusantara-schema-"));
  before(() => {
    fs.mkdirSync(path.join(root, "src", "app", "db"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "app", "db", "schema.ts"),
      `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";\n\nexport const users = sqliteTable("users", {\n  id: integer("id").primaryKey({ autoIncrement: true }),\n  name: text("name").notNull(),\n});\n`,
    );
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("sintaks kolom nama:tipe:tambahan", () => {
    assert.deepEqual(parseColumnArg("title:text:required:unique"), { name: "title", kind: "text", required: true, unique: true });
    assert.deepEqual(parseColumnArg("status:enum(draft, published):default=draft"), { name: "status", kind: "enum", options: ["draft", "published"], default: "draft" });
    assert.deepEqual(parseColumnArg("owner:relation(users)"), { name: "owner", kind: "relation", references: "users" });
    assert.deepEqual(parseColumnArg("publishedAt:datetime"), { name: "published_at", kind: "datetime" });
    assert.throws(() => parseColumnArg("x:uuid"), /Tipe kolom "uuid" tidak dikenal/);
    assert.throws(() => parseColumnArg("x:text:penting"), /"penting"/);
    assert.equal(parseColumnLines("# komentar\n\nname:text\nprice:integer").length, 2);
  });

  it("rencana tabel baru dan kolom baru, dengan argumen CLI yang setara", () => {
    const plan = planSchemaChange(root, { kind: "table", table: { name: "order_items", columns: parseColumnLines(["qty:integer:default=1", "owner:relation(users)"]) } });
    assert.equal(plan.exportName, "orderItems");
    assert.ok(plan.added.some((l) => /sqliteTable\("order_items"/.test(l)));
    assert.deepEqual(cliArgs({ kind: "table", table: { name: "order_items", columns: parseColumnLines(["qty:integer:default=1"]) } }), ["make:table", "order_items", "qty:integer:default=1"]);
    const col = planSchemaChange(root, { kind: "column", table: "users", column: parseColumnArg("phone:text") });
    assert.ok(col.added.some((l) => /phone: text\("phone"\)/.test(l)));
    assert.throws(() => planSchemaChange(root, { kind: "column", table: "nothing", column: parseColumnArg("a:text") }), /Tabel nothing tidak ditemukan/);
  });

  it("make:table --dry-run menampilkan kode tanpa mengubah file", async () => {
    const before = fs.readFileSync(path.join(root, "src", "app", "db", "schema.ts"), "utf8");
    const out: string[] = [];
    const code = await run(["make:table", "products", "name:text:required", "price:integer:default=0", "--dry-run"], { cwd: root, out: (l) => out.push(l), err: (l) => out.push(l), interactive: false });
    assert.equal(code, 0, out.join("\n"));
    assert.ok(out.some((l) => /sqliteTable\("products"/.test(l)), out.join("\n"));
    assert.equal(fs.readFileSync(path.join(root, "src", "app", "db", "schema.ts"), "utf8"), before);
    const bad: string[] = [];
    assert.equal(await run(["make:column", "users"], { cwd: root, out: () => {}, err: (l) => bad.push(l), interactive: false }), 1);
    assert.match(bad.join("\n"), /make:column <tabel> <kolom>/);
  });

  it("halaman /admin/_schema: pratinjau kode dan perintah, hanya untuk admin saat pengembangan", async () => {
    const db = createSqlite(":memory:", { tags });
    await db.run(sql`CREATE TABLE tags (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, name text NOT NULL)`);
    const panel = defineAdmin({ resources: [defineResource({ table: tags, db })], root, schemaEditor: true });
    const t = testAdmin(panel);
    const page = await t.get("/admin/_schema", ADMIN);
    assert.equal(page.status, 200);
    assert.match(page.body, /Tabel baru/);
    const preview = await t.post("/admin/_schema", { mode: "column", table: "users", column: "phone:text" }, ADMIN);
    assert.equal(preview.status, 200, preview.body);
    assert.match(preview.body, /make:column users phone:text/);
    assert.match(preview.body, /Setujui dan terapkan/);
    const bad = await t.post("/admin/_schema", { mode: "table", name: "Bad Name", columns: "a:text" }, ADMIN);
    assert.equal(bad.status, 422);
    assert.equal((await t.get("/admin/_schema", EDITOR)).status, 403);
    assert.equal((await testAdmin(defineAdmin({ resources: [defineResource({ table: tags, db })], root, schemaEditor: false })).get("/admin/_schema", ADMIN)).status, 404);
    await closeDatabase(db);
  });
});

describe("admin 0.13.1: make:admin mengenali tabel penghubung many-to-many", () => {
  // Di dalam paket agar import drizzle-orm dari schema proyek contoh bisa ditemukan.
  const root = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".tmp-admin-many-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("menulis many: { tags: { through: postTags } } di file admin baru", async () => {
    fs.mkdirSync(path.join(root, "src", "app", "db"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "blog", type: "module" }));
    fs.writeFileSync(path.join(root, "src", "app", "db", "index.ts"), "export const db = {} as never;\n");
    fs.writeFileSync(
      path.join(root, "src", "app", "db", "schema.ts"),
      `import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const posts = sqliteTable("posts", { id: integer("id").primaryKey({ autoIncrement: true }), title: text("title").notNull() });
export const tags = sqliteTable("tags", { id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull() });
export const postTags = sqliteTable("post_tags", {
  postId: integer("post_id").notNull().references(() => posts.id),
  tagId: integer("tag_id").notNull().references(() => tags.id),
}, (t) => [primaryKey({ columns: [t.postId, t.tagId] })]);
`,
    );
    const result = await makeAdmin(root, [], { all: true });
    assert.ok(result.ok, result.lines.join("\n"));
    const file = fs.readFileSync(path.join(root, "src", "app", "admin", "posts.ts"), "utf8");
    assert.match(file, /import \{ posts, postTags \} from "\.\.\/db\/schema\.js";/);
    assert.match(file, /many: \{ tags: \{ through: postTags \} \},/);
    assert.match(fs.readFileSync(path.join(root, "src", "app", "admin", "tags.ts"), "utf8"), /many: \{ posts: \{ through: postTags \} \},/);
  });
});
