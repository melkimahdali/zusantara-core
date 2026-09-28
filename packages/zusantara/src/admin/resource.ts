import { and, asc, count, desc, eq, getTableColumns, gte, inArray, lt, lte, or, sql, type Column, type SQL } from "drizzle-orm";
import type { ZenContext } from "../core/context.js";
import { t } from "../i18n/index.js";
import { defaultFields, humanLabel, missingRequired, resourceName, titleKeyOf, type AdminField } from "./fields.js";
import { foreignTableOf, inspectTable, type AnyTable, type TableInfo } from "./schema.js";

/**
 * Satu tabel di panel admin: data, field, dan hak aksesnya. Dibuat oleh `zusantara make:admin` di
 * src/app/admin/<tabel>.ts; ubah tampilannya lewat `overrides` dan hak akses lewat `access`.
 */

/** Pengguna yang sedang login (ctx.state.user); role dipakai untuk hak akses. */
export interface AdminUser {
  role?: string | null;
  [key: string]: unknown;
}

/**
 * Siapa yang boleh: daftar role (mis. ["admin", "staff"]), true/false, atau fungsi untuk aturan
 * sendiri. Tanpa pengguna login, semua aksi ditolak.
 */
export type AccessRule = string[] | boolean | ((user: AdminUser, ctx: ZenContext) => boolean);
export type AdminAction = "view" | "create" | "update" | "delete";

export interface ResourceOptions {
  /** Objek tabel Drizzle. */
  table: AnyTable;
  /** Database Drizzle aplikasi (dari src/app/db/index.ts). */
  db: unknown;
  /** Bagian URL: /admin/<name> (default: dari nama tabel). */
  name?: string;
  /** Nama tabel untuk manusia (jamak), mis. "Produk" (default: dari nama tabel). */
  label?: string;
  /** Nama satu data, mis. "Produk" (default: label). */
  singular?: string;
  /** Field panel (default: dibaca dari schema, sama seperti `zusantara make:admin`). */
  fields?: AdminField[];
  /** Kolom judul satu data (mis. name). */
  titleField?: string;
  /** Urutan bawaan daftar, mis. { field: "createdAt", dir: "desc" }. Default: primary key terbaru. */
  defaultSort?: { field: string; dir: "asc" | "desc" };
  /** Jumlah data per halaman (default 20). */
  perPage?: number;
  /** Hak akses per aksi. Default: hanya role "admin". */
  access?: Partial<Record<AdminAction, AccessRule>>;
  /** Ubah field tertentu tanpa menyentuh blok buatan make:admin, mis. { price: { label: "Harga jual" }, notes: { list: false } }. */
  overrides?: Record<string, Partial<AdminField>>;
  /** Tambah data dari panel (false bila ada kolom wajib yang tidak bisa diisi dari formulir). */
  create?: boolean;
  /** Folder simpan unggahan (default public/uploads) untuk field image/file. */
  uploadDir?: string;
  /**
   * Dijalankan sebelum data disimpan; boleh mengubah nilai (mis. mengisi slug) atau menolak dengan
   * `throw new AdminError(pesan, field?)`. Pada ubah langsung di tabel, `values` hanya berisi satu kolom itu.
   */
  beforeSave?: (values: Record<string, unknown>, ctx: ZenContext, existing?: Record<string, unknown>) => void | Promise<void>;
}

/** Kesalahan yang ditampilkan ke pengguna di formulir admin (di bawah `field`, atau di atas formulir). */
export class AdminError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

/** Isi blok bertanda buatan `zusantara make:admin` (bagian ResourceOptions yang dibuat dari schema). */
export type GeneratedResource = Pick<ResourceOptions, "name" | "label" | "singular" | "titleField" | "fields" | "create">;

export interface ListQuery {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  /** Nilai filter: f_<field>, f_<field>_from, f_<field>_to. */
  filters: Record<string, string>;
}

export interface ListResult {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pages: number;
  sort: { field: string; dir: "asc" | "desc" };
  /** Label relasi: field -> (nilai -> label). */
  labels: Map<string, Map<string, string>>;
}

type Db = {
  select: (fields?: unknown) => any;
  insert: (table: AnyTable) => any;
  update: (table: AnyTable) => any;
  delete: (table: AnyTable) => any;
};

const DEFAULT_ACCESS: AccessRule = ["admin"];

export class AdminResource {
  readonly table: AnyTable;
  readonly db: Db;
  readonly name: string;
  readonly label: string;
  readonly singular: string;
  readonly fields: AdminField[];
  readonly info: TableInfo;
  readonly pk: string;
  readonly titleField: string;
  readonly perPage: number;
  readonly options: ResourceOptions;
  private readonly columns: Record<string, Column>;
  private readonly creatable: boolean;

  constructor(options: ResourceOptions) {
    this.options = options;
    this.table = options.table;
    this.db = options.db as Db;
    this.info = inspectTable(options.table);
    this.name = options.name ?? resourceName(this.info.name);
    this.label = options.label ?? humanLabel(this.info.name);
    this.singular = options.singular ?? this.label;
    if (!this.info.primaryKey) throw new Error(`zusantara/admin: tabel ${this.info.name} butuh satu kolom primary key`);
    this.pk = this.info.primaryKey;
    this.columns = getTableColumns(options.table) as Record<string, Column>;
    const overrides = options.overrides ?? {};
    this.fields = (options.fields ?? defaultFields(this.info, this.relatedInfos()))
      .map((f) => ({ ...f, ...overrides[f.name] }))
      // Kolom rahasia tidak pernah tampil, apa pun isi konfigurasinya.
      .filter((f) => this.columns[f.name] && !this.info.columns.find((c) => c.key === f.name)?.secret);
    const title = options.titleField ?? (options.fields ? undefined : titleKeyOf(this.info));
    this.titleField = title && this.columns[title] ? title : this.pk;
    this.perPage = options.perPage ?? 20;
    // Tanpa keputusan eksplisit, tambah data hanya bila semua kolom wajib bisa diisi dari formulir.
    this.creatable = options.create ?? missingRequired(this.info, this.fields).length === 0;
  }

  /** Tabel tujuan setiap kolom relasi, untuk field bawaan (label relasi). */
  private relatedInfos(): Map<string, TableInfo> {
    const out = new Map<string, TableInfo>();
    for (const c of this.info.columns) {
      if (!c.references) continue;
      const target = foreignTableOf(this.table, c.key);
      if (target) out.set(c.references.table, inspectTable(target.table));
    }
    return out;
  }

  field(name: string): AdminField | undefined {
    return this.fields.find((f) => f.name === name);
  }

  column(name: string): Column {
    const c = this.columns[name];
    if (!c) throw new Error(`zusantara/admin: kolom ${name} tidak ada di ${this.info.name}`);
    return c;
  }

  get listFields(): AdminField[] {
    return this.fields.filter((f) => f.list !== false);
  }

  get formFields(): AdminField[] {
    return this.fields.filter((f) => f.form !== false);
  }

  get hasFiles(): boolean {
    return this.formFields.some((f) => f.type === "image" || f.type === "file");
  }

  /** Boleh melakukan aksi ini? Tanpa pengguna login selalu false. */
  can(ctx: ZenContext, action: AdminAction): boolean {
    const user = ctx.state.user as AdminUser | undefined;
    if (!user) return false;
    if (action === "create" && !this.creatable) return false;
    // Aksi yang tidak ditulis hanya untuk role admin (tidak mewarisi `view`, agar hak ubah tidak terbuka tanpa sengaja).
    const rule = this.options.access?.[action] ?? DEFAULT_ACCESS;
    if (typeof rule === "boolean") return rule;
    if (typeof rule === "function") return rule(user, ctx);
    return typeof user.role === "string" && rule.includes(user.role);
  }

  /** Nilai primary key dari URL (angka untuk kolom angka). */
  parseId(raw: string): string | number | undefined {
    const c = this.info.columns.find((x) => x.key === this.pk)!;
    if (c.dataType === "number") {
      const n = Number(raw);
      return Number.isSafeInteger(n) ? n : undefined;
    }
    return raw === "" ? undefined : raw;
  }

  idOf(row: Record<string, unknown>): string {
    return String(row[this.pk]);
  }

  titleOf(row: Record<string, unknown>): string {
    const v = row[this.titleField];
    return v === null || v === undefined || v === "" ? `#${this.idOf(row)}` : String(v);
  }

  private likeOp(column: Column, q: string): SQL {
    // Escape wildcard LIKE agar input seperti "%" dicari apa adanya.
    const pattern = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    return this.info.dialect === "postgres" ? sql`${column}::text ILIKE ${pattern} ESCAPE '\\'` : sql`${column} LIKE ${pattern} ESCAPE '\\'`;
  }

  private where(query: ListQuery): SQL | undefined {
    const conds: SQL[] = [];
    const q = query.q?.trim();
    if (q) {
      const parts = this.fields.filter((f) => f.search).map((f) => this.likeOp(this.column(f.name), q));
      const id = this.parseId(q);
      if (id !== undefined && /^\d+$/.test(q)) parts.push(eq(this.column(this.pk), id));
      if (parts.length) conds.push(or(...parts)!);
    }
    for (const f of this.fields.filter((x) => x.filter)) {
      const col = this.column(f.name);
      const value = query.filters[`f_${f.name}`];
      if (f.type === "boolean" && (value === "1" || value === "0")) conds.push(eq(col, value === "1"));
      else if ((f.type === "enum" || f.type === "relation") && value) conds.push(eq(col, this.coerceKey(col, value)));
      else if (f.type === "date" || f.type === "datetime" || f.type === "number") {
        const from = query.filters[`f_${f.name}_from`];
        const to = query.filters[`f_${f.name}_to`];
        const range = this.range(f, from, to);
        if (range.from !== undefined) conds.push(gte(col, range.from));
        if (range.to !== undefined) conds.push(range.inclusive ? lte(col, range.to) : lt(col, range.to));
      }
    }
    return conds.length ? and(...conds) : undefined;
  }

  /** Batas rentang filter. Tanggal "sampai" mencakup seluruh hari itu. */
  private range(f: AdminField, from?: string, to?: string): { from?: unknown; to?: unknown; inclusive: boolean } {
    if (f.type === "number") {
      const a = from ? Number(from) : undefined;
      const b = to ? Number(to) : undefined;
      return { from: Number.isFinite(a) ? a : undefined, to: Number.isFinite(b) ? b : undefined, inclusive: true };
    }
    const asDate = this.column(f.name).dataType === "date";
    const day = (v: string | undefined, add: number) => {
      if (!v || !/^\d{4}-\d{2}-\d{2}/.test(v)) return undefined;
      const [y, m, d] = v.slice(0, 10).split("-").map(Number) as [number, number, number];
      const date = new Date(y, m - 1, d + add);
      if (Number.isNaN(date.getTime())) return undefined;
      return asDate ? date : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    };
    return { from: day(from, 0), to: day(to, 1), inclusive: false };
  }

  private coerceKey(column: Column, value: string): unknown {
    if (column.dataType === "number") {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    return value;
  }

  sortOf(query: ListQuery): { field: string; dir: "asc" | "desc" } {
    const field = query.sort && this.fields.find((f) => f.name === query.sort && f.sort) ? query.sort : undefined;
    if (field) return { field, dir: query.dir === "desc" ? "desc" : "asc" };
    return this.options.defaultSort ?? { field: this.pk, dir: "desc" };
  }

  async list(query: ListQuery): Promise<ListResult> {
    const where = this.where(query);
    const [{ n }] = (await this.db.select({ n: count() }).from(this.table).where(where)) as [{ n: number }];
    const total = Number(n);
    const pages = Math.max(1, Math.ceil(total / this.perPage));
    const page = Math.min(Math.max(1, Math.floor(query.page ?? 1) || 1), pages);
    const sort = this.sortOf(query);
    const col = this.column(sort.field);
    const order = sort.dir === "desc" ? [desc(col)] : [asc(col)];
    if (sort.field !== this.pk) order.push(desc(this.column(this.pk)));
    const rows = (await this.db
      .select()
      .from(this.table)
      .where(where)
      .orderBy(...order)
      .limit(this.perPage)
      .offset((page - 1) * this.perPage)) as Record<string, unknown>[];
    return { rows, total, page, pages, sort, labels: await this.relationLabels(rows) };
  }

  async count(): Promise<number> {
    const [{ n }] = (await this.db.select({ n: count() }).from(this.table)) as [{ n: number }];
    return Number(n);
  }

  /** Data terbaru untuk dasbor (kolom createdAt bila ada, selain itu primary key terbesar). */
  async recent(limit = 5): Promise<Record<string, unknown>[]> {
    const created = this.columns.createdAt ?? this.columns.created_at;
    const order = created ? [desc(created), desc(this.column(this.pk))] : [desc(this.column(this.pk))];
    return (await this.db.select().from(this.table).orderBy(...order).limit(limit)) as Record<string, unknown>[];
  }

  async find(id: string | number): Promise<Record<string, unknown> | undefined> {
    const rows = (await this.db.select().from(this.table).where(eq(this.column(this.pk), id)).limit(1)) as Record<string, unknown>[];
    return rows[0];
  }

  async insert(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows = (await this.db.insert(this.table).values(values).returning()) as Record<string, unknown>[];
    return rows[0]!;
  }

  async update(id: string | number, values: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (Object.keys(values).length === 0) return this.find(id);
    const rows = (await this.db.update(this.table).set(values).where(eq(this.column(this.pk), id)).returning()) as Record<string, unknown>[];
    return rows[0];
  }

  async remove(id: string | number): Promise<void> {
    await this.db.delete(this.table).where(eq(this.column(this.pk), id));
  }

  /** Tabel tujuan dan kolom label untuk field relasi. */
  relation(fieldName: string): { table: AnyTable; key: Column; label: Column; labelKey: string } | undefined {
    const f = this.field(fieldName);
    const target = foreignTableOf(this.table, fieldName);
    if (!f || !target) return undefined;
    const cols = getTableColumns(target.table) as Record<string, Column>;
    const labelKey = f.relation?.labelKey && cols[f.relation.labelKey] ? f.relation.labelKey : Object.entries(cols).find(([, c]) => c === target.column)![0];
    return { table: target.table, key: target.column, label: cols[labelKey]!, labelKey };
  }

  /** Label relasi untuk baris yang sedang tampil: satu query per field relasi (tanpa N+1). */
  async relationLabels(rows: Record<string, unknown>[]): Promise<Map<string, Map<string, string>>> {
    const out = new Map<string, Map<string, string>>();
    for (const f of this.fields.filter((x) => x.type === "relation")) {
      const rel = this.relation(f.name);
      const ids = [...new Set(rows.map((r) => r[f.name]).filter((v) => v !== null && v !== undefined))];
      const map = new Map<string, string>();
      if (rel && ids.length) {
        const found = (await this.db.select({ k: rel.key, l: rel.label }).from(rel.table).where(inArray(rel.key, ids as never[]))) as { k: unknown; l: unknown }[];
        for (const r of found) map.set(String(r.k), r.l === null || r.l === undefined ? String(r.k) : String(r.l));
      }
      out.set(f.name, map);
    }
    return out;
  }

  /** Pilihan relasi untuk Combobox: pencarian di kolom label (atau id bila angka), paling banyak 20. */
  async relationOptions(fieldName: string, q?: string, selected?: string): Promise<{ options: { value: string; label: string }[]; selected?: { value: string; label: string } }> {
    const rel = this.relation(fieldName);
    if (!rel) return { options: [] };
    const conds: SQL[] = [];
    const term = q?.trim();
    if (term) {
      const pattern = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
      const like = this.info.dialect === "postgres" ? sql`${rel.label}::text ILIKE ${pattern} ESCAPE '\\'` : sql`${rel.label} LIKE ${pattern} ESCAPE '\\'`;
      conds.push(/^\d+$/.test(term) && rel.key.dataType === "number" ? or(like, eq(rel.key, Number(term)))! : like);
    }
    const found = (await this.db
      .select({ k: rel.key, l: rel.label })
      .from(rel.table)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(rel.label))
      .limit(20)) as { k: unknown; l: unknown }[];
    const options = found.map((r) => ({ value: String(r.k), label: r.l === null || r.l === undefined ? String(r.k) : String(r.l) }));
    let chosen: { value: string; label: string } | undefined;
    if (selected && !options.some((o) => o.value === selected)) {
      const row = (await this.db.select({ k: rel.key, l: rel.label }).from(rel.table).where(eq(rel.key, this.coerceKey(rel.key, selected))).limit(1)) as { k: unknown; l: unknown }[];
      if (row[0]) chosen = { value: String(row[0].k), label: String(row[0].l ?? row[0].k) };
    }
    return { options, selected: chosen };
  }

  /** Pesan untuk error database yang bisa dijelaskan ke pengguna (unique, relasi). */
  friendlyError(err: unknown): { field?: string; message: string } | undefined {
    if (err instanceof AdminError) return { field: err.field, message: err.message };
    const m = t().admin.errors;
    const texts: string[] = [];
    let code: string | undefined;
    for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
      const any = e as { message?: string; detail?: string; code?: string; constraint_name?: string };
      if (any.message) texts.push(any.message);
      if (any.detail) texts.push(any.detail);
      if (any.code) code ??= String(any.code);
    }
    const all = texts.join("\n");
    const unique = /UNIQUE constraint failed: [\w"]+\.(\w+)/.exec(all) ?? (code === "23505" ? /Key \(([\w"]+)\)=/.exec(all) : null);
    if (unique) {
      const col = unique[1]!.replace(/"/g, "");
      const info = this.info.columns.find((c) => c.name === col);
      const f = info ? this.field(info.key) : undefined;
      return { field: f?.name, message: m.unique(f?.label ?? col) };
    }
    if (/FOREIGN KEY constraint failed/.test(all) || code === "23503") return { message: m.reference };
    return undefined;
  }
}

/**
 * Daftarkan satu tabel di panel admin. File src/app/admin/<tabel>.ts buatan `zusantara make:admin`
 * memanggil ini dengan field hasil schema; ubah di luar blok bertanda, mis. `overrides` dan `access`.
 */
export function defineResource(options: ResourceOptions): AdminResource {
  return new AdminResource(options);
}
