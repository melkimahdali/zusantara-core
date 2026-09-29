/**
 * CSV untuk impor/ekspor admin (RFC 4180). Pemisah dideteksi otomatis karena Excel berbahasa
 * Indonesia biasanya menyimpan dengan `;`, bukan `,`.
 */

const DELIMITERS = [",", ";", "\t"] as const;

/** Tebak pemisah dari baris pertama (di luar tanda kutip). Bawaan `,`. */
function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ",";
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/** Baca teks CSV menjadi baris-baris sel. Baris kosong di akhir dibuang. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      endRow();
      if (text[i + 1] === "\n") i++;
    } else if (ch === "\n") endRow();
    else field += ch;
    i++;
  }
  if (field !== "" || row.length > 0 || quoted) endRow();
  while (rows.length && rows[rows.length - 1]!.every((c) => c === "")) rows.pop();
  return rows;
}

export interface CsvOptions {
  /** Pemisah kolom. Bawaan `,`. */
  delimiter?: string;
  /** Awali dengan BOM UTF-8 agar Excel membaca huruf non-ASCII dengan benar. Bawaan `true`. */
  bom?: boolean;
}

const NEGATIVE_NUMBER = /^-(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][-+]?\d+)?$/;

/** Nilai sel menjadi teks; string yang bisa dibaca sebagai rumus diberi awalan `'`. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "string") {
    return /^[=+\-@\t\r]/.test(value) && !NEGATIVE_NUMBER.test(value) ? `'${value}` : value;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Tulis baris-baris menjadi CSV (akhir baris CRLF). */
export function toCsv(rows: unknown[][], options: CsvOptions = {}): string {
  const delim = options.delimiter ?? ",";
  const quote = (s: string) =>
    s.includes(delim) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const body = rows.map((r) => r.map((v) => quote(cellText(v))).join(delim)).join("\r\n");
  return (options.bom ?? true ? "﻿" : "") + (rows.length ? body + "\r\n" : "");
}
