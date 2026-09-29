import type { AdminField } from "./fields.js";

/** Hasil `parseNlFilter`: parameter daftar biasa, bagian yang dipahami, dan sisa teks. */
export interface NlFilterResult {
  query: { q?: string; filters: Record<string, string>; sort?: string; dir?: "asc" | "desc" };
  /** Ringkasan tiap bagian yang dikenali, mis. "Total > 1.000.000". */
  understood: string[];
  /** Kata yang tidak dipahami (juga dipakai sebagai `q`). */
  rest: string;
}

export interface NlFilterOptions {
  /** Waktu acuan untuk tanggal relatif (default sekarang). */
  now?: Date;
  /** Bahasa ringkasan `understood` (default "id"). */
  locale?: "id" | "en";
  /** Label tabel (mis. "Pesanan"): katanya diabaikan seperti kata umum. */
  label?: string;
}

type Locale = "id" | "en";
type Range = { from?: Date; to?: Date };

// Batas kata yang paham huruf non-ASCII.
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const NEVER = "(?!)";

const MONTHS: Record<string, number> = {
  januari: 0, january: 0, jan: 0,
  februari: 1, pebruari: 1, february: 1, feb: 1,
  maret: 2, march: 2, mar: 2,
  april: 3, apr: 3,
  mei: 4, may: 4,
  juni: 5, june: 5, jun: 5,
  juli: 6, july: 6, jul: 6,
  agustus: 7, august: 7, agu: 7, agt: 7, ags: 7, aug: 7,
  september: 8, sept: 8, sep: 8,
  oktober: 9, october: 9, okt: 9, oct: 9,
  november: 10, nopember: 10, nov: 10,
  desember: 11, december: 11, des: 11, dec: 11,
};
const MONTH_RE = alt(Object.keys(MONTHS));
const SHORT: Record<Locale, string[]> = {
  id: ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};

/** Ungkapan satu periode tanggal (hari, bulan, tahun, atau relatif). */
const PERIOD = [
  "\\d{4}-\\d{1,2}-\\d{1,2}",
  `\\d{1,2}\\s+(?:${MONTH_RE})(?:\\s+\\d{4})?`,
  `(?:${MONTH_RE})\\s+\\d{1,2}(?:,?\\s+\\d{4})?`,
  `(?:${MONTH_RE})(?:\\s+\\d{4})?`,
  "(?:tahun|year)\\s+\\d{4}",
  "\\d+\\s+(?:hari|minggu|pekan|bulan)\\s+terakhir",
  "(?:last|past)\\s+\\d+\\s+(?:days?|weeks?|months?)",
  "hari\\s+ini",
  "today",
  "yesterday",
  "(?:minggu|pekan|bulan|tahun)\\s+(?:ini|lalu|kemarin)",
  "kemarin",
  "(?:this|last)\\s+(?:week|month|year)",
]
  .map((p) => `(?:${p})${E}`)
  .join("|");

const UNIT = "(?:ribu|rb|k|juta|jt|million|mio|miliar|milyar|billion|m|b)";
const AMOUNT = `(?:rp\\.?\\s*)?\\d(?:[\\d.,]*\\d)?(?:\\s*${UNIT})?${E}`;

type Cmp = "gt" | "gte" | "lt" | "lte";
const CMP_WORDS: [string, Cmp][] = [
  ["lebih besar dari", "gt"], ["lebih dari", "gt"], ["di atas", "gt"], ["diatas", "gt"], ["melebihi", "gt"],
  ["more than", "gt"], ["greater than", "gt"], ["above", "gt"], ["over", "gt"],
  ["paling sedikit", "gte"], ["sekurangnya", "gte"], ["setidaknya", "gte"], ["minimal", "gte"], ["minimum", "gte"],
  ["min", "gte"], ["at least", "gte"],
  ["lebih kecil dari", "lt"], ["kurang dari", "lt"], ["di bawah", "lt"], ["dibawah", "lt"], ["less than", "lt"],
  ["under", "lt"], ["below", "lt"],
  ["paling banyak", "lte"], ["maksimal", "lte"], ["maksimum", "lte"], ["maks", "lte"], ["max", "lte"],
  ["at most", "lte"], ["no more than", "lte"], ["up to", "lte"],
];
const CMP_SYMS: [string, Cmp][] = [[">=", "gte"], ["≥", "gte"], ["<=", "lte"], ["≤", "lte"], [">", "gt"], ["<", "lt"]];

const SORT_WORDS: { words: string[]; kind: "date" | "number"; dir: "asc" | "desc" }[] = [
  { words: ["terbaru", "paling baru", "newest", "latest", "most recent"], kind: "date", dir: "desc" },
  { words: ["terlama", "paling lama", "oldest"], kind: "date", dir: "asc" },
  { words: ["termahal", "paling mahal", "tertinggi", "paling tinggi", "terbesar", "paling besar", "highest", "most expensive", "largest", "biggest"], kind: "number", dir: "desc" },
  { words: ["termurah", "paling murah", "terendah", "paling rendah", "terkecil", "paling kecil", "lowest", "cheapest", "smallest", "least expensive"], kind: "number", dir: "asc" },
];

const STOP = new Set(
  (
    "pesanan data yang yg dengan dgn dan atau di ke dari untuk pada tanggal tgl semua tampilkan tunjukkan lihat cari carikan " +
    "daftar saya aku urutkan urut berdasarkan dalam oleh the a an with and or of in on at for from to by all show me find list " +
    "orders order records record items that which are is sort sorted please date"
  ).split(" "),
);

const TEXT: Record<Locale, { yes: string; no: string; since: string; until: string; sort: string; incl: string; dir: Record<string, string> }> = {
  id: { yes: "Ya", no: "Tidak", since: "sejak", until: "sampai", sort: "Urut", incl: "(batas ikut)", dir: { "date-desc": "terbaru", "date-asc": "terlama", "number-desc": "tertinggi", "number-asc": "terendah" } },
  en: { yes: "Yes", no: "No", since: "since", until: "until", sort: "Sort", incl: "(bound included)", dir: { "date-desc": "newest", "date-asc": "oldest", "number-desc": "highest", "number-asc": "lowest" } },
};

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Alternasi regex, frasa terpanjang dulu; spasi cocok dengan spasi apa pun. */
function alt(words: string[]): string {
  const list = [...new Set(words.filter(Boolean))].sort((a, b) => b.length - a.length);
  return list.length ? list.map((w) => esc(w).replace(/\s+/g, "\\s+")).join("|") : NEVER;
}

function rx(src: string): RegExp {
  return new RegExp(src, "gdu");
}

/** Kata dari nama field: "createdAt" -> "created at". */
function nameWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().trim();
}

/** Cara field disebut dalam teks: label dan nama kolom. */
function terms(f: AdminField): string[] {
  const words = nameWords(f.name);
  return [f.label.toLowerCase(), words, words.replace(/^(is|has) /, "")];
}

/** Teks kerja: bagian yang sudah dipahami diganti spasi (panjang tetap). */
class Buf {
  orig: string;
  low: string;
  constructor(text: string) {
    this.orig = text;
    this.low = [...text].map((c) => (c.toLowerCase().length === c.length ? c.toLowerCase() : c)).join("");
  }
  take(re: RegExp, fn: (m: RegExpExecArray, raw: (i: number) => string | undefined) => boolean): number {
    let n = 0;
    for (const m of [...this.low.matchAll(re)] as RegExpExecArray[]) {
      const raw = (i: number) => {
        const r = m.indices?.[i];
        return r ? this.orig.slice(r[0], r[1]) : undefined;
      };
      if (fn(m, raw)) {
        this.blank(m.index, m.index + m[0].length);
        n++;
      }
    }
    return n;
  }
  private blank(a: number, b: number): void {
    const pad = " ".repeat(b - a);
    this.orig = this.orig.slice(0, a) + pad + this.orig.slice(b);
    this.low = this.low.slice(0, a) + pad + this.low.slice(b);
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const day = (y: number, m: number, d: number) => new Date(y, m, d);
const addDays = (d: Date, n: number) => day(d.getFullYear(), d.getMonth(), d.getDate() + n);

function validDay(y: number, m: number, d: number): Date | undefined {
  const r = day(y, m, d);
  return r.getMonth() === m && r.getDate() === d ? r : undefined;
}

function monthRange(y: number, m: number): Required<Range> {
  return { from: day(y, m, 1), to: day(y, m + 1, 0) };
}

/** Ungkapan periode -> rentang hari (lokal). */
function parsePeriod(text: string, now: Date): Required<Range> | undefined {
  const s = text.trim().replace(/\s+/g, " ");
  const today = day(now.getFullYear(), now.getMonth(), now.getDate());
  const y = today.getFullYear();
  const one = (d: Date | undefined) => (d ? { from: d, to: d } : undefined);
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return one(validDay(+m[1]!, +m[2]! - 1, +m[3]!));
  if ((m = new RegExp(`^(\\d{1,2}) (${MONTH_RE})(?: (\\d{4}))?$`, "u").exec(s))) return one(validDay(m[3] ? +m[3] : y, MONTHS[m[2]!]!, +m[1]!));
  if ((m = new RegExp(`^(${MONTH_RE}) (\\d{1,2})(?:,? (\\d{4}))?$`, "u").exec(s))) return one(validDay(m[3] ? +m[3] : y, MONTHS[m[1]!]!, +m[2]!));
  if ((m = new RegExp(`^(${MONTH_RE})(?: (\\d{4}))?$`, "u").exec(s))) {
    const month = MONTHS[m[1]!]!;
    // Bulan tanpa tahun yang belum tiba berarti bulan itu tahun lalu.
    return monthRange(m[2] ? +m[2] : month > today.getMonth() ? y - 1 : y, month);
  }
  if ((m = /^(?:tahun|year) (\d{4})$/.exec(s))) return { from: day(+m[1]!, 0, 1), to: day(+m[1]!, 11, 31) };
  if ((m = /^(\d+) (hari|minggu|pekan|bulan) terakhir$/.exec(s)) || (m = /^(?:last|past) (\d+) (days?|weeks?|months?)$/.exec(s))) {
    const n = +m[1]!;
    if (n < 1) return undefined;
    const unit = m[2]!;
    if (/^(bulan|month)/.test(unit)) return { from: day(y, today.getMonth() - n, today.getDate() + 1), to: today };
    const days = /^(minggu|pekan|week)/.test(unit) ? n * 7 : n;
    return { from: addDays(today, -(days - 1)), to: today };
  }
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  switch (s) {
    case "hari ini":
    case "today":
      return one(today);
    case "kemarin":
    case "yesterday":
      return one(addDays(today, -1));
    case "minggu ini":
    case "pekan ini":
    case "this week":
      return { from: monday, to: addDays(monday, 6) };
    case "minggu lalu":
    case "minggu kemarin":
    case "pekan lalu":
    case "pekan kemarin":
    case "last week":
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case "bulan ini":
    case "this month":
      return monthRange(y, today.getMonth());
    case "bulan lalu":
    case "bulan kemarin":
    case "last month":
      return monthRange(y, today.getMonth() - 1);
    case "tahun ini":
    case "this year":
      return { from: day(y, 0, 1), to: day(y, 11, 31) };
    case "tahun lalu":
    case "tahun kemarin":
    case "last year":
      return { from: day(y - 1, 0, 1), to: day(y - 1, 11, 31) };
  }
  return undefined;
}

/** "250.000", "1,5", "1.5", "1,000,000" -> angka. */
function toNumber(s: string, locale: Locale, rupiah: boolean): number | undefined {
  let n: number;
  if (/^\d{1,3}(\.\d{3})+$/.test(s) && (locale === "id" || rupiah || /\..*\./.test(s))) n = Number(s.replace(/\./g, ""));
  else if (/^\d{1,3}(,\d{3})+$/.test(s) && (locale === "en" || /,.*,/.test(s))) n = Number(s.replace(/,/g, ""));
  else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) n = Number(s.replace(/\./g, "").replace(",", "."));
  else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s)) n = Number(s.replace(/,/g, ""));
  else n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** "Rp 250.000", "1,5 juta", "100k", "2M" -> angka. "M" besar = miliar (id), "m" kecil = juta. */
export function parseAmount(raw: string, locale: Locale = "id"): number | undefined {
  const rupiah = /^\s*rp/i.test(raw);
  const m = /^(\d(?:[\d.,]*\d)?)\s*([a-z]*)$/i.exec(raw.trim().replace(/^rp\.?\s*/i, ""));
  if (!m) return undefined;
  const n = toNumber(m[1]!, locale, rupiah);
  if (n === undefined) return undefined;
  const unit = m[2]!;
  const u = unit.toLowerCase();
  let mult = 1;
  if (["rb", "ribu", "k"].includes(u)) mult = 1e3;
  else if (["jt", "juta", "million", "mio"].includes(u)) mult = 1e6;
  else if (["miliar", "milyar", "billion", "b"].includes(u)) mult = 1e9;
  else if (u === "m") mult = unit === "M" && locale === "id" ? 1e9 : 1e6;
  else if (u) return undefined;
  const v = n * mult;
  return Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : v;
}

/**
 * Ubah kalimat sehari-hari (Indonesia atau Inggris) menjadi parameter filter daftar admin,
 * mis. "pesanan bulan ini di atas 1 juta". Kata yang tidak dipahami menjadi pencarian `q`.
 */
export function parseNlFilter(text: string, fields: AdminField[], options: NlFilterOptions = {}): NlFilterResult {
  const now = options.now ?? new Date();
  const locale: Locale = options.locale ?? "id";
  const T = TEXT[locale];
  const nf = new Intl.NumberFormat(locale === "en" ? "en-US" : "id-ID", { maximumFractionDigits: 6 });
  const filters: Record<string, string> = {};
  const understood: string[] = [];
  const query: NlFilterResult["query"] = { filters };
  const buf = new Buf(text);

  const isDate = (f: AdminField) => f.type === "date" || f.type === "datetime";
  const dateFields = fields.filter(isDate);
  const numFields = fields.filter((f) => f.type === "number" && f.filter);

  // --- Tanggal ---
  const dateTerms = (f: AdminField): string[] => {
    const key = `${f.name} ${f.label}`.toLowerCase();
    const extra: string[] = [];
    if (/^created|dibuat/.test(key) || /dibuat/.test(key)) extra.push("dibuat", "created", "tanggal dibuat");
    if (/^updated|diperbarui|diubah/.test(key) || /diperbarui|diubah/.test(key)) extra.push("diperbarui", "diubah", "updated", "modified");
    if (/^publish|terbit/.test(key) || /terbit|published/.test(key)) extra.push("terbit", "diterbitkan", "published");
    return [...terms(f), ...extra];
  };
  const mentioned = dateFields.find((f) => rx(`${B}(?:${alt(dateTerms(f))})${E}`).test(buf.low));
  const byCreated = (list: AdminField[]) => list.find((f) => /^created/i.test(f.name)) ?? list[0];
  const dateField = mentioned ? (mentioned.filter ? mentioned : undefined) : byCreated(dateFields.filter((f) => f.filter));
  if (dateField) {
    const range: Range = {};
    let hit = 0;
    hit += buf.take(rx(`${B}(?:dari|from|antara|between)\\s+(${PERIOD})\\s*(?:sampai|hingga|s\\/d|to|until|and|dan|-|–)\\s*(${PERIOD})`), (m) => {
      const a = parsePeriod(m[1]!, now);
      const b = parsePeriod(m[2]!, now);
      if (!a || !b) return false;
      range.from = a.from;
      range.to = b.to;
      return true;
    });
    hit += buf.take(rx(`${B}(sejak|since|mulai|starting|from|dari|setelah|after|sebelum|before|sampai|hingga|until|till)\\s+(${PERIOD})`), (m) => {
      const p = parsePeriod(m[2]!, now);
      if (!p) return false;
      const w = m[1]!;
      if (w === "setelah" || w === "after") range.from = addDays(p.to, 1);
      else if (w === "sebelum" || w === "before") range.to = addDays(p.from, -1);
      else if (["sampai", "hingga", "until", "till"].includes(w)) range.to = p.to;
      else range.from = p.from;
      return true;
    });
    hit += buf.take(rx(`${B}(${PERIOD})`), (m) => {
      const p = parsePeriod(m[1]!, now);
      if (!p) return false;
      range.from = p.from;
      range.to = p.to;
      return true;
    });
    if (hit) {
      if (mentioned) buf.take(rx(`${B}(?:${alt(dateTerms(dateField))})${E}`), () => true);
      if (range.from) filters[`f_${dateField.name}_from`] = iso(range.from);
      if (range.to) filters[`f_${dateField.name}_to`] = iso(range.to);
      understood.push(`${dateField.label}: ${formatRange(range, locale, T)}`);
    }
  }

  // --- Angka ---
  if (numFields.length) {
    const numLabel = (s: string | undefined) => (s ? numFields.find((f) => terms(f).includes(s.replace(/\s+/g, " "))) : undefined) ?? numFields[0]!;
    const labels = alt(numFields.flatMap(terms));
    const setNum = (f: AdminField, key: "from" | "to", v: number) => {
      filters[`f_${f.name}_${key}`] = String(v);
    };
    buf.take(rx(`(?:${B}(${labels})\\s+)?${B}(?:antara|between|dari|from)\\s+(${AMOUNT})\\s*(?:dan|and|sampai|hingga|to|-|–)\\s*(${AMOUNT})`), (m, raw) => {
      const a = parseAmount(raw(2)!, locale);
      const b = parseAmount(raw(3)!, locale);
      if (a === undefined || b === undefined) return false;
      const f = numLabel(m[1]);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      setNum(f, "from", lo);
      setNum(f, "to", hi);
      understood.push(`${f.label}: ${nf.format(lo)}–${nf.format(hi)}`);
      return true;
    });
    const words = new Map(CMP_WORDS);
    const syms = new Map(CMP_SYMS);
    buf.take(rx(`(?:${B}(${labels})\\s+)?(?:${B}(${alt([...words.keys()])})${E}|(${alt([...syms.keys()])}))\\s*(${AMOUNT})`), (m, raw) => {
      const v = parseAmount(raw(4)!, locale);
      if (v === undefined) return false;
      const cmp = m[2] ? words.get(m[2].replace(/\s+/g, " "))! : syms.get(m[3]!)!;
      const f = numLabel(m[1]);
      const whole = Number.isInteger(v);
      const note = whole ? "" : ` ${T.incl}`;
      const sign = { gt: ">", gte: "≥", lt: "<", lte: "≤" }[cmp];
      // "Di atas"/"di bawah" tidak termasuk batasnya: bilangan bulat digeser 1.
      if (cmp === "gt") setNum(f, "from", whole ? v + 1 : v);
      else if (cmp === "gte") setNum(f, "from", v);
      else if (cmp === "lt") setNum(f, "to", whole ? v - 1 : v);
      else setNum(f, "to", v);
      understood.push(`${f.label} ${sign} ${nf.format(v)}${cmp === "gt" || cmp === "lt" ? note : ""}`);
      return true;
    });
  }

  // --- Urutan ---
  const sortDate = byCreated(dateFields.filter((f) => f.sort));
  const sortNums = fields.filter((f) => f.type === "number" && f.sort);
  const sortNum = sortNums.find((f) => f.filter) ?? sortNums.find((f) => f.name.toLowerCase() !== "id");
  for (const s of SORT_WORDS) {
    if (query.sort) break;
    const pool = s.kind === "date" ? dateFields.filter((f) => f.sort) : sortNums;
    const labels = alt(pool.flatMap(terms));
    buf.take(rx(`(?:${B}(${labels})\\s+)?${B}(?:${alt(s.words)})${E}(?:\\s+(${labels})${E})?`), (m) => {
      if (query.sort) return false;
      const said = m[1] ?? m[2];
      const f = (said && pool.find((x) => terms(x).includes(said.replace(/\s+/g, " ")))) || (s.kind === "date" ? sortDate : sortNum);
      if (!f) return false;
      query.sort = f.name;
      query.dir = s.dir;
      understood.push(`${T.sort}: ${f.label} (${T.dir[`${s.kind}-${s.dir}`]})`);
      return true;
    });
  }

  // --- Boolean dengan awalan (belum/sudah) dulu, lalu enum, lalu label boolean saja ---
  const bools = fields.filter((f) => f.type === "boolean" && f.filter);
  const activeLike = bools.find((f) => terms(f).some((t) => /aktif|active/.test(t))) ?? (bools.length === 1 ? bools[0] : undefined);
  const boolTerms = (f: AdminField) => [...terms(f), ...(f === activeLike ? ["aktif", "active"] : [])];
  const setBool = (f: AdminField, v: boolean) => {
    filters[`f_${f.name}`] = v ? "1" : "0";
    understood.push(`${f.label}: ${v ? T.yes : T.no}`);
  };
  for (const f of bools) {
    buf.take(rx(`${B}(?:(?:belum|tidak|tak|bukan|not|non)[\\s-]*|un|in)(?:${alt(boolTerms(f))})${E}`), () => {
      if (filters[`f_${f.name}`] !== undefined) return false;
      setBool(f, false);
      return true;
    });
    buf.take(rx(`${B}(?:sudah|telah|is)\\s+(?:${alt(boolTerms(f))})${E}`), () => {
      if (filters[`f_${f.name}`] !== undefined) return false;
      setBool(f, true);
      return true;
    });
  }
  for (const f of fields.filter((x) => x.type === "enum" && x.filter && x.options?.length)) {
    const opts = [...f.options!].sort((a, b) => b.length - a.length);
    const optRe = opts.map((o) => esc(o.toLowerCase()).replace(/(?:[_\s-]|\\-)+/g, "[\\s_-]+")).join("|");
    buf.take(rx(`(?:${B}(?:${alt(terms(f))})\\s*:?\\s+)?${B}(${optRe})${E}`), (m) => {
      if (filters[`f_${f.name}`] !== undefined) return false;
      const said = m[1]!.replace(/[\s_-]+/g, " ");
      const opt = opts.find((o) => o.toLowerCase().replace(/[\s_-]+/g, " ") === said);
      if (!opt) return false;
      filters[`f_${f.name}`] = opt;
      understood.push(`${f.label}: ${opt}`);
      return true;
    });
  }
  for (const f of bools) {
    const yes = f === activeLike ? ["yes"] : [];
    buf.take(rx(`${B}(?:${alt([...boolTerms(f), ...yes])})${E}`), () => {
      if (filters[`f_${f.name}`] !== undefined) return false;
      setBool(f, true);
      return true;
    });
  }

  // --- Sisa teks ---
  const skip = new Set([...STOP, ...(options.label ?? "").toLowerCase().split(/\s+/).filter(Boolean)]);
  const rest = buf.orig
    .split(/\s+/)
    .map((w) => w.replace(/^[,.;:!?()"'“”–-]+|[,.;:!?()"'“”–-]+$/g, ""))
    .filter((w) => w && !skip.has(w.toLowerCase()) && !skip.has(w.toLowerCase().replace(/s$/, "")))
    .join(" ");
  if (rest) query.q = rest;
  return { query, understood, rest };
}

/** "1–30 Sep 2026", "1 Mar – 5 Apr 2026", "sejak 1 Mar 2026". */
function formatRange(r: Range, locale: Locale, T: (typeof TEXT)[Locale]): string {
  const mon = SHORT[locale];
  const full = (d: Date) => `${d.getDate()} ${mon[d.getMonth()]} ${d.getFullYear()}`;
  const { from, to } = r;
  if (from && to) {
    if (iso(from) === iso(to)) return full(from);
    if (from.getFullYear() === to.getFullYear()) {
      if (from.getMonth() === to.getMonth()) return `${from.getDate()}–${full(to)}`;
      return `${from.getDate()} ${mon[from.getMonth()]} – ${full(to)}`;
    }
    return `${full(from)} – ${full(to)}`;
  }
  if (from) return `${T.since} ${full(from)}`;
  return `${T.until} ${full(to!)}`;
}
