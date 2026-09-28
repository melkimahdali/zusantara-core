import { t, type Locale } from "../i18n/index.js";
import type { ColumnInfo, TableInfo } from "./schema.js";

/**
 * Field panel admin: satu kolom tabel dengan cara menampilkan, mencari, memfilter, dan mengisinya.
 * `make:admin` menuliskannya dari schema; Anda bisa mengubah per field lewat opsi `overrides`.
 */
export type FieldType =
  | "text"
  | "textarea"
  | "email"
  | "url"
  | "number"
  | "boolean"
  | "enum"
  | "date"
  | "datetime"
  | "json"
  | "image"
  | "file"
  | "relation";

export interface AdminField {
  /** Nama properti kolom di tabel Drizzle (mis. createdAt). */
  name: string;
  label: string;
  type: FieldType;
  /** Wajib diisi di formulir. */
  required?: boolean;
  /** Pilihan untuk type "enum". */
  options?: string[];
  /** Untuk type "relation": properti kolom tabel tujuan yang dipakai sebagai label (mis. name). */
  relation?: { labelKey: string };
  /** Tampil di daftar (default true). */
  list?: boolean;
  /** Ada di formulir tambah dan ubah (default true). */
  form?: boolean;
  /** Ikut dicari oleh kotak cari daftar. */
  search?: boolean;
  /** Punya filter di daftar (enum, boolean, relation: pilihan; date, datetime, number: rentang). */
  filter?: boolean;
  /** Kolom daftar bisa diurutkan. */
  sort?: boolean;
  /** Bisa diubah langsung di daftar (boolean dan enum). */
  inline?: boolean;
  /** Tampil di formulir tapi tidak bisa diubah. */
  readonly?: boolean;
  /** Petunjuk di bawah field formulir. */
  hint?: string;
  /** Untuk image/file: tipe MIME yang diterima (default image/* untuk image). */
  types?: string[];
  /** Untuk image/file: batas ukuran, mis. "5mb" (default 5mb). */
  maxBytes?: string;
}

const LONG_TEXT = new Set(["body", "content", "description", "summary", "bio", "notes", "note", "message", "text", "details", "excerpt", "about", "isi", "deskripsi", "keterangan", "catatan", "pesan", "alamat", "address"]);
const IMAGE = new Set(["image", "photo", "picture", "avatar", "logo", "cover", "thumbnail", "banner", "icon", "gambar", "foto", "sampul"]);
const FILE = new Set(["file", "attachment", "document", "pdf", "lampiran", "dokumen", "berkas"]);
const LABEL_KEYS = ["name", "title", "label", "fullName", "full_name", "username", "email", "slug", "nama", "judul", "code", "kode"];

function lastWord(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // "photoUrl" dan "image_path" tetap dianggap gambar: kata terakhir url/path dilewati.
  const last = parts.at(-1);
  if ((last === "url" || last === "path" || last === "src") && parts.length > 1) return parts.at(-2)!;
  return last ?? name;
}

/** "createdAt" / "created_at" -> "Created at"; label umum diambil dari kamus bahasa aktif. */
export function humanLabel(name: string, locale?: Locale): string {
  const key = name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const known = t(locale).admin.labels[key];
  if (known) return known;
  const text = name
    .replace(/Id$/, "")
    .replace(/_id$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return text ? text[0]!.toUpperCase() + text.slice(1) : name;
}

function typeOf(c: ColumnInfo): FieldType {
  if (c.references) return "relation";
  if (c.enumValues) return "enum";
  if (c.dataType === "boolean") return "boolean";
  if (c.dataType === "date") return /date$/i.test(c.columnType) && !/time/i.test(c.columnType) ? "date" : "datetime";
  if (/Date(String)?$/.test(c.columnType)) return "date";
  if (/Timestamp|DateTime/i.test(c.columnType)) return "datetime";
  if (c.dataType === "json") return "json";
  if (c.dataType === "number" || c.dataType === "bigint") return "number";
  const word = lastWord(c.key);
  if (IMAGE.has(word)) return "image";
  if (FILE.has(word)) return "file";
  if (word === "email") return "email";
  if (word === "url" || word === "website" || word === "link") return "url";
  if (LONG_TEXT.has(word)) return "textarea";
  return "text";
}

/** Kolom yang diisi otomatis oleh aplikasi (waktu dibuat/diubah): tidak ada di formulir. */
function isAutoColumn(c: ColumnInfo): boolean {
  return /^(created|updated|deleted)(At|_at|On|_on)?$/i.test(c.key) && c.hasDefault;
}

/** Label tabel tujuan relasi: kolom nama/judul/email pertama yang ada, selain itu primary key. */
export function labelKeyOf(info: TableInfo): string {
  const keys = info.columns.filter((c) => !c.secret).map((c) => c.key);
  return LABEL_KEYS.find((k) => keys.includes(k)) ?? info.columns.find((c) => c.dataType === "string" && !c.secret && !c.primary && !c.enumValues)?.key ?? info.primaryKey ?? keys[0]!;
}

/**
 * Field admin bawaan dari bentuk tabel. `related` memberi bentuk tabel tujuan relasi (nama tabel SQL ->
 * info) untuk memilih kolom labelnya.
 */
export function defaultFields(info: TableInfo, related: Map<string, TableInfo> = new Map(), locale?: Locale): AdminField[] {
  const fields: AdminField[] = [];
  for (const c of info.columns) {
    if (c.secret) continue;
    const type = typeOf(c);
    const field: AdminField = { name: c.key, label: humanLabel(c.key, locale), type };
    const auto = isAutoColumn(c);
    if (c.primary) {
      field.form = false;
      field.sort = true;
    } else if (auto) {
      field.form = false;
      field.sort = true;
    } else {
      if (c.notNull && !c.hasDefault && type !== "boolean") field.required = true;
      if (type === "enum") field.options = c.enumValues;
      if (type === "relation" && c.references) {
        const target = related.get(c.references.table);
        field.relation = { labelKey: target ? labelKeyOf(target) : c.references.column };
      }
    }
    if (type === "text" || type === "email" || type === "url") field.search = true;
    // Filter untuk pilihan dan tanggal; dari kolom waktu otomatis hanya "dibuat" (updatedAt jarang dicari).
    if (["enum", "boolean", "relation"].includes(type) || ((type === "date" || type === "datetime") && (!auto || /^created/i.test(c.key)))) field.filter = true;
    if (type !== "textarea" && type !== "json" && type !== "image" && type !== "file" && !c.primary) field.sort = true;
    if (type === "textarea" || type === "json") field.list = false;
    if ((type === "boolean" || type === "enum") && !c.primary) field.inline = true;
    fields.push(field);
  }
  // Daftar ringkas: paling banyak 6 kolom yang tampil, sesuai urutan kolom di schema.
  let shown = 0;
  for (const f of fields) {
    if (f.list === false) continue;
    if (shown >= 6) f.list = false;
    else shown++;
  }
  return fields;
}

/** Kolom judul satu data (untuk judul halaman ubah dan daftar terbaru di dasbor). */
export function titleKeyOf(info: TableInfo): string {
  return labelKeyOf(info);
}

/** Kolom wajib yang tidak bisa diisi dari formulir admin (mis. hash password): tambah data dimatikan. */
export function missingRequired(info: TableInfo, fields: AdminField[]): string[] {
  const inForm = new Set(fields.filter((f) => f.form !== false).map((f) => f.name));
  return info.columns.filter((c) => c.notNull && !c.hasDefault && !c.primary && !inForm.has(c.key)).map((c) => c.name);
}

/** Nama tabel SQL -> bagian URL dan nama file (products, order-items). */
export function resourceName(table: string): string {
  return table
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}
