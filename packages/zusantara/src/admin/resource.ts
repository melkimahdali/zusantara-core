import { and, asc, count, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type Column, type SQL } from "drizzle-orm";
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

/** Relasi many-to-many lewat tabel penghubung, mis. { tags: { through: postTags } }. Kolom penghubung dibaca dari foreign key-nya. */
export interface ManyOption {
  /** Tabel penghubung dengan dua foreign key: ke tabel ini dan ke tabel tujuan. */
  through: AnyTable;
  label?: string;
  /** Kolom label di tabel tujuan (default: name/title/... seperti relasi biasa). */
  labelKey?: string;
  /** Tampil di daftar (default true). */
  list?: boolean;
}

export interface ManyRelation {
  name: string;
  label: string;
  through: AnyTable;
  from: Column;
  to: Column;
  target: AnyTable;
  targetKey: Column;
  labelColumn: Column;
  list: boolean;
}

/** Aturan pindah status (alur kerja dan persetujuan), mis. { from: "review", to: "published", roles: ["editor"] }. */
export interface Transition {
  from: string | string[];
  to: string;
  /** Teks tombol (default: nama status tujuan). */
  label?: string;
  /** Role yang boleh (default: semua yang boleh mengubah data). Pakai ini untuk persetujuan. */
  roles?: string[];
}

export interface WorkflowOptions {
  /** Kolom status (enum). Kolom ini hanya bisa diubah lewat tombol transisi. */
  field: string;
  transitions: Transition[];
}

/**
 * Aksi khusus di halaman data dan aksi massal, mis. "Kirim ulang invoice". Isi `run` untuk kode
 * sendiri, atau `job` untuk memasukkan job ke antrean dengan data { resource, ids }.
 */
export interface CustomAction {
  name: string;
  label: string;
  run?: (rows: Record<string, unknown>[], ctx: ZenContext) => void | string | Promise<void | string>;
  job?: string;
  /** Pertanyaan konfirmasi sebelum dijalankan. */
  confirm?: string;
  /** Role yang boleh (default: yang boleh mengubah data). */
  roles?: string[];
  /** Ada di aksi massal (default true). */
  bulk?: boolean;
}

/** Konten dengan status terbit: draf, terbit, dan terjadwal (terbit dengan waktu di masa depan). */
export interface PublishOptions {
  /** Kolom status (default: kolom enum "status" yang punya nilai published/terbit/live). */
  field?: string;
  /** Nilai untuk terbit dan draf. */
  published?: string;
  draft?: string;
  /** Kolom waktu terbit (default publishedAt / published_at). */
  at?: string;
}

export type AutomationEvent = "create" | "update" | "delete";

/**
 * Otomasi: "bila data dibuat atau berubah, kirim email, panggil webhook, atau jalankan job". Dijalankan
 * setelah data tersimpan; kegagalan dicatat di log dan tidak membatalkan penyimpanan.
 */
export interface Automation {
  on: AutomationEvent | AutomationEvent[];
  /** Syarat tambahan, mis. (row, change) => row.status === "paid" && "status" in change.changes. */
  when?: (row: Record<string, unknown>, change: { event: AutomationEvent; changes: Record<string, [unknown, unknown]> }) => boolean;
  /** Kirim email (teks boleh memakai {kolom}, mis. "Pesanan {id} dibayar"). */
  email?: { to: string; subject: string; text: string };
  /** POST JSON { event, resource, id, row, changes } ke URL ini. */
  webhook?: string;
  /** Masukkan job ke antrean dengan data { event, resource, id, row, changes }. */
  job?: string;
  run?: (row: Record<string, unknown>, ctx: ZenContext | undefined, change: { event: AutomationEvent; changes: Record<string, [unknown, unknown]> }) => unknown;
}

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
  /** Relasi many-to-many, mis. { tags: { through: postTags } }: pilihan ganda di formulir. */
  many?: Record<string, ManyOption>;
  /** Hapus lunak: kolom waktu hapus (default deletedAt / deleted_at bila ada), atau false untuk hapus permanen. */
  softDelete?: string | false;
  /** Catat perubahan di log audit dan riwayat revisi (default true). */
  audit?: boolean;
  /** Status draf, terbit, dan terjadwal (default: dikenali dari kolom status dan publishedAt), atau false. */
  publish?: PublishOptions | false;
  /** URL pratinjau data di situs, mis. (row) => `/blog/${row.slug}?preview=1`. */
  previewUrl?: (row: Record<string, unknown>) => string;
  /** Status dengan aturan transisi dan persetujuan per role. */
  workflow?: WorkflowOptions;
  /** Aksi khusus per data dan aksi massal. */
  actions?: CustomAction[];
  /** Otomasi setelah data dibuat, diubah, atau dihapus. */
  automations?: Automation[];
  /** Tampilkan data anak (tabel lain yang merujuk tabel ini) di halaman ubah (default true). */
  children?: boolean;
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
  /** Tampilkan data yang dihapus lunak (tempat sampah). */
  trash?: boolean;
  /** Hanya data dengan id ini (aksi massal dan ekspor pilihan). */
  ids?: (string | number)[];
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
  readonly many: ManyRelation[];
  /** Kunci kolom hapus lunak, bila ada. */
  readonly softDeleteKey: string | undefined;
  readonly publishing: { field: string; published: string; draft: string; at?: string } | undefined;
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
    this.softDeleteKey = this.detectSoftDelete();
    this.publishing = this.detectPublishing();
    this.many = Object.entries(options.many ?? {}).map(([name, o]) => this.manyRelation(name, o));
    this.enhanceFields(overrides);
    this.perPage = options.perPage ?? 20;
    // Tanpa keputusan eksplisit, tambah data hanya bila semua kolom wajib bisa diisi dari formulir.
    this.creatable = options.create ?? missingRequired(this.info, this.fields).length === 0;
  }

  private detectSoftDelete(): string | undefined {
    if (this.options.softDelete === false) return undefined;
    const key = this.options.softDelete ?? this.info.columns.find((c) => /^deleted(At|_at)$/.test(c.key) || c.name === "deleted_at")?.key;
    if (!key || !this.columns[key]) return undefined;
    if (this.columns[key]!.notNull) return undefined;
    return key;
  }

  private detectPublishing(): AdminResource["publishing"] {
    if (this.options.publish === false) return undefined;
    const o = this.options.publish ?? {};
    const status = o.field ?? this.info.columns.find((c) => /^(status|state)$/i.test(c.key) && c.enumValues)?.key;
    const values = status ? (this.info.columns.find((c) => c.key === status)?.enumValues ?? this.field(status)?.options) : undefined;
    if (!status || !values) return undefined;
    const published = o.published ?? values.find((v) => /^(published|publish|terbit|live)$/i.test(v));
    if (!published) return undefined;
    const draft = o.draft ?? values.find((v) => /^(draft|draf)$/i.test(v)) ?? values.find((v) => v !== published)!;
    const at = o.at ?? this.info.columns.find((c) => /^published(At|_at)$/.test(c.key) || c.name === "published_at")?.key;
    return { field: status, published, draft, at: at && this.columns[at] ? at : undefined };
  }

  /** Penyesuaian otomatis: hapus lunak, slug, grup SEO, pasangan dua bahasa, dan kolom alur kerja. */
  private enhanceFields(overrides: Record<string, Partial<AdminField>>): void {
    const has = (name: string, key: keyof AdminField) => overrides[name] && key in overrides[name]!;
    for (const f of this.fields) {
      if (f.name === this.softDeleteKey) {
        f.form = false;
        f.list = false;
        f.filter = false;
        continue;
      }
      if (/^slug$/i.test(f.name) && f.type === "text" && f.slugFrom === undefined && this.titleField !== f.name && this.titleField !== this.pk) {
        f.slugFrom = this.titleField;
        if (!has(f.name, "required")) f.required = false;
        f.hint ??= t().admin.slugHint;
      }
      if (f.group === undefined && /^(meta|seo|og)(_|[A-Z])/.test(f.name)) {
        f.group = "seo";
        const max = /description/i.test(f.name) ? 160 : /title/i.test(f.name) ? 60 : undefined;
        if (max && !f.hint) f.hint = t().admin.seoLength(max);
      }
      const base = /^(.+?)(En|_en)$/.exec(f.name)?.[1];
      if (base && f.translationOf === undefined) {
        const source = this.fields.find((x) => x.name === base);
        if (source) {
          f.translationOf = base;
          if (!has(f.name, "label")) f.label = `${source.label} (English)`;
          if (!has(f.name, "list")) f.list = false;
        }
      }
    }
    const wf = this.options.workflow;
    const wfField = wf ? this.field(wf.field) : undefined;
    if (wfField) {
      wfField.inline = false;
      // Status baru mulai dari nilai bawaan kolom; sesudahnya hanya berubah lewat tombol transisi.
      wfField.form = false;
    }
  }

  private manyRelation(name: string, o: ManyOption): ManyRelation {
    const cols = getTableColumns(o.through) as Record<string, Column>;
    let from: Column | undefined;
    let to: { column: Column; target: AnyTable; targetKey: Column } | undefined;
    for (const [key, column] of Object.entries(cols)) {
      const ref = foreignTableOf(o.through, key);
      if (!ref) continue;
      if (ref.table === this.table && !from) from = column;
      else if (!to) to = { column, target: ref.table, targetKey: ref.column };
    }
    if (!from || !to) throw new Error(`zusantara/admin: ${name}: tabel penghubung butuh foreign key ke ${this.info.name} dan ke tabel tujuan`);
    const targetInfo = inspectTable(to.target);
    const targetCols = getTableColumns(to.target) as Record<string, Column>;
    const labelKey = o.labelKey && targetCols[o.labelKey] ? o.labelKey : titleKeyOf(targetInfo);
    return { name, label: o.label ?? humanLabel(name), through: o.through, from, to: to.column, target: to.target, targetKey: to.targetKey, labelColumn: targetCols[labelKey] ?? to.targetKey, list: o.list !== false };
  }

  /** Nilai "sekarang" untuk kolom waktu (Date, angka milidetik, atau teks ISO sesuai tipe kolom). */
  nowFor(key: string): unknown {
    const c = this.column(key);
    if (c.dataType === "date") return new Date();
    if (c.dataType === "number") return Date.now();
    return new Date().toISOString();
  }

  /** Status terbit satu data: draft, scheduled (terbit dengan waktu di masa depan), atau published. */
  publishState(row: Record<string, unknown>): "draft" | "scheduled" | "published" | undefined {
    const p = this.publishing;
    if (!p) return undefined;
    if (row[p.field] !== p.published) return row[p.field] === p.draft ? "draft" : undefined;
    const at = p.at ? row[p.at] : undefined;
    if (at !== null && at !== undefined && at !== "") {
      const time = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(String(at));
      if (Number.isFinite(time) && time > Date.now()) return "scheduled";
    }
    return "published";
  }

  /** Transisi status yang boleh dipakai pengguna ini untuk data ini. */
  transitionsFor(ctx: ZenContext, row: Record<string, unknown>): Transition[] {
    const wf = this.options.workflow;
    if (!wf || !this.can(ctx, "update")) return [];
    const role = (ctx.state.user as AdminUser | undefined)?.role;
    const current = String(row[wf.field] ?? "");
    return wf.transitions.filter((tr) => {
      const from = Array.isArray(tr.from) ? tr.from : [tr.from];
      if (!from.includes(current) && !from.includes("*")) return false;
      if (tr.to === current) return false;
      return !tr.roles || (typeof role === "string" && tr.roles.includes(role));
    });
  }

  /** Aksi khusus yang boleh dipakai pengguna ini. */
  actionsFor(ctx: ZenContext, bulk = false): CustomAction[] {
    if (!this.can(ctx, "update")) return [];
    const role = (ctx.state.user as AdminUser | undefined)?.role;
    return (this.options.actions ?? []).filter((a) => (!bulk || a.bulk !== false) && (!a.roles || (typeof role === "string" && a.roles.includes(role))));
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

  /** Syarat hapus lunak: data aktif saja, atau isi tempat sampah saja. */
  private alive(trash = false): SQL | undefined {
    if (!this.softDeleteKey) return undefined;
    const col = this.column(this.softDeleteKey);
    return trash ? isNotNull(col) : isNull(col);
  }

  private where(query: ListQuery): SQL | undefined {
    const conds: SQL[] = [];
    const alive = this.alive(query.trash);
    if (alive) conds.push(alive);
    if (query.ids) conds.push(query.ids.length ? inArray(this.column(this.pk), query.ids as never[]) : sql`1 = 0`);
    const q = query.q?.trim();
    if (q) {
      const parts = this.fields.filter((f) => f.search).map((f) => this.likeOp(this.column(f.name), q));
      const id = this.parseId(q);
      if (id !== undefined && /^\d+$/.test(q)) parts.push(eq(this.column(this.pk), id));
      if (parts.length) conds.push(or(...parts)!);
    }
    // Filter relasi selalu dibaca dari URL (mis. tautan "lihat semua" data anak), walau tanpa filter: true.
    for (const f of this.fields.filter((x) => x.filter || ["relation", "number", "date", "datetime"].includes(x.type))) {
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

  async count(trash = false): Promise<number> {
    const [{ n }] = (await this.db.select({ n: count() }).from(this.table).where(this.alive(trash))) as [{ n: number }];
    return Number(n);
  }

  /** Semua data yang cocok dengan query (untuk ekspor dan aksi massal), paling banyak `limit`. */
  async all(query: ListQuery, limit = 50_000): Promise<Record<string, unknown>[]> {
    const sort = this.sortOf(query);
    const col = this.column(sort.field);
    return (await this.db
      .select()
      .from(this.table)
      .where(this.where(query))
      .orderBy(sort.dir === "desc" ? desc(col) : asc(col))
      .limit(limit)) as Record<string, unknown>[];
  }

  /** Data terbaru untuk dasbor (kolom createdAt bila ada, selain itu primary key terbesar). */
  async recent(limit = 5): Promise<Record<string, unknown>[]> {
    const created = this.columns.createdAt ?? this.columns.created_at;
    const order = created ? [desc(created), desc(this.column(this.pk))] : [desc(this.column(this.pk))];
    return (await this.db.select().from(this.table).where(this.alive()).orderBy(...order).limit(limit)) as Record<string, unknown>[];
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

  /** Hapus: lunak (isi kolom waktu hapus) bila tabel punya kolomnya, selain itu permanen. */
  async remove(id: string | number): Promise<"soft" | "hard"> {
    if (this.softDeleteKey && !this.isDeleted((await this.find(id)) ?? {})) {
      await this.db.update(this.table).set({ [this.softDeleteKey]: this.nowFor(this.softDeleteKey) }).where(eq(this.column(this.pk), id));
      return "soft";
    }
    await this.destroy(id);
    return "hard";
  }

  /** Hapus permanen. */
  async destroy(id: string | number): Promise<void> {
    await this.db.delete(this.table).where(eq(this.column(this.pk), id));
  }

  /** Kembalikan data yang dihapus lunak. */
  async restore(id: string | number): Promise<void> {
    if (!this.softDeleteKey) return;
    await this.db.update(this.table).set({ [this.softDeleteKey]: null }).where(eq(this.column(this.pk), id));
  }

  isDeleted(row: Record<string, unknown>): boolean {
    const v = this.softDeleteKey ? row[this.softDeleteKey] : undefined;
    return v !== null && v !== undefined && v !== "";
  }

  /**
   * Nilai kolom dari salinan JSON (log audit): tanggal dikembalikan menjadi Date, kolom yang tidak ada
   * dilewati. `withKey` ikut menyertakan primary key (untuk memulihkan data yang dihapus permanen).
   */
  fromSnapshot(snapshot: Record<string, unknown>, withKey = false): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(snapshot)) {
      const c = this.columns[k];
      if (!c || (k === this.pk && !withKey)) continue;
      if (c.dataType === "date" && typeof v === "string") out[k] = new Date(v);
      else if (c.dataType === "bigint" && typeof v === "string") out[k] = BigInt(v);
      else out[k] = v;
    }
    return out;
  }

  /** Salinan data untuk log: tanpa kolom rahasia, kecuali `full` (untuk memulihkan data yang dihapus). */
  snapshotOf(row: Record<string, unknown>, full = false): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of this.info.columns) if (full || !c.secret) out[c.key] = row[c.key];
    return out;
  }

  /** Kolom yang berubah (tanpa kolom rahasia): nama -> [sebelum, sesudah]. */
  diff(before: Record<string, unknown> | undefined, after: Record<string, unknown>): Record<string, [unknown, unknown]> {
    const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : JSON.stringify(v ?? null));
    const out: Record<string, [unknown, unknown]> = {};
    for (const c of this.info.columns) {
      if (c.secret || !(c.key in after)) continue;
      const a = before?.[c.key];
      const b = after[c.key];
      if (norm(a) !== norm(b)) out[c.key] = [a ?? null, b ?? null];
    }
    return out;
  }

  /** Slug unik dari teks (mis. judul): "Kopi Susu" -> "kopi-susu", lalu "kopi-susu-2" bila sudah dipakai. */
  async uniqueSlug(field: string, text: string, exceptId?: string | number): Promise<string> {
    const base =
      text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "data";
    const col = this.column(field);
    const pattern = `${base.replace(/[%_\\]/g, "\\$&")}%`;
    const conds: SQL[] = [sql`${col} LIKE ${pattern} ESCAPE '\\'`];
    if (exceptId !== undefined) conds.push(ne(this.column(this.pk), exceptId));
    const taken = new Set(((await this.db.select({ s: col }).from(this.table).where(and(...conds))) as { s: unknown }[]).map((r) => String(r.s)));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  // ── Many-to-many ───────────────────────────────────────────────────────────

  manyOf(name: string): ManyRelation | undefined {
    return this.many.find((x) => x.name === name);
  }

  /** Id tujuan yang terpilih untuk satu data. */
  async manyValues(name: string, id: string | number): Promise<string[]> {
    const rel = this.manyOf(name)!;
    const rows = (await this.db.select({ v: rel.to }).from(rel.through).where(eq(rel.from, id))) as { v: unknown }[];
    return rows.map((r) => String(r.v));
  }

  /** Label tujuan per data untuk daftar: nama relasi -> (id data -> label). Satu query per relasi. */
  async manyLabels(rows: Record<string, unknown>[]): Promise<Map<string, Map<string, string[]>>> {
    const out = new Map<string, Map<string, string[]>>();
    const ids = rows.map((r) => r[this.pk]).filter((v) => v !== null && v !== undefined);
    for (const rel of this.many.filter((x) => x.list)) {
      const map = new Map<string, string[]>();
      if (ids.length) {
        const found = (await this.db
          .select({ f: rel.from, l: rel.labelColumn })
          .from(rel.through)
          .innerJoin(rel.target, eq(rel.to, rel.targetKey))
          .where(inArray(rel.from, ids as never[]))
          .orderBy(asc(rel.labelColumn))) as { f: unknown; l: unknown }[];
        for (const r of found) {
          const k = String(r.f);
          map.set(k, [...(map.get(k) ?? []), String(r.l ?? "")]);
        }
      }
      out.set(rel.name, map);
    }
    return out;
  }

  /** Pilihan tujuan untuk formulir (paling banyak 500, urut label). */
  async manyOptions(name: string): Promise<{ value: string; label: string }[]> {
    const rel = this.manyOf(name)!;
    const rows = (await this.db.select({ k: rel.targetKey, l: rel.labelColumn }).from(rel.target).orderBy(asc(rel.labelColumn)).limit(500)) as { k: unknown; l: unknown }[];
    return rows.map((r) => ({ value: String(r.k), label: String(r.l ?? r.k) }));
  }

  /** Ganti pilihan many-to-many satu data. */
  async setMany(name: string, id: string | number, values: string[]): Promise<void> {
    const rel = this.manyOf(name)!;
    await this.db.delete(rel.through).where(eq(rel.from, id));
    const unique = [...new Set(values.filter((v) => v !== ""))];
    if (!unique.length) return;
    const fromKey = Object.entries(getTableColumns(rel.through) as Record<string, Column>).find(([, c]) => c === rel.from)![0];
    const toKey = Object.entries(getTableColumns(rel.through) as Record<string, Column>).find(([, c]) => c === rel.to)![0];
    await this.db.insert(rel.through).values(unique.map((v) => ({ [fromKey]: id, [toKey]: this.coerceKey(rel.to, v) })));
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
