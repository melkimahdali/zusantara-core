import { inflateRawSync } from "node:zlib";

/**
 * Pembaca .xlsx minimal untuk impor admin, tanpa dependensi: membuka ZIP, lalu memindai XML
 * lembar kerja pertama dengan regex. Cukup untuk data tabel biasa; rumus dibaca dari hasil
 * terakhir yang tersimpan di file.
 */

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 100_000;
const INVALID = "Bukan file Excel .xlsx yang valid";

export interface XlsxData {
  /** Nama semua lembar kerja, sesuai urutan di workbook. */
  sheets: string[];
  /** Isi lembar kerja pertama; setiap baris sama panjang. */
  rows: string[][];
}

interface ZipEntry {
  method: number;
  compSize: number;
  size: number;
  offset: number;
}

/** Baca direktori pusat ZIP (tanpa mengekstrak isi). */
function readZip(data: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(INVALID);
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("File .xlsx format ZIP64 tidak didukung");
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > data.length || view.getUint32(p, true) !== 0x02014b50) throw new Error(INVALID);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(data.subarray(p + 46, p + 46 + nameLen));
    if (flags & 1) throw new Error("File .xlsx terenkripsi (berkata sandi) tidak didukung");
    if (compSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new Error("File .xlsx format ZIP64 tidak didukung");
    }
    total += size;
    if (total > MAX_BYTES) throw new Error("File .xlsx terlalu besar (maksimal 50 MB setelah diekstrak)");
    entries.set(name, { method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Ekstrak satu entri ZIP sebagai teks UTF-8. `undefined` bila tidak ada. */
function readEntry(data: Uint8Array, entries: Map<string, ZipEntry>, name: string): string | undefined {
  const e = entries.get(name);
  if (!e) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (e.offset + 30 > data.length || view.getUint32(e.offset, true) !== 0x04034b50) throw new Error(INVALID);
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
  const raw = data.subarray(start, start + e.compSize);
  let out: Uint8Array;
  if (e.method === 0) out = raw;
  else if (e.method === 8) {
    try {
      out = inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
    } catch {
      throw new Error(INVALID);
    }
  } else throw new Error(`Metode kompresi ZIP ${e.method} tidak didukung`);
  return new TextDecoder().decode(out);
}

/** Pecah entitas XML dan escape `_xHHHH_` khas OOXML. */
function decodeXml(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!;
    });
}

function unescapeOoxml(s: string): string {
  return s.replace(/_x([0-9a-fA-F]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeXml(m[1] ?? m[2]!) : undefined;
}

/** Gabungan semua `<t>` (termasuk run teks kaya), tanpa teks fonetik `<rPh>`. */
function textOf(xml: string): string {
  const clean = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  for (const m of clean.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) out += m[1] ?? "";
  return unescapeOoxml(decodeXml(out));
}

/** Nomor kolom (0-based) dari referensi sel seperti "C5". */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Format angka berupa tanggal/waktu: ada token d/m/y/h di luar kutip, kurung siku, dan escape. */
function isDateFormat(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[\\_*]./g, "");
  return /[dmyh]/i.test(bare);
}

/** Indeks style (atribut `s`) yang memakai format tanggal. */
function dateStyles(styles: string | undefined): Set<number> {
  const result = new Set<number>();
  if (!styles) return result;
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) {
    const id = attr(m[0], "numFmtId");
    const code = attr(m[0], "formatCode");
    if (id !== undefined && code !== undefined) custom.set(Number(id), code);
  }
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(styles);
  if (!xfs) return result;
  let i = 0;
  for (const m of xfs[1]!.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    const code = custom.get(id);
    const builtIn = (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
    if (code !== undefined ? isDateFormat(code) : builtIn) result.add(i);
    i++;
  }
  return result;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Nomor seri Excel menjadi `YYYY-MM-DD` atau `YYYY-MM-DDTHH:MM`. */
function serialToDate(serial: number, date1904: boolean): string {
  const minutes = Math.round(serial * 1440);
  let base: number;
  if (date1904) base = Date.UTC(1904, 0, 1);
  // Excel menganggap 1900 tahun kabisat (29 Feb 1900 fiktif = seri 60).
  else base = serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const d = new Date(base + minutes * 60_000);
  const day = `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return minutes % 1440 === 0 ? day : `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Path lembar kerja pertama, dari workbook.xml + relasinya. */
function firstSheet(workbook: string, rels: string | undefined): { names: string[]; path: string } {
  const tags = [...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map((m) => m[0]);
  const names = tags.map((t) => attr(t, "name") ?? "");
  let path = "xl/worksheets/sheet1.xml";
  const rid = tags[0] && /\s[\w]+:id\s*=\s*"([^"]*)"/.exec(tags[0])?.[1];
  if (rid && rels) {
    for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
      if (attr(m[0], "Id") !== rid) continue;
      const target = attr(m[0], "Target");
      if (target) path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      break;
    }
  }
  return { names, path };
}

/** Baca lembar kerja pertama dari file .xlsx. Semua nilai dikembalikan sebagai teks. */
export function readXlsx(data: Uint8Array): XlsxData {
  const entries = readZip(data);
  const workbook = readEntry(data, entries, "xl/workbook.xml");
  if (workbook === undefined) throw new Error(INVALID);
  const { names, path } = firstSheet(workbook, readEntry(data, entries, "xl/_rels/workbook.xml.rels"));
  const sheet = readEntry(data, entries, path);
  if (sheet === undefined) throw new Error(INVALID);

  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\sdate1904\s*=\s*"(?:1|true)"/.test(workbook);
  const shared: string[] = [];
  const sst = readEntry(data, entries, "xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) shared.push(textOf(m[1] ?? ""));
  const dates = dateStyles(readEntry(data, entries, "xl/styles.xml"));

  const rows: string[][] = [];
  let rowNo = 0;
  for (const rm of sheet.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const r = attr(rm[1]!, "r");
    rowNo = r ? Number(r) : rowNo + 1;
    if (rowNo > MAX_ROWS) throw new Error(`File .xlsx terlalu banyak baris (maksimal ${MAX_ROWS})`);
    const cells: string[] = [];
    let col = -1;
    for (const cm of (rm[2] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ref = attr(cm[1]!, "r");
      col = ref ? colIndex(ref) : col + 1;
      if (col < 0 || col > 16383) continue;
      const type = attr(cm[1]!, "t") ?? "n";
      const inner = cm[2] ?? "";
      const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      let value = "";
      if (type === "inlineStr") value = textOf(inner);
      else if (v === undefined) value = "";
      else if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "b") value = v.trim() === "1" ? "true" : "false";
      else if (type === "str" || type === "e" || type === "d") value = unescapeOoxml(decodeXml(v));
      else {
        value = decodeXml(v).trim();
        const s = Number(attr(cm[1]!, "s") ?? 0);
        const num = Number(value);
        if (dates.has(s) && value !== "" && Number.isFinite(num) && num >= 0) value = serialToDate(num, date1904);
      }
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    while (rows.length < rowNo - 1) rows.push([]);
    rows[rowNo - 1] = cells;
  }
  while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop();
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push("");
  return { sheets: names, rows };
}
