import fs from "node:fs";
import path from "node:path";
import { t } from "../i18n/index.js";
import { addColumn, addTable, tableExports, type ColumnKind, type ColumnSpec, type TableSpec } from "./schema-edit.js";

/**
 * Perubahan schema dari CLI (`zusantara make:table`, `make:column`), Zusantara AI, dan halaman
 * /admin/_schema. Kolom ditulis satu per argumen atau per baris:
 *
 *   title:text:required
 *   email:text:required:unique
 *   price:integer:default=0
 *   status:enum(draft,published):default=draft
 *   category:relation(categories)
 */

const KINDS: Record<string, ColumnKind> = {
  text: "text",
  string: "text",
  teks: "text",
  longtext: "longtext",
  textarea: "longtext",
  integer: "integer",
  int: "integer",
  number: "number",
  decimal: "number",
  real: "number",
  angka: "number",
  boolean: "boolean",
  bool: "boolean",
  date: "date",
  tanggal: "date",
  datetime: "datetime",
  timestamp: "datetime",
  waktu: "datetime",
  json: "json",
  enum: "enum",
  pilihan: "enum",
  relation: "relation",
  ref: "relation",
  relasi: "relation",
};

/** Satu kolom dari teks "nama:tipe[:required][:unique][:default=nilai]". */
export function parseColumnArg(arg: string): ColumnSpec {
  const m = t().admin.schema;
  const text = arg.trim();
  const head = /^([A-Za-z][\w]*)\s*:\s*([a-z]+)\s*(?:\(([^)]*)\))?/i.exec(text);
  if (!head) throw new Error(m.badColumn(arg));
  const kind = KINDS[head[2]!.toLowerCase()];
  if (!kind) throw new Error(m.badKind(head[2]!));
  const name = head[1]!.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const spec: ColumnSpec = { name, kind };
  const inner = head[3]?.trim();
  if (kind === "enum") spec.options = (inner ?? "").split(/[,|]/).map((s) => s.trim()).filter(Boolean);
  if (kind === "relation") spec.references = inner;
  const rest = text.slice(head[0].length);
  for (const part of rest.split(":").map((s) => s.trim()).filter(Boolean)) {
    const lower = part.toLowerCase();
    if (lower === "required" || lower === "wajib" || lower === "notnull") spec.required = true;
    else if (lower === "unique" || lower === "unik") spec.unique = true;
    else if (/^(default|bawaan)=/i.test(part)) spec.default = part.slice(part.indexOf("=") + 1);
    else throw new Error(m.badModifier(part, arg));
  }
  return spec;
}

/** Baris-baris kolom (dari textarea atau argumen CLI); baris kosong dan komentar # dilewati. */
export function parseColumnLines(text: string | string[]): ColumnSpec[] {
  const lines = Array.isArray(text) ? text : text.split(/\r?\n/);
  return lines.map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean).map(parseColumnArg);
}

export type SchemaChange = { kind: "table"; table: TableSpec } | { kind: "column"; table: string; column: ColumnSpec };

export interface SchemaPlan {
  file: string;
  before: string;
  after: string;
  /** Nama export tabel yang dibuat atau diubah (untuk make:admin). */
  exportName: string;
  /** Baris kode yang ditambahkan (untuk pratinjau). */
  added: string[];
}

export function schemaFile(root: string): string | undefined {
  const base = path.join(root, "src", "app", "db", "schema");
  return [".ts", ".mts", ".js", ".mjs"].map((e) => base + e).find((f) => fs.existsSync(f));
}

/** Nama export tabel dari nama export atau nama tabel SQL (order_items -> orderItems). */
export function resolveTable(source: string, name: string): string | undefined {
  const exports = tableExports(source);
  if (exports.includes(name)) return name;
  const camel = name.replace(/[_-]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  if (exports.includes(camel)) return camel;
  const re = new RegExp(`(?:export\\s+const\\s+(\\w+)\\s*=\\s*(?:sqliteTable|pgTable)\\s*\\(\\s*["'\`]${name.replace(/[^\w]/g, "")}["'\`])`);
  return re.exec(source)?.[1];
}

/** Hitung perubahan tanpa menulis file. Melempar Error berisi semua masalah bila tidak valid. */
export function planSchemaChange(root: string, change: SchemaChange): SchemaPlan {
  const m = t().admin.schema;
  const file = schemaFile(root);
  if (!file) throw new Error(m.noSchema);
  const before = fs.readFileSync(file, "utf8");
  let after: string;
  let exportName: string;
  if (change.kind === "table") {
    const out = addTable(before, change.table);
    after = out.source;
    exportName = out.exportName;
  } else {
    const resolved = resolveTable(before, change.table);
    if (!resolved) throw new Error(m.unknownTable(change.table, tableExports(before).join(", ")));
    after = addColumn(before, resolved, change.column);
    exportName = resolved;
  }
  const old = new Set(before.split(/\r?\n/));
  const added = after.split(/\r?\n/).filter((line) => !old.has(line));
  return { file, before, after, exportName, added };
}

/** Tulis hasil rencana; gagal bila schema.ts berubah sejak rencana dibuat. */
export function writeSchemaPlan(plan: SchemaPlan): void {
  if (fs.readFileSync(plan.file, "utf8") !== plan.before) throw new Error(t().admin.schema.changedMeanwhile);
  fs.writeFileSync(plan.file, plan.after);
}

/** Argumen CLI yang setara, untuk ditampilkan dan dijalankan halaman admin. */
export function cliArgs(change: SchemaChange): string[] {
  const col = (c: ColumnSpec) => {
    let s = `${c.name}:${c.kind}`;
    if (c.kind === "enum") s += `(${(c.options ?? []).join(",")})`;
    if (c.kind === "relation") s += `(${c.references ?? ""})`;
    if (c.required) s += ":required";
    if (c.unique) s += ":unique";
    if (c.default !== undefined && c.default !== "") s += `:default=${String(c.default)}`;
    return s;
  };
  if (change.kind === "table") return ["make:table", change.table.name, ...change.table.columns.map(col), ...(change.table.timestamps === false ? ["--no-timestamps"] : [])];
  return ["make:column", change.table, col(change.column)];
}
