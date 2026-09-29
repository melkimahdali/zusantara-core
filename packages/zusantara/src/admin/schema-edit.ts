/**
 * Editor skema untuk panel admin (khusus dev): mengubah spesifikasi form (tabel/kolom baru)
 * menjadi suntingan kode sumber `src/app/db/schema.ts` (Drizzle, sqlite-core atau pg-core).
 *
 * Suntingan bersifat tekstual dan minimal: impor builder digabung, tabel baru ditambahkan di akhir
 * file, kolom baru disisipkan sebagai properti terakhir objek kolom tabel. Akhir baris CRLF dipertahankan.
 */

import { t } from "../i18n/index.js";

export type ColumnKind = "text" | "longtext" | "integer" | "number" | "boolean" | "date" | "datetime" | "enum" | "json" | "relation";

export interface ColumnSpec {
  /** Nama kolom SQL, snake_case. */
  name: string;
  kind: ColumnKind;
  required?: boolean;
  unique?: boolean;
  /** Nilai bawaan. Untuk `datetime`, "now" berarti waktu saat baris dibuat. */
  default?: string | number | boolean;
  /** Pilihan untuk `enum`. */
  options?: string[];
  /** Nama export tabel tujuan untuk `relation`, mis. "users". */
  references?: string;
}

export interface TableSpec {
  /** Nama tabel SQL, snake_case. */
  name: string;
  columns: ColumnSpec[];
  /** Tambah createdAt dan updatedAt (bawaan: true). */
  timestamps?: boolean;
}

export type SchemaDialect = "sqlite" | "postgres";

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const MAX_COLUMNS = 60;

const JS_RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if " +
    "import in instanceof new null return super switch this throw true try typeof var void while with yield let static " +
    "implements interface package private protected public await arguments eval undefined"
  ).split(" "),
);

/** Nama builder yang mungkin diimpor; export tabel tidak boleh bentrok dengannya. */
const BUILDER_NAMES = new Set([
  "sqliteTable",
  "pgTable",
  "integer",
  "text",
  "real",
  "serial",
  "boolean",
  "doublePrecision",
  "date",
  "timestamp",
  "jsonb",
  "index",
  "uniqueIndex",
]);

const GLOBAL_TYPES = new Set(["String", "Number", "Boolean", "Object", "Date", "Array", "Map", "Set", "Record", "Promise", "Error", "Function", "Symbol", "RegExp", "JSON", "Math"]);

/* ------------------------------------------------------------------ nama */

function camelCase(name: string): string {
  return name.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/_+$/, "");
}

function relationSqlName(name: string): string {
  return name.endsWith("_id") ? name : `${name}_id`;
}

function sqlName(col: ColumnSpec): string {
  return col.kind === "relation" ? relationSqlName(col.name) : col.name;
}

function humanize(name: string): string {
  const s = name.replace(/_+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function singularPascal(exportName: string): string {
  let s = exportName;
  if (/ies$/.test(s)) s = s.slice(0, -3) + "y";
  else if (/(s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (/[^s]s$/.test(s)) s = s.slice(0, -1);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ------------------------------------------------------------------ pemindai */

/**
 * Salinan sumber dengan isi komentar, string, dan bagian teks template literal diganti spasi
 * (panjang dan baris tetap sama), jadi regex dan penghitungan kurung bisa dipakai dengan aman.
 * Batasan: literal regex tidak dikenali.
 */
function maskSource(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < Math.min(b, n); k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const exprStack: number[] = [];
  let depth = 0;
  let mode: "code" | "template" = "code";
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (mode === "template") {
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
      } else if (c === "`") {
        mode = "code";
        i++;
      } else if (c === "$" && src[i + 1] === "{") {
        blank(i, i + 2);
        exprStack.push(depth);
        mode = "code";
        i += 2;
      } else {
        blank(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (c === "`") {
      mode = "template";
      i++;
    } else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      if (exprStack.length && exprStack[exprStack.length - 1] === depth) {
        exprStack.pop();
        blank(i, i + 1);
        mode = "template";
      } else depth--;
      i++;
    } else i++;
  }
  return out.join("");
}

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Indeks kurung penutup pasangan `open` pada sumber yang sudah di-mask, atau -1. */
function matchBracket(masked: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]!;
    if (c in PAIRS) stack.push(PAIRS[c]!);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function eolOf(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

/* ------------------------------------------------------------------ deteksi */

export function detectDialect(source: string): SchemaDialect {
  return /drizzle-orm\/pg-core|\bpgTable\s*\(/.test(maskKeepImports(source)) ? "postgres" : "sqlite";
}

/** Mask, tetapi spesifier modul pada impor tetap terbaca. */
function maskKeepImports(source: string): string {
  const masked = maskSource(source);
  let out = masked;
  for (const m of source.matchAll(/from\s*(["'])([^"'\n]*)\1/g)) {
    if (masked.startsWith("from", m.index)) out = out.slice(0, m.index) + m[0] + out.slice(m.index + m[0].length);
  }
  return out;
}

export function tableExports(source: string): string[] {
  const masked = maskSource(source);
  return [...masked.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:sqliteTable|pgTable)\s*\(/g)].map((m) => m[1]!);
}

/* ------------------------------------------------------------------ validasi */

function coerceDefault(col: ColumnSpec): { ok: true; code?: string } | { ok: false; error: string } {
  const v = col.default;
  if (v === undefined || v === "") return { ok: true };
  const bad = (error: string) => ({ ok: false as const, error });
  const m = t().admin.schemaErrors;
  switch (col.kind) {
    case "text":
    case "longtext":
      return { ok: true, code: JSON.stringify(String(v)) };
    case "enum": {
      const s = String(v);
      if (!(col.options ?? []).includes(s)) return bad(m.defaultNotOption(col.name, s));
      return { ok: true, code: JSON.stringify(s) };
    }
    case "integer":
    case "relation":
    case "number": {
      const num = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(num)) return bad(m.defaultNotNumber(col.name));
      if (col.kind !== "number" && !Number.isInteger(num)) return bad(m.defaultNotInteger(col.name));
      return { ok: true, code: String(num) };
    }
    case "boolean": {
      if (typeof v === "boolean") return { ok: true, code: String(v) };
      if (v === "true" || v === "false") return { ok: true, code: v };
      return bad(m.defaultNotBoolean(col.name));
    }
    case "date": {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return bad(m.defaultNotDate(col.name));
      return { ok: true, code: JSON.stringify(v) };
    }
    case "datetime": {
      if (v === "now") return { ok: true, code: "now" };
      return bad(m.defaultNotNow(col.name));
    }
    case "json": {
      if (typeof v !== "string") return { ok: true, code: JSON.stringify(v) };
      try {
        return { ok: true, code: JSON.stringify(JSON.parse(v)) };
      } catch {
        return bad(m.defaultNotJson(col.name));
      }
    }
  }
}

function hasDefault(col: ColumnSpec): boolean {
  return col.default !== undefined && col.default !== "";
}

/** Kesalahan yang hanya bergantung pada kolom itu sendiri (dan daftar export yang ada). */
function columnErrors(col: ColumnSpec, existingExports: string[], ownExport?: string): string[] {
  const errors: string[] = [];
  const m = t().admin.schemaErrors;
  if (typeof col.name !== "string" || !NAME_RE.test(col.name)) {
    errors.push(m.badColumnName(col.name));
    return errors;
  }
  if (col.kind === "enum") {
    const opts = col.options ?? [];
    if (opts.length === 0) errors.push(m.enumNoOptions(col.name));
    if (opts.some((o) => typeof o !== "string" || o.trim() === "")) errors.push(m.enumEmptyOption(col.name));
    if (new Set(opts).size !== opts.length) errors.push(m.enumDuplicateOption(col.name));
  }
  if (col.kind === "relation") {
    if (!col.references) errors.push(m.relationNoTarget(col.name));
    else if (ownExport !== undefined && col.references === ownExport) errors.push(m.relationSelf(col.name));
    else if (!existingExports.includes(col.references)) errors.push(m.relationTargetMissing(col.name, col.references));
  }
  const d = coerceDefault(col);
  if (!d.ok) errors.push(d.error);
  return errors;
}

function reservedNames(timestamps: boolean): Set<string> {
  return new Set(timestamps ? ["id", "created_at", "updated_at"] : ["id"]);
}

export function validateTableSpec(spec: TableSpec, existingExports: string[]): string[] {
  const errors: string[] = [];
  const m = t().admin.schemaErrors;
  const timestamps = spec.timestamps !== false;
  if (typeof spec.name !== "string" || !NAME_RE.test(spec.name)) {
    errors.push(m.badTableName(spec.name));
  } else {
    const exportName = camelCase(spec.name);
    if (existingExports.includes(exportName)) errors.push(m.tableExists(exportName));
    else if (JS_RESERVED.has(exportName) || BUILDER_NAMES.has(exportName)) errors.push(m.tableNameReserved(spec.name));
  }
  const columns = Array.isArray(spec.columns) ? spec.columns : [];
  if (columns.length > MAX_COLUMNS) errors.push(m.tooManyColumns(MAX_COLUMNS));
  const reserved = reservedNames(timestamps);
  const seenSql = new Set<string>(reserved);
  const seenKey = new Set<string>([...reserved].map(camelCase));
  const ownExport = NAME_RE.test(spec.name ?? "") ? camelCase(spec.name) : undefined;
  for (const col of columns) {
    const errs = columnErrors(col, existingExports, ownExport);
    errors.push(...errs);
    if (!NAME_RE.test(col.name ?? "")) continue;
    if (reserved.has(col.name)) {
      errors.push(m.columnAutomatic(col.name));
      continue;
    }
    const sql = sqlName(col);
    const key = camelCase(sql);
    if (seenSql.has(sql) || seenKey.has(key)) errors.push(m.columnDuplicate(col.name));
    seenSql.add(sql);
    seenKey.add(key);
  }
  return errors;
}

/* ------------------------------------------------------------------ kode kolom */

interface ColumnCode {
  key: string;
  code: string;
  builders: string[];
}

function columnCode(col: ColumnSpec, dialect: SchemaDialect): ColumnCode {
  const sql = sqlName(col);
  const key = camelCase(sql);
  const q = JSON.stringify(sql);
  const pg = dialect === "postgres";
  let call: string;
  let builder: string;
  switch (col.kind) {
    case "text":
    case "longtext":
      [builder, call] = ["text", `text(${q})`];
      break;
    case "integer":
    case "relation":
      [builder, call] = ["integer", `integer(${q})`];
      break;
    case "number":
      [builder, call] = pg ? ["doublePrecision", `doublePrecision(${q})`] : ["real", `real(${q})`];
      break;
    case "boolean":
      [builder, call] = pg ? ["boolean", `boolean(${q})`] : ["integer", `integer(${q}, { mode: "boolean" })`];
      break;
    case "date":
      [builder, call] = pg ? ["date", `date(${q})`] : ["text", `text(${q})`];
      break;
    case "datetime":
      [builder, call] = pg ? ["timestamp", `timestamp(${q})`] : ["integer", `integer(${q}, { mode: "timestamp" })`];
      break;
    case "enum":
      [builder, call] = ["text", `text(${q}, { enum: [${(col.options ?? []).map((o) => JSON.stringify(o)).join(", ")}] })`];
      break;
    case "json":
      [builder, call] = pg ? ["jsonb", `jsonb(${q})`] : ["text", `text(${q}, { mode: "json" })`];
      break;
  }
  if (col.required) call += ".notNull()";
  if (col.unique) call += ".unique()";
  const d = coerceDefault(col);
  if (d.ok && d.code !== undefined) {
    if (d.code === "now") call += pg ? ".defaultNow()" : ".$defaultFn(() => new Date())";
    else call += `.default(${d.code})`;
  }
  if (col.kind === "relation") call += `.references(() => ${col.references}.id)`;
  return { key, code: `${key}: ${call}`, builders: [builder] };
}

function tableLines(spec: TableSpec, dialect: SchemaDialect): { lines: string[]; builders: string[] } {
  const pg = dialect === "postgres";
  const builders = new Set<string>([pg ? "pgTable" : "sqliteTable"]);
  const lines: string[] = [];
  if (pg) {
    builders.add("serial");
    lines.push(`id: serial("id").primaryKey()`);
  } else {
    builders.add("integer");
    lines.push(`id: integer("id").primaryKey({ autoIncrement: true })`);
  }
  for (const col of spec.columns) {
    const c = columnCode(col, dialect);
    c.builders.forEach((b) => builders.add(b));
    lines.push(c.code);
  }
  if (spec.timestamps !== false) {
    if (pg) {
      builders.add("timestamp");
      lines.push(`createdAt: timestamp("created_at").notNull().defaultNow()`);
      lines.push(`updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date())`);
    } else {
      builders.add("integer");
      lines.push(`createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date())`);
      lines.push(`updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date())`);
    }
  }
  return { lines, builders: [...builders] };
}

/* ------------------------------------------------------------------ impor */

function sortNames(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Pastikan `names` diimpor dari drizzle-orm/<dialect>-core; daftar impor diurutkan tanpa duplikat. */
function ensureImports(source: string, dialect: SchemaDialect, names: string[]): string {
  const mod = dialect === "postgres" ? "drizzle-orm/pg-core" : "drizzle-orm/sqlite-core";
  const eol = eolOf(source);
  const masked = maskSource(source);
  const re = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])([^"'\n]+)\2(\s*;)?/g;
  for (const m of source.matchAll(re)) {
    if (m[3] !== mod || !masked.startsWith("import", m.index)) continue;
    const current = m[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const local = new Set(current.map((s) => s.split(/\s+as\s+/).pop()!.trim()));
    const missing = names.filter((n) => !local.has(n));
    if (missing.length === 0) return source;
    const merged = sortNames([...current, ...missing]);
    const quote = m[2]!;
    const semi = m[4] ? ";" : "";
    let list: string;
    if (m[1]!.includes("\n")) {
      const indent = /\n([ \t]*)\S/.exec(m[1]!)?.[1] ?? "  ";
      list = `{${eol}${merged.map((s) => `${indent}${s},`).join(eol)}${eol}}`;
    } else list = `{ ${merged.join(", ")} }`;
    const replacement = `import ${list} from ${quote}${mod}${quote}${semi}`;
    return source.slice(0, m.index) + replacement + source.slice(m.index + m[0].length);
  }
  // Belum ada impor: sisipkan setelah impor terakhir (atau di awal file).
  const line = `import { ${sortNames(names).join(", ")} } from "${mod}";`;
  let insertAt = -1;
  for (const m of source.matchAll(/\bimport\b[^;]*?from\s*(["'])[^"'\n]+\1;?|\bimport\s*(["'])[^"'\n]+\2;?/g)) {
    if (masked.startsWith("import", m.index)) insertAt = m.index + m[0].length;
  }
  if (insertAt === -1) return `${line}${eol}${source.length ? eol : ""}${source}`;
  return source.slice(0, insertAt) + eol + line + source.slice(insertAt);
}

/* ------------------------------------------------------------------ addTable */

export function addTable(source: string, spec: TableSpec): { source: string; exportName: string } {
  const dialect = detectDialect(source);
  const existing = tableExports(source);
  const errors = validateTableSpec(spec, existing);
  const exportName = camelCase(spec.name);
  const masked = maskSource(source);
  if (errors.length === 0) {
    if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${exportName}\\b`).test(masked)) errors.push(t().admin.schemaErrors.nameTaken(exportName));
    const tableNameRe = new RegExp(`\\b(?:sqliteTable|pgTable)\\s*\\(\\s*(["'\`])${spec.name}\\1`);
    if (tableNameRe.test(source)) errors.push(t().admin.schemaErrors.sqlTableExists(spec.name));
  }
  if (errors.length) throw new Error(`${t().admin.schemaErrors.invalidTableSpec}:\n- ${errors.join("\n- ")}`);

  const eol = eolOf(source);
  const { lines, builders } = tableLines(spec, dialect);
  const fn = dialect === "postgres" ? "pgTable" : "sqliteTable";
  let block =
    `/** ${humanize(spec.name)} (dibuat lewat panel admin). */${eol}` +
    `export const ${exportName} = ${fn}(${JSON.stringify(spec.name)}, {${eol}` +
    lines.map((l) => `  ${l},${eol}`).join("") +
    `});${eol}`;

  if (/\bexport\s+type\s+\w+\s*=\s*typeof\s+[\w$]+\.\$inferSelect\b/.test(masked)) {
    let typeName = singularPascal(exportName);
    const declared = new RegExp(`\\b(?:type|interface|class|enum|const|let|var|function)\\s+${typeName}\\b`);
    if (GLOBAL_TYPES.has(typeName) || declared.test(masked)) typeName += "Row";
    block += `${eol}export type ${typeName} = typeof ${exportName}.$inferSelect;${eol}`;
  }

  let next = ensureImports(source, dialect, builders);
  next = next.replace(/(?:\r?\n|[ \t])*$/, "");
  next = next.length ? `${next}${eol}${eol}${block}` : block;
  return { source: next, exportName };
}

/* ------------------------------------------------------------------ addColumn */

interface TableBody {
  open: number;
  close: number;
}

function findTableBody(masked: string, exportName: string): TableBody {
  const re = new RegExp(`\\bexport\\s+const\\s+${exportName.replace(/\$/g, "\\$")}\\s*=\\s*(?:sqliteTable|pgTable)\\s*\\(`, "g");
  const m = re.exec(masked);
  if (!m) throw new Error(t().admin.schemaErrors.tableNotFound(exportName));
  const paren = m.index + m[0].length - 1;
  const parenClose = matchBracket(masked, paren);
  if (parenClose === -1) throw new Error(t().admin.schemaErrors.unbalancedBrackets(exportName));
  const open = masked.indexOf("{", paren);
  if (open === -1 || open > parenClose) throw new Error(t().admin.schemaErrors.columnsObjectNotFound(exportName));
  const close = matchBracket(masked, open);
  if (close === -1) throw new Error(t().admin.schemaErrors.unbalancedBrackets(exportName));
  return { open, close };
}

/** Nama properti dan nama SQL kolom yang sudah ada di objek kolom. */
function existingColumns(source: string, masked: string, body: TableBody): { keys: Set<string>; sql: Set<string> } {
  const keys = new Set<string>();
  const sql = new Set<string>();
  const stack: string[] = [];
  let segStart = body.open + 1;
  const flush = (end: number) => {
    const seg = masked.slice(segStart, end);
    const km = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(seg);
    if (km) {
      keys.add(km[1]!);
      const orig = source.slice(segStart, end);
      const sm = /^\s*[\w$]+\s*:\s*[\w$]+\s*\(\s*(["'`])([^"'`]+)\1/.exec(orig);
      if (sm) sql.add(sm[2]!);
    }
  };
  for (let i = body.open + 1; i < body.close; i++) {
    const c = masked[i]!;
    if (c in PAIRS) stack.push(c);
    else if (c === ")" || c === "]" || c === "}") stack.pop();
    else if (c === "," && stack.length === 0) {
      flush(i);
      segStart = i + 1;
    }
  }
  flush(body.close);
  return { keys, sql };
}

export function addColumn(source: string, exportName: string, column: ColumnSpec): string {
  const masked = maskSource(source);
  const body = findTableBody(masked, exportName);
  const dialect = detectDialect(source);
  const errors = columnErrors(column, tableExports(source), exportName);
  if (errors.length === 0) {
    if (column.name === "id") errors.push(t().admin.schemaErrors.idAutomatic);
    const existing = existingColumns(source, masked, body);
    const sql = sqlName(column);
    if (existing.sql.has(sql) || existing.keys.has(camelCase(sql))) errors.push(t().admin.schemaErrors.columnExists(column.name, exportName));
    if (column.required && !hasDefault(column)) {
      errors.push(t().admin.schemaErrors.requiredNeedsDefault(column.name));
    }
  }
  if (errors.length) throw new Error(`${t().admin.schemaErrors.invalidColumn}:\n- ${errors.join("\n- ")}`);

  const eol = eolOf(source);
  const col = columnCode(column, dialect);

  // Karakter kode terakhir di dalam objek (komentar sudah di-mask jadi spasi).
  let last = body.close - 1;
  while (last > body.open && /\s/.test(masked[last]!)) last--;
  const lastChar = masked[last]!;
  const empty = last === body.open;
  const needComma = !empty && lastChar !== ",";

  const lineStart = source.lastIndexOf("\n", body.close - 1) + 1;
  const closeOwnLine = /^[ \t]*$/.test(source.slice(lineStart, body.close)) && lineStart > body.open;

  let next: string;
  if (closeOwnLine) {
    const closeIndent = source.slice(lineStart, body.close);
    let first = body.open + 1;
    while (first < body.close && /\s/.test(masked[first]!)) first++;
    let indent = `${closeIndent}  `;
    if (!empty && source.slice(body.open, first).includes("\n")) {
      const fs = source.lastIndexOf("\n", first) + 1;
      indent = source.slice(fs, first);
    }
    const trailing = empty || lastChar === ",";
    const insertion = `${indent}${col.code}${trailing ? "," : ""}${eol}`;
    next = source.slice(0, lineStart) + insertion + source.slice(lineStart);
    if (needComma) next = next.slice(0, last + 1) + "," + next.slice(last + 1);
  } else {
    // Objek satu baris: `{ a: x }` -> `{ a: x, b: y }`.
    const insertion = empty ? ` ${col.code} ` : `${needComma ? "," : ""} ${col.code}`;
    next = source.slice(0, last + 1) + insertion + source.slice(last + 1);
  }
  return ensureImports(next, dialect, col.builders);
}
