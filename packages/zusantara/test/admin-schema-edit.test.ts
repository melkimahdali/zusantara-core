import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig as getPgTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import ts from "typescript";
import { addColumn, addTable, detectDialect, tableExports, validateTableSpec, type TableSpec } from "../src/admin/schema-edit.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.resolve(pkgDir, "../create-zusantara/templates/api/src/app/db/schema.ts");
const template = fs.readFileSync(templatePath, "utf8");

const PG_SCHEMA = `import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
});
`;

let tmpDir = "";
let counter = 0;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(pkgDir, ".tmp-schema-"));
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTemp(source: string): string {
  const file = path.join(tmpDir, `schema${++counter}.ts`);
  fs.writeFileSync(file, source);
  return file;
}

async function load(source: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(writeTemp(source)).href)) as Record<string, unknown>;
}

/** Periksa tipe dengan compiler TypeScript (strict). */
function typeErrors(source: string): string[] {
  const file = writeTemp(source);
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === file || !d.file)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const allKinds: TableSpec = {
  name: "order_items",
  columns: [
    { name: "title", kind: "text", required: true },
    { name: "notes", kind: "longtext" },
    { name: "qty", kind: "integer", required: true, default: 1 },
    { name: "price", kind: "number", default: "9.5" },
    { name: "is_gift", kind: "boolean", required: true, default: false },
    { name: "ship_date", kind: "date", default: "2026-01-31" },
    { name: "paid_at", kind: "datetime" },
    { name: "status", kind: "enum", options: ["new", "paid", "shipped"], required: true, default: "new" },
    { name: "meta", kind: "json" },
    { name: "owner", kind: "relation", references: "users", required: true },
    { name: "note_id", kind: "relation", references: "notes" },
    { name: "code", kind: "text", unique: true },
  ],
};

describe("tableExports / detectDialect", () => {
  it("menemukan users dan notes di template", () => {
    assert.deepEqual(tableExports(template), ["users", "notes"]);
  });

  it("mengabaikan definisi di komentar dan string", () => {
    const src = `${template}\n// export const ghost = sqliteTable("ghost", {});\nconst s = "export const x = sqliteTable(";\n`;
    assert.deepEqual(tableExports(src), ["users", "notes"]);
  });

  it("mendeteksi dialek", () => {
    assert.equal(detectDialect(template), "sqlite");
    assert.equal(detectDialect(PG_SCHEMA), "postgres");
    assert.equal(detectDialect(""), "sqlite");
  });
});

describe("validateTableSpec", () => {
  const existing = ["users", "notes"];

  it("spesifikasi valid tidak menghasilkan kesalahan", () => {
    assert.deepEqual(validateTableSpec(allKinds, existing), []);
  });

  it("melaporkan kesalahan dalam bahasa Indonesia", () => {
    const errors = validateTableSpec(
      {
        name: "Bad-Name",
        columns: [
          { name: "id", kind: "integer" },
          { name: "Title", kind: "text" },
          { name: "dup", kind: "text" },
          { name: "dup", kind: "integer" },
          { name: "state", kind: "enum" },
          { name: "owner", kind: "relation", references: "ghosts" },
          { name: "level", kind: "enum", options: ["a", "b"], default: "c" },
          { name: "count", kind: "integer", default: "abc" },
          { name: "created_at", kind: "datetime" },
        ],
      },
      existing,
    );
    const text = errors.join("\n");
    assert.match(text, /nama tabel "Bad-Name"/);
    assert.match(text, /kolom "id": nama ini dipakai otomatis/);
    assert.match(text, /kolom "Title": nama harus huruf kecil/);
    assert.match(text, /kolom "dup": nama ganda/);
    assert.match(text, /kolom "state": enum membutuhkan minimal satu pilihan/);
    assert.match(text, /tabel tujuan "ghosts" tidak ditemukan/);
    assert.match(text, /nilai bawaan "c" harus salah satu pilihan/);
    assert.match(text, /kolom "count": nilai bawaan harus berupa angka/);
    assert.match(text, /kolom "created_at": nama ini dipakai otomatis/);
  });

  it("created_at boleh dipakai bila timestamps: false; tabel yang ada dan kata khusus ditolak", () => {
    assert.deepEqual(validateTableSpec({ name: "logs", timestamps: false, columns: [{ name: "created_at", kind: "datetime" }] }, existing), []);
    assert.match(validateTableSpec({ name: "users", columns: [] }, existing).join(), /sudah ada/);
    assert.match(validateTableSpec({ name: "delete", columns: [] }, existing).join(), /kata khusus/);
    assert.match(validateTableSpec({ name: "text", columns: [] }, existing).join(), /kata khusus/);
  });

  it("relasi 'user' dan kolom 'user_id' bentrok; maksimal 60 kolom; relasi ke diri sendiri ditolak", () => {
    const dup = validateTableSpec({ name: "posts", columns: [{ name: "user", kind: "relation", references: "users" }, { name: "user_id", kind: "integer" }] }, existing);
    assert.match(dup.join(), /nama ganda/);
    const many = Array.from({ length: 61 }, (_, i) => ({ name: `c${i}`, kind: "text" as const }));
    assert.match(validateTableSpec({ name: "wide", columns: many }, existing).join(), /maksimal 60 kolom/);
    assert.match(validateTableSpec({ name: "trees", columns: [{ name: "parent", kind: "relation", references: "trees" }] }, [...existing, "trees"]).join(), /sudah ada|itu sendiri/);
    assert.match(validateTableSpec({ name: "trees", columns: [{ name: "parent", kind: "relation", references: "trees" }] }, existing).join(), /itu sendiri/);
  });
});

describe("addTable (sqlite)", () => {
  it("membuat tabel dengan semua jenis kolom yang bisa diimpor dan valid secara tipe", async () => {
    const { source, exportName } = addTable(template, allKinds);
    assert.equal(exportName, "orderItems");
    assert.ok(source.replace(/^[^\n]*\n/, "").startsWith(template.replace(/^[^\n]*\n/, "").trimEnd()), "isi lama tidak berubah selain impor");
    assert.match(source, /^import \{ index, integer, real, sqliteTable, text \} from "drizzle-orm\/sqlite-core";/);
    assert.match(source, /\n\n\/\*\* Order items \(dibuat lewat panel admin\)\. \*\/\nexport const orderItems = sqliteTable\("order_items", \{\n  id: integer\("id"\)\.primaryKey\(\{ autoIncrement: true \}\),\n/);
    assert.match(source, /  ownerId: integer\("owner_id"\)\.notNull\(\)\.references\(\(\) => users\.id\),\n/);
    assert.match(source, /  createdAt: integer\("created_at", \{ mode: "timestamp" \}\)\.notNull\(\)\.\$defaultFn\(\(\) => new Date\(\)\),\n/);
    assert.match(source, /\$onUpdate\(\(\) => new Date\(\)\),\n\}\);\n\nexport type OrderItem = typeof orderItems\.\$inferSelect;\n$/);

    assert.deepEqual(typeErrors(source), []);
    const mod = await load(source);
    const table = mod.orderItems as SQLiteTable;
    const cols = getTableColumns(table);
    assert.deepEqual(Object.keys(cols), ["id", "title", "notes", "qty", "price", "isGift", "shipDate", "paidAt", "status", "meta", "ownerId", "noteId", "code", "createdAt", "updatedAt"]);
    assert.equal(cols.id!.primary, true);
    assert.equal(cols.title!.notNull, true);
    assert.equal(cols.notes!.notNull, false);
    assert.equal(cols.qty!.default, 1);
    assert.equal(cols.qty!.columnType, "SQLiteInteger");
    assert.equal(cols.price!.default, 9.5);
    assert.equal(cols.price!.columnType, "SQLiteReal");
    assert.equal(cols.isGift!.columnType, "SQLiteBoolean");
    assert.equal(cols.isGift!.default, false);
    assert.equal(cols.shipDate!.columnType, "SQLiteText");
    assert.equal(cols.shipDate!.default, "2026-01-31");
    assert.equal(cols.paidAt!.columnType, "SQLiteTimestamp");
    assert.deepEqual(cols.status!.enumValues, ["new", "paid", "shipped"]);
    assert.equal(cols.status!.default, "new");
    assert.equal(cols.meta!.columnType, "SQLiteTextJson");
    assert.equal(cols.ownerId!.name, "owner_id");
    assert.equal(cols.noteId!.name, "note_id");
    assert.equal(cols.code!.isUnique, true);
    assert.equal(cols.createdAt!.name, "created_at");
    assert.ok(cols.updatedAt!.onUpdateFn);

    const config = getTableConfig(table);
    assert.equal(config.name, "order_items");
    const fks = config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return `${ref.columns[0]!.name}->${getTableConfig(ref.foreignTable).name}.${ref.foreignColumns[0]!.name}`;
    });
    assert.deepEqual(fks.sort(), ["note_id->notes.id", "owner_id->users.id"]);
  });

  it("tanpa pola $inferSelect tidak menambah type; timestamps: false tanpa createdAt", () => {
    const base = template.replace(/export type [^\n]*\n/g, "");
    const { source } = addTable(base, { name: "tags", timestamps: false, columns: [{ name: "label", kind: "text", required: true }] });
    assert.doesNotMatch(source, /export type Tag/);
    assert.doesNotMatch(source, /export const tags[\s\S]*createdAt/);
    assert.match(source, /export const tags = sqliteTable\("tags", \{\n  id: integer\("id"\)\.primaryKey\(\{ autoIncrement: true \}\),\n  label: text\("label"\)\.notNull\(\),\n\}\);\n$/);
  });

  it("nama type bentrok diberi akhiran Row", () => {
    const base = `${template}\nexport type Tag = { x: 1 };\n`;
    const { source } = addTable(base, { name: "tags", columns: [] });
    assert.match(source, /export type TagRow = typeof tags\.\$inferSelect;/);
  });

  it("membuat impor bila belum ada", async () => {
    const { source } = addTable("// skema kosong\n", { name: "items", columns: [{ name: "name", kind: "text" }] });
    assert.match(source, /^import \{ integer, sqliteTable, text \} from "drizzle-orm\/sqlite-core";\n\n\/\/ skema kosong\n/);
    const mod = await load(source);
    assert.ok(mod.items);
  });

  it("menyisipkan impor setelah impor lain dan menggabungkan impor multi-baris", () => {
    const withOther = `import { sql } from "drizzle-orm";\n\nexport const x = 1;\n`;
    const a = addTable(withOther, { name: "items", columns: [] }).source;
    assert.match(a, /^import \{ sql \} from "drizzle-orm";\nimport \{ integer, sqliteTable \} from "drizzle-orm\/sqlite-core";\n\nexport const x = 1;/);

    const multi = `import {\n  text,\n  sqliteTable,\n  integer,\n  text,\n} from "drizzle-orm/sqlite-core";\n`;
    const b = addTable(multi, { name: "items", columns: [{ name: "score", kind: "number" }] }).source;
    assert.match(b, /^import \{\n  integer,\n  real,\n  sqliteTable,\n  text,\n\} from "drizzle-orm\/sqlite-core";\n/);
  });

  it("menolak spesifikasi tidak valid dan nama tabel SQL ganda", () => {
    assert.throws(() => addTable(template, { name: "things", columns: [{ name: "kind", kind: "enum" }] }), /Spesifikasi tabel tidak valid[\s\S]*enum membutuhkan/);
    const base = `${template}\nexport const legacyNotes = sqliteTable("legacy", { id: integer("id") });\n`;
    assert.throws(() => addTable(base, { name: "legacy", columns: [] }), /tabel SQL "legacy" sudah ada/);
  });

  it("mempertahankan CRLF", async () => {
    const crlf = template.replace(/\n/g, "\r\n");
    const { source } = addTable(crlf, allKinds);
    assert.doesNotMatch(source.replace(/\r\n/g, ""), /\n/);
    const next = addColumn(source, "orderItems", { name: "extra", kind: "boolean" });
    assert.doesNotMatch(next.replace(/\r\n/g, ""), /\n/);
    const mod = await load(next);
    assert.ok("extra" in getTableColumns(mod.orderItems as SQLiteTable));
  });
});

describe("addColumn", () => {
  it("menambah kolom sebagai properti terakhir notes", async () => {
    let src = addColumn(template, "notes", { name: "pinned", kind: "boolean", required: true, default: false });
    src = addColumn(src, "notes", { name: "rating", kind: "number" });
    src = addColumn(src, "notes", { name: "category", kind: "enum", options: ["a", "b"], default: "a" });
    src = addColumn(src, "notes", { name: "editor", kind: "relation", references: "users" });
    assert.match(src, /      \.\$onUpdateFn\(\(\) => new Date\(\)\),\n    pinned: integer\("pinned", \{ mode: "boolean" \}\)\.notNull\(\)\.default\(false\),\n    rating: real\("rating"\),\n    category: text\("category", \{ enum: \["a", "b"\] \}\)\.default\("a"\),\n    editorId: integer\("editor_id"\)\.references\(\(\) => users\.id\),\n  \},\n  \(t\) => \[index/);
    assert.match(src, /^import \{ index, integer, real, sqliteTable, text \} from "drizzle-orm\/sqlite-core";/);
    // Bagian lain tidak berubah.
    assert.equal(src.replace(/^import[^\n]*\n/, "").replace(/\n    pinned[\s\S]*?editor_id[^\n]*\n/, "\n"), template.replace(/^import[^\n]*\n/, ""));

    assert.deepEqual(typeErrors(src), []);
    const mod = await load(src);
    const cols = getTableColumns(mod.notes as SQLiteTable);
    assert.equal(cols.pinned!.notNull, true);
    assert.equal(cols.pinned!.default, false);
    assert.equal(cols.rating!.columnType, "SQLiteReal");
    assert.deepEqual(cols.category!.enumValues, ["a", "b"]);
    const fks = getTableConfig(mod.notes as SQLiteTable).foreignKeys.map((fk) => fk.reference().columns[0]!.name);
    assert.deepEqual(fks.sort(), ["editor_id", "user_id"]);
  });

  it("objek tanpa koma akhir, objek satu baris, dan objek kosong", async () => {
    const src = `import { integer, sqliteTable } from "drizzle-orm/sqlite-core";

export const a = sqliteTable("a", {
    id: integer("id").primaryKey() // kunci
});
export const b = sqliteTable("b", { id: integer("id").primaryKey() });
export const c = sqliteTable("c", {});
`;
    let out = addColumn(src, "a", { name: "label", kind: "text" });
    out = addColumn(out, "b", { name: "label", kind: "text", unique: true });
    out = addColumn(out, "c", { name: "label", kind: "text" });
    assert.match(out, /    id: integer\("id"\)\.primaryKey\(\), \/\/ kunci\n    label: text\("label"\)\n\}\);/);
    assert.match(out, /sqliteTable\("b", \{ id: integer\("id"\)\.primaryKey\(\), label: text\("label"\)\.unique\(\) \}\);/);
    assert.match(out, /sqliteTable\("c", \{ label: text\("label"\) \}\);/);
    const mod = await load(out);
    assert.equal(getTableColumns(mod.b as SQLiteTable).label!.isUnique, true);
  });

  it("mengabaikan kurung di string, template literal, dan komentar", async () => {
    const src = `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const tag = "x";
export const weird = sqliteTable("weird", {
  id: integer("id").primaryKey(), // } ) {
  /* } */ a: text("a").default("}{"),
  b: text(\`b\${tag === "x" ? "" : "}"}\`).default('\\'}'),
});
`;
    const out = addColumn(src, "weird", { name: "c", kind: "integer", default: 3 });
    assert.match(out, /default\('\\'\}'\),\n  c: integer\("c"\)\.default\(3\),\n\}\);/);
    const mod = await load(out);
    assert.equal(getTableColumns(mod.weird as SQLiteTable).c!.default, 3);
  });

  it("menolak kolom wajib tanpa nilai bawaan, kolom ganda, dan tabel tak dikenal", () => {
    assert.throws(() => addColumn(template, "notes", { name: "slug", kind: "text", required: true }), /baris lama/);
    assert.throws(() => addColumn(template, "notes", { name: "title", kind: "text" }), /sudah ada/);
    assert.throws(() => addColumn(template, "notes", { name: "user", kind: "relation", references: "users" }), /sudah ada/);
    assert.throws(() => addColumn(template, "notes", { name: "id", kind: "integer" }), /otomatis/);
    assert.throws(() => addColumn(template, "ghosts", { name: "x", kind: "text" }), /Tabel "ghosts" tidak ditemukan/);
    assert.throws(() => addColumn(template, "notes", { name: "owner", kind: "relation", references: "ghosts" }), /tidak ditemukan/);
    assert.throws(() => addColumn(template, "notes", { name: "Bad", kind: "text" }), /huruf kecil/);
  });

  it("melaporkan kurung tidak seimbang", () => {
    const broken = `import { integer, sqliteTable } from "drizzle-orm/sqlite-core";\nexport const bad = sqliteTable("bad", {\n  id: integer("id"),\n`;
    assert.throws(() => addColumn(broken, "bad", { name: "x", kind: "text" }), /tidak seimbang/);
  });
});

describe("postgres", () => {
  it("menghasilkan kode pg-core yang valid", async () => {
    assert.equal(detectDialect(PG_SCHEMA), "postgres");
    // notes tidak ada di skema pg ini, jadi relasi ke notes dibuang dari spesifikasi.
    const pgSpec = { ...allKinds, columns: allKinds.columns.filter((c) => c.name !== "note_id") };
    const { source } = addTable(PG_SCHEMA, pgSpec);
    assert.match(source, /^import \{ boolean, date, doublePrecision, integer, jsonb, pgTable, serial, text, timestamp \} from "drizzle-orm\/pg-core";/);
    assert.match(source, /export const orderItems = pgTable\("order_items", \{\n  id: serial\("id"\)\.primaryKey\(\),\n/);
    assert.match(source, /  price: doublePrecision\("price"\)\.default\(9\.5\),\n/);
    assert.match(source, /  isGift: boolean\("is_gift"\)\.notNull\(\)\.default\(false\),\n/);
    assert.match(source, /  shipDate: date\("ship_date"\)\.default\("2026-01-31"\),\n/);
    assert.match(source, /  paidAt: timestamp\("paid_at"\),\n/);
    assert.match(source, /  status: text\("status", \{ enum: \["new", "paid", "shipped"\] \}\)\.notNull\(\)\.default\("new"\),\n/);
    assert.match(source, /  meta: jsonb\("meta"\),\n/);
    assert.match(source, /  updatedAt: timestamp\("updated_at"\)\.notNull\(\)\.defaultNow\(\)\.\$onUpdate\(\(\) => new Date\(\)\),\n/);

    assert.throws(() => addTable(PG_SCHEMA, allKinds), /tabel tujuan "notes" tidak ditemukan/);

    const withCol = addColumn(source, "users", { name: "seen_at", kind: "datetime", required: true, default: "now" });
    assert.match(withCol, /  seenAt: timestamp\("seen_at"\)\.notNull\(\)\.defaultNow\(\),\n\}\);/);

    assert.deepEqual(typeErrors(withCol), []);
    const mod = await load(withCol);
    const table = mod.orderItems as PgTable;
    const cols = getTableColumns(table);
    assert.equal(cols.id!.columnType, "PgSerial");
    assert.equal(cols.price!.columnType, "PgDoublePrecision");
    assert.equal(cols.isGift!.columnType, "PgBoolean");
    assert.equal(cols.meta!.columnType, "PgJsonb");
    assert.deepEqual(cols.status!.enumValues, ["new", "paid", "shipped"]);
    assert.equal(cols.code!.isUnique, true);
    const fks = getPgTableConfig(table).foreignKeys.map((fk) => fk.reference().columns[0]!.name);
    assert.deepEqual(fks, ["owner_id"]);
    assert.equal(getTableColumns(mod.users as PgTable).seenAt!.hasDefault, true);
  });
});
