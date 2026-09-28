import { getTableColumns, getTableName, is, Table, type Column } from "drizzle-orm";
import { getTableConfig as pgTableConfig, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";

/**
 * Membaca bentuk tabel Drizzle (kolom, primary key, relasi, indeks) untuk panel admin,
 * `zusantara make:admin`, dan `zusantara describe`. Mendukung SQLite dan PostgreSQL.
 */

export type AnyTable = Table;

export interface ColumnInfo {
  /** Nama properti di objek tabel Drizzle (mis. createdAt). */
  key: string;
  /** Nama kolom SQL (mis. created_at). */
  name: string;
  /** Tipe data Drizzle: string, number, boolean, date, json, bigint, buffer, array, custom. */
  dataType: string;
  /** Kelas kolom Drizzle, mis. SQLiteText, SQLiteTimestamp, PgVarchar. */
  columnType: string;
  notNull: boolean;
  hasDefault: boolean;
  primary: boolean;
  unique: boolean;
  enumValues?: string[];
  /** Kolom bilangan bulat (integer, serial, bigint). */
  integer: boolean;
  /** Kolom rahasia (password, hash, token, secret, api key): tidak pernah tampil di admin atau manifest. */
  secret: boolean;
  references?: { table: string; column: string };
}

export interface TableInfo {
  /** Nama tabel SQL. */
  name: string;
  dialect: "sqlite" | "postgres";
  columns: ColumnInfo[];
  /** Kunci properti kolom primary key (satu kolom), bila ada. */
  primaryKey?: string;
  /** Kolom (nama SQL) yang menjadi kolom pertama sebuah indeks atau unique: pencarian di sana cepat. */
  indexed: string[];
}

const SECRET_WORDS = new Set(["password", "passwd", "pass", "pwd", "hash", "secret", "token", "salt", "otp", "apikey", "privatekey", "totp", "mfa", "recovery"]);

/** Kata-kata nama kolom: camelCase, snake_case, dan kebab-case, huruf kecil. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Nama kolom yang dianggap rahasia (password, hash, token, secret, api key, salt, OTP). */
export function isSecretColumn(name: string): boolean {
  const w = words(name);
  return w.some((x) => SECRET_WORDS.has(x)) || w.some((x, i) => (x === "api" || x === "private") && w[i + 1] === "key");
}

export function isTable(value: unknown): value is AnyTable {
  return is(value, Table);
}

function tableConfig(table: AnyTable) {
  if (is(table, SQLiteTable)) return { dialect: "sqlite" as const, config: sqliteTableConfig(table) };
  if (is(table, PgTable)) return { dialect: "postgres" as const, config: pgTableConfig(table) };
  throw new Error(`Unsupported table type: ${getTableName(table)}`);
}

/** Nama properti kolom di objek tabel, dari objek kolomnya. */
function keyOf(columns: Record<string, Column>, column: Column): string | undefined {
  return Object.entries(columns).find(([, c]) => c === column)?.[0];
}

export function inspectTable(table: AnyTable): TableInfo {
  const { dialect, config } = tableConfig(table);
  const columns = getTableColumns(table) as Record<string, Column>;
  const refs = new Map<Column, { table: string; column: string }>();
  for (const fk of config.foreignKeys) {
    const ref = fk.reference();
    if (ref.columns.length !== 1) continue;
    refs.set(ref.columns[0]!, { table: getTableName(ref.foreignTable), column: ref.foreignColumns[0]!.name });
  }
  const indexed = new Set<string>();
  for (const idx of config.indexes) {
    const first = (idx.config.columns as unknown[])[0] as { name?: string } | undefined;
    if (first?.name) indexed.add(first.name);
  }
  for (const u of config.uniqueConstraints) if (u.columns[0]) indexed.add(u.columns[0].name);
  const pkCols = Object.values(columns).filter((c) => c.primary);
  for (const pk of config.primaryKeys) if (pk.columns.length === 1) pkCols.push(pk.columns[0]!);
  const infos: ColumnInfo[] = Object.entries(columns).map(([key, c]) => {
    const any = c as Column & { enumValues?: string[]; isUnique?: boolean };
    const enumValues = Array.isArray(any.enumValues) && any.enumValues.length ? [...any.enumValues] : undefined;
    const info: ColumnInfo = {
      key,
      name: c.name,
      dataType: c.dataType,
      columnType: c.columnType,
      notNull: c.notNull,
      hasDefault: c.hasDefault,
      primary: pkCols.includes(c),
      unique: Boolean(any.isUnique),
      enumValues,
      integer: /Integer|Serial|BigInt|SmallInt|Int\b/i.test(c.columnType) && c.dataType === "number",
      secret: isSecretColumn(c.name) || isSecretColumn(key),
    };
    const ref = refs.get(c);
    if (ref) info.references = ref;
    if (info.primary || info.unique) indexed.add(c.name);
    return info;
  });
  const primary = [...new Set(pkCols)];
  return {
    name: getTableName(table),
    dialect,
    columns: infos,
    primaryKey: primary.length === 1 ? keyOf(columns, primary[0]!) : undefined,
    indexed: [...indexed],
  };
}

/** Semua tabel Drizzle yang diekspor sebuah modul schema: nama ekspor -> tabel. */
export function tablesOf(schema: Record<string, unknown>): Map<string, AnyTable> {
  const out = new Map<string, AnyTable>();
  for (const [name, value] of Object.entries(schema)) if (isTable(value)) out.set(name, value);
  return out;
}

/** Objek tabel dari sebuah relasi kolom (foreign key) di tabel Drizzle. */
export function foreignTableOf(table: AnyTable, columnKey: string): { table: AnyTable; column: Column } | undefined {
  const { config } = tableConfig(table);
  const columns = getTableColumns(table) as Record<string, Column>;
  const column = columns[columnKey];
  if (!column) return undefined;
  for (const fk of config.foreignKeys) {
    const ref = fk.reference();
    if (ref.columns.length === 1 && ref.columns[0] === column) return { table: ref.foreignTable, column: ref.foreignColumns[0]! };
  }
  return undefined;
}
