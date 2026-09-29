import { saveUpload } from "../backend/upload.js";
import { HttpError } from "../core/errors.js";
import { t } from "../i18n/index.js";
import type { AdminField } from "./fields.js";
import type { AdminResource } from "./resource.js";

/**
 * Membaca isian formulir admin (semua nilai berupa teks) menjadi nilai kolom yang benar tipenya,
 * dengan pesan error per field yang ramah pengguna.
 */

export interface ParsedForm {
  values: Record<string, unknown>;
  errors: Record<string, string>;
  /** Isian mentah untuk mengisi ulang formulir yang tidak valid. */
  raw: Record<string, string>;
}

type FormEntry = ReturnType<FormData["get"]>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Nilai terakhir sebuah field (Switch mengirim "0" lalu "1" bila dicentang). */
function last(form: FormData, name: string): FormEntry | undefined {
  const all = form.getAll(name);
  return all.length ? all[all.length - 1] : undefined;
}

/** Tanggal dari input date ("2026-09-26") atau datetime-local ("2026-09-26T10:30"), waktu lokal server. */
function parseDate(value: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Satu field dari teks formulir. `undefined` = tidak diubah (mis. file kosong saat mengubah data). */
export async function parseField(
  resource: AdminResource,
  f: AdminField,
  entry: FormEntry | undefined,
  existing: Record<string, unknown> | undefined,
): Promise<{ value?: unknown; error?: string; raw: string }> {
  const m = t().admin.errors;
  const column = resource.column(f.name);
  const nullable = !column.notNull;
  const empty = (raw: string) => (f.required || (!nullable && !column.hasDefault) ? { error: m.required, raw } : { value: nullable ? null : undefined, raw });

  if (f.type === "boolean") {
    const v = typeof entry === "string" ? entry : "";
    return { value: v !== "" && v !== "0" && v !== "false", raw: v };
  }
  if (f.type === "image" || f.type === "file") {
    if (!(entry instanceof File) || entry.size === 0) {
      if (existing && existing[f.name] !== null && existing[f.name] !== undefined && existing[f.name] !== "") return { value: undefined, raw: "" };
      return empty("");
    }
    try {
      const saved = await saveUpload(entry, { dir: resource.options.uploadDir, maxBytes: f.maxBytes ?? "5mb", types: f.types ?? (f.type === "image" ? ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] : undefined) });
      return { value: saved.url ?? saved.path, raw: "" };
    } catch (err) {
      if (err instanceof HttpError) return { error: m.upload(err.message), raw: "" };
      throw err;
    }
  }
  const raw = typeof entry === "string" ? entry.trim() : "";
  // Slug kosong dibuat dari judul saat disimpan.
  if (raw === "" && f.slugFrom) return { value: undefined, raw };
  if (raw === "") return empty(raw);
  switch (f.type) {
    case "number": {
      const n = Number(raw.replace(",", "."));
      if (!Number.isFinite(n)) return { error: m.number, raw };
      if (resource.info.columns.find((c) => c.key === f.name)?.integer && !Number.isInteger(n)) return { error: m.integer, raw };
      return { value: column.dataType === "bigint" ? BigInt(Math.trunc(n)) : n, raw };
    }
    case "enum":
      return f.options && !f.options.includes(raw) ? { error: m.option, raw } : { value: raw, raw };
    case "relation": {
      if (column.dataType === "number") {
        const n = Number(raw);
        return Number.isSafeInteger(n) ? { value: n, raw } : { error: m.reference, raw };
      }
      return { value: raw, raw };
    }
    case "date":
    case "datetime": {
      const d = parseDate(raw);
      if (!d) return { error: m.date, raw };
      if (column.dataType === "date") return { value: d, raw };
      // Kolom teks (mis. date di PostgreSQL mode string): simpan apa adanya dalam format ISO.
      return { value: f.type === "date" ? raw.slice(0, 10) : raw, raw };
    }
    case "json":
      try {
        return { value: JSON.parse(raw), raw };
      } catch {
        return { error: m.json, raw };
      }
    case "email":
      return EMAIL.test(raw) ? { value: raw.toLowerCase(), raw } : { error: m.email, raw };
    case "url":
      return /^https?:\/\/\S+$/i.test(raw) ? { value: raw, raw } : { error: m.url, raw };
    default:
      return { value: typeof entry === "string" && f.type === "textarea" ? entry.replace(/\r\n/g, "\n").trim() : raw, raw };
  }
}

/** Semua field formulir yang bisa diubah. */
export async function parseForm(resource: AdminResource, form: FormData, existing?: Record<string, unknown>): Promise<ParsedForm> {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const raw: Record<string, string> = {};
  for (const f of resource.formFields) {
    if (f.readonly) continue;
    const r = await parseField(resource, f, last(form, f.name), existing);
    raw[f.name] = r.raw;
    if (r.error) errors[f.name] = r.error;
    else if (r.value !== undefined) values[f.name] = r.value;
  }
  return { values, errors, raw };
}

export { last as lastValue };
