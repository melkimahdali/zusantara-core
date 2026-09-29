import { inArray, type Column } from "drizzle-orm";
import { getLocale, t } from "../i18n/index.js";
import { parseCsv, toCsv } from "./csv.js";
import type { AdminField } from "./fields.js";
import { parseField } from "./form.js";
import { parseAmount } from "./nlfilter.js";
import type { AdminResource } from "./resource.js";
import { readXlsx } from "./xlsx.js";

/**
 * Ekspor dan impor data admin: CSV (pemisah `,` atau `;`) dan Excel (.xlsx). Impor selalu lewat
 * pratinjau dulu: kolom file dicocokkan dengan field, setiap baris diperiksa dengan aturan yang sama
 * dengan formulir, dan tidak ada yang disimpan sebelum pengguna menyetujui.
 */

export const IMPORT_MAX_ROWS = 5000;

export interface ImportRow {
  /** Nomor baris di file (baris 1 = judul kolom). */
  line: number;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  /** Id data yang diperbarui (kolom id terisi dan datanya ada), selain itu data baru. */
  id?: string | number;
}

/** Baca file unggahan CSV atau Excel menjadi baris-baris sel (baris pertama = judul kolom). */
export async function readTable(file: File): Promise<string[][]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip || /\.xlsx$/i.test(file.name)) return readXlsx(bytes).rows;
  return parseCsv(new TextDecoder("utf-8").decode(bytes));
}

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Field yang bisa diimpor: primary key (untuk memperbarui) dan field formulir yang bisa diubah. */
export function importFields(r: AdminResource): AdminField[] {
  const pk = r.fields.find((f) => f.name === r.pk) ?? { name: r.pk, label: "ID", type: "number" as const };
  return [pk, ...r.formFields.filter((f) => !f.readonly && f.name !== r.pk)];
}

/** Cocokkan judul kolom file dengan field (nama kolom atau label, tanpa beda huruf besar dan spasi). */
export function autoMap(headers: string[], fields: AdminField[]): Record<string, number> {
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const f of fields) {
    const keys = new Set([norm(f.name), norm(f.label), norm(f.name.replace(/Id$|_id$/, ""))]);
    const i = headers.findIndex((h, idx) => !used.has(idx) && keys.has(norm(h)));
    if (i >= 0) {
      out[f.name] = i;
      used.add(i);
    }
  }
  return out;
}

/** "28/09/2026" dan "28-09-2026 10:30" -> ISO; nilai lain dikembalikan apa adanya. */
function isoDate(raw: string): string {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(raw);
  if (!m) return raw.replace(" ", "T").slice(0, 16);
  const pad = (v: string) => v.padStart(2, "0");
  return `${m[3]}-${pad(m[2]!)}-${pad(m[1]!)}${m[4] ? `T${pad(m[4])}:${m[5]}` : ""}`;
}

/** Teks sel -> teks yang dimengerti parseField (angka Rupiah, Ya/Tidak, tanggal lokal). */
function cellText(f: AdminField, raw: string): string {
  const v = raw.trim();
  if (f.type === "boolean") return /^(1|ya|yes|y|true|benar|aktif|active)$/i.test(v) ? "1" : "0";
  if (f.type === "number" && v !== "") {
    const n = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : parseAmount(v, getLocale());
    return n === undefined ? v : String(n);
  }
  if ((f.type === "date" || f.type === "datetime") && v !== "") return isoDate(v);
  return raw;
}

/**
 * Periksa setiap baris dengan aturan formulir. Kolom relasi boleh berisi id atau label data tujuan
 * (mis. nama kategori); kolom id yang terisi berarti memperbarui data yang sudah ada.
 */
export async function prepareImport(r: AdminResource, table: string[][], mapping: Record<string, number>): Promise<ImportRow[]> {
  const m = t().admin;
  const fields = importFields(r).filter((f) => mapping[f.name] !== undefined && mapping[f.name]! >= 0);
  const body = table.slice(1).map((cells, i) => ({ cells, line: i + 2 })).filter((x) => x.cells.some((c) => c.trim() !== ""));

  // Label relasi -> id, satu query per field relasi.
  const relationIds = new Map<string, Map<string, string>>();
  for (const f of fields.filter((x) => x.type === "relation")) {
    const rel = r.relation(f.name);
    const labels = [...new Set(body.map((x) => (x.cells[mapping[f.name]!] ?? "").trim()).filter((v) => v !== ""))];
    const map = new Map<string, string>();
    if (rel && labels.length) {
      const found = (await r.db.select({ k: rel.key, l: rel.label }).from(rel.table).where(inArray(rel.label as Column, labels))) as { k: unknown; l: unknown }[];
      for (const row of found) map.set(norm(String(row.l)), String(row.k));
    }
    relationIds.set(f.name, map);
  }

  const pkField = fields.find((f) => f.name === r.pk);
  const ids = pkField ? body.map((x) => r.parseId((x.cells[mapping[r.pk]!] ?? "").trim())).filter((v): v is string | number => v !== undefined) : [];
  const existing = new Map<string, Record<string, unknown>>();
  if (ids.length) for (const row of await r.all({ filters: {}, ids, trash: undefined })) existing.set(r.idOf(row), row);

  const out: ImportRow[] = [];
  for (const { cells, line } of body) {
    const row: ImportRow = { line, values: {}, errors: {} };
    const idRaw = pkField ? (cells[mapping[r.pk]!] ?? "").trim() : "";
    const current = idRaw ? existing.get(String(r.parseId(idRaw))) : undefined;
    if (current) row.id = r.parseId(idRaw);
    for (const f of fields) {
      if (f.name === r.pk) continue;
      let raw = cellText(f, cells[mapping[f.name]!] ?? "");
      if (f.type === "relation" && raw.trim() !== "" && !/^\d+$/.test(raw.trim())) {
        const id = relationIds.get(f.name)?.get(norm(raw));
        if (id === undefined) {
          row.errors[f.name] = m.errors.reference;
          continue;
        }
        raw = id;
      }
      if (f.type === "image" || f.type === "file") {
        if (raw.trim()) row.values[f.name] = raw.trim();
        continue;
      }
      if (f.slugFrom && raw.trim() === "") continue;
      const parsed = await parseField(r, f, raw, current);
      if (parsed.error) row.errors[f.name] = parsed.error;
      else if (parsed.value !== undefined) row.values[f.name] = parsed.value;
    }
    // Data baru: kolom wajib yang tidak ada di file tetap harus terisi.
    if (!current) {
      for (const f of importFields(r)) {
        if (f.name === r.pk || f.slugFrom || mapping[f.name] !== undefined) continue;
        const c = r.column(f.name);
        if ((f.required || (c.notNull && !c.hasDefault)) && f.type !== "boolean") row.errors[f.name] = m.errors.required;
      }
    }
    out.push(row);
  }
  return out;
}

/** Teks satu nilai untuk CSV ekspor (tanggal lokal ISO, boolean Ya/Tidak, relasi berupa id). */
function exportValue(f: AdminField, v: unknown): unknown {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const d = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    return f.type === "date" ? d : `${d} ${pad(v.getHours())}:${pad(v.getMinutes())}`;
  }
  if (f.type === "boolean") return v ? t().admin.yes : t().admin.no;
  if (f.type === "json") return JSON.stringify(v);
  return v;
}

/** CSV semua field (tanpa kolom rahasia), dengan judul kolom berupa label field. */
export function exportCsv(r: AdminResource, rows: Record<string, unknown>[]): string {
  const fields = r.fields.some((f) => f.name === r.pk) ? r.fields : [{ name: r.pk, label: "ID", type: "number" as const }, ...r.fields];
  return toCsv([fields.map((f) => f.label), ...rows.map((row) => fields.map((f) => exportValue(f, row[f.name])))], { bom: true });
}

/** Nama file ekspor, mis. produk-2026-09-29.csv. */
export function exportName(r: AdminResource): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${r.name}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
}
