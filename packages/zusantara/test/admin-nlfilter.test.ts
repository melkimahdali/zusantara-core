import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminField } from "../src/admin/fields.js";
import { parseAmount, parseNlFilter } from "../src/admin/nlfilter.js";

// Senin, 28 September 2026 (lokal).
const now = new Date(2026, 8, 28, 10, 30);

const fields: AdminField[] = [
  { name: "id", label: "ID", type: "number", sort: true },
  { name: "customer", label: "Pelanggan", type: "text", search: true },
  { name: "total", label: "Total", type: "number", filter: true, sort: true },
  { name: "status", label: "Status", type: "enum", options: ["baru", "dibayar", "dikirim"], filter: true },
  { name: "paid", label: "Dibayar", type: "boolean", filter: true },
  { name: "createdAt", label: "Dibuat", type: "datetime", filter: true, sort: true },
  { name: "updatedAt", label: "Diperbarui", type: "datetime", sort: true },
  { name: "publishedAt", label: "Terbit", type: "date", filter: true },
];

const id = (text: string) => parseNlFilter(text, fields, { now });
const en = (text: string) => parseNlFilter(text, fields, { now, locale: "en" });
const created = (from?: string, to?: string) => ({
  ...(from ? { f_createdAt_from: from } : {}),
  ...(to ? { f_createdAt_to: to } : {}),
});

describe("parseNlFilter", () => {
  it("contoh utama: bulan ini di atas 1 juta", () => {
    const r = id("pesanan bulan ini di atas 1 juta");
    assert.deepEqual(r.query, { filters: { ...created("2026-09-01", "2026-09-30"), f_total_from: "1000001" } });
    assert.deepEqual(r.understood, ["Dibuat: 1–30 Sep 2026", "Total > 1.000.000"]);
    assert.equal(r.rest, "");
    const e = en("orders this month over 1m");
    assert.deepEqual(e.query.filters, { ...created("2026-09-01", "2026-09-30"), f_total_from: "1000001" });
    assert.deepEqual(e.understood, ["Dibuat: 1–30 Sep 2026", "Total > 1,000,000"]);
  });

  it("perbandingan angka", () => {
    assert.deepEqual(id("minimal 1 juta").query.filters, { f_total_from: "1000000" });
    assert.deepEqual(en("at least 1m").query.filters, { f_total_from: "1000000" });
    assert.deepEqual(id("di bawah 500rb").query.filters, { f_total_to: "499999" });
    assert.deepEqual(en("under 500k").query.filters, { f_total_to: "499999" });
    assert.deepEqual(id("maksimal 750 ribu").query.filters, { f_total_to: "750000" });
    assert.deepEqual(en("at most 2 million").query.filters, { f_total_to: "2000000" });
    assert.deepEqual(id("total lebih dari 10").query.filters, { f_total_from: "11" });
    assert.deepEqual(id("antara 100rb dan 200rb").query.filters, { f_total_from: "100000", f_total_to: "200000" });
    assert.deepEqual(en("between 100k and 200k").query.filters, { f_total_from: "100000", f_total_to: "200000" });
    assert.deepEqual(id("antara 100rb dan 200rb").understood, ["Total: 100.000–200.000"]);
  });

  it("desimal: batas tidak digeser dan diberi catatan", () => {
    const r = id("di atas 1,5");
    assert.deepEqual(r.query.filters, { f_total_from: "1.5" });
    assert.deepEqual(r.understood, ["Total > 1,5 (batas ikut)"]);
  });

  it("satuan jumlah", () => {
    assert.equal(parseAmount("1,5 juta"), 1_500_000);
    assert.equal(parseAmount("1.5 million", "en"), 1_500_000);
    assert.equal(parseAmount("1.5 million"), 1_500_000);
    assert.equal(parseAmount("Rp 250.000"), 250_000);
    assert.equal(parseAmount("Rp 250.000", "en"), 250_000);
    assert.equal(parseAmount("100rb"), 100_000);
    assert.equal(parseAmount("2 jt"), 2_000_000);
    assert.equal(parseAmount("2M"), 2_000_000_000);
    assert.equal(parseAmount("2m"), 2_000_000);
    assert.equal(parseAmount("2M", "en"), 2_000_000);
    assert.equal(parseAmount("3 miliar"), 3e9);
    assert.equal(parseAmount("3 milyar"), 3e9);
    assert.equal(parseAmount("3b", "en"), 3e9);
    assert.equal(parseAmount("3 billion", "en"), 3e9);
    assert.equal(parseAmount("1,000,000", "en"), 1_000_000);
    assert.deepEqual(id("di atas Rp 250.000").query.filters, { f_total_from: "250001" });
    assert.deepEqual(en("over 1.5 million").query.filters, { f_total_from: "1500001" });
  });

  it("tanggal relatif", () => {
    const cases: [string, string, string][] = [
      ["hari ini", "2026-09-28", "2026-09-28"],
      ["today", "2026-09-28", "2026-09-28"],
      ["kemarin", "2026-09-27", "2026-09-27"],
      ["yesterday", "2026-09-27", "2026-09-27"],
      ["minggu ini", "2026-09-28", "2026-10-04"],
      ["this week", "2026-09-28", "2026-10-04"],
      ["minggu lalu", "2026-09-21", "2026-09-27"],
      ["last week", "2026-09-21", "2026-09-27"],
      ["bulan ini", "2026-09-01", "2026-09-30"],
      ["this month", "2026-09-01", "2026-09-30"],
      ["bulan lalu", "2026-08-01", "2026-08-31"],
      ["last month", "2026-08-01", "2026-08-31"],
      ["tahun ini", "2026-01-01", "2026-12-31"],
      ["this year", "2026-01-01", "2026-12-31"],
      ["tahun lalu", "2025-01-01", "2025-12-31"],
      ["last year", "2025-01-01", "2025-12-31"],
      ["7 hari terakhir", "2026-09-22", "2026-09-28"],
      ["last 7 days", "2026-09-22", "2026-09-28"],
      ["30 hari terakhir", "2026-08-30", "2026-09-28"],
    ];
    for (const [text, from, to] of cases) {
      const r = parseNlFilter(text, fields, { now });
      assert.deepEqual(r.query.filters, created(from, to), text);
      assert.equal(r.rest, "", text);
    }
    assert.deepEqual(id("kemarin").understood, ["Dibuat: 27 Sep 2026"]);
    assert.deepEqual(en("last week").understood, ["Dibuat: 21–27 Sep 2026"]);
    assert.deepEqual(id("minggu ini").understood, ["Dibuat: 28 Sep – 4 Okt 2026"]);
    assert.deepEqual(en("this week").understood, ["Dibuat: 28 Sep – 4 Oct 2026"]);
  });

  it("nama bulan, sejak, sebelum", () => {
    assert.deepEqual(id("maret 2026").query.filters, created("2026-03-01", "2026-03-31"));
    assert.deepEqual(en("March 2026").query.filters, created("2026-03-01", "2026-03-31"));
    assert.deepEqual(id("februari").query.filters, created("2026-02-01", "2026-02-28"));
    assert.deepEqual(en("feb").query.filters, created("2026-02-01", "2026-02-28"));
    // Bulan yang belum tiba tanpa tahun: tahun lalu.
    assert.deepEqual(id("desember").query.filters, created("2025-12-01", "2025-12-31"));
    assert.deepEqual(id("sejak 1 maret").query.filters, created("2026-03-01"));
    assert.deepEqual(en("since march 1").query.filters, created("2026-03-01"));
    assert.deepEqual(id("sejak 1 maret").understood, ["Dibuat: sejak 1 Mar 2026"]);
    assert.deepEqual(id("sebelum 1 maret").query.filters, created(undefined, "2026-02-28"));
    assert.deepEqual(en("before March 1, 2026").query.filters, created(undefined, "2026-02-28"));
    assert.deepEqual(en("before March 1, 2026").understood, ["Dibuat: until 28 Feb 2026"]);
    assert.deepEqual(id("sejak 1 maret sebelum 1 april").query.filters, created("2026-03-01", "2026-03-31"));
  });

  it("field tanggal yang disebut", () => {
    assert.deepEqual(id("terbit bulan lalu").query.filters, { f_publishedAt_from: "2026-08-01", f_publishedAt_to: "2026-08-31" });
    assert.deepEqual(en("published last month").understood, ["Terbit: 1–31 Aug 2026"]);
    assert.deepEqual(id("dibuat hari ini").query.filters, created("2026-09-28", "2026-09-28"));
    assert.deepEqual(en("created today").query.filters, created("2026-09-28", "2026-09-28"));
    assert.equal(en("created today").rest, "");
  });

  it("field disebut tapi tidak bisa difilter: frasa tetap di rest", () => {
    const r = id("diperbarui bulan ini");
    assert.deepEqual(r.query, { filters: {}, q: "diperbarui bulan ini" });
    assert.deepEqual(r.understood, []);
    assert.equal(en("updated this month").rest, "updated this month");
    // Tanpa field angka yang bisa difilter.
    const noNum = fields.map((f) => (f.name === "total" ? { ...f, filter: false } : f));
    const n = parseNlFilter("di atas 1 juta", noNum, { now });
    assert.deepEqual(n.query.filters, {});
    assert.equal(n.rest, "atas 1 juta");
  });

  it("enum", () => {
    assert.deepEqual(id("pesanan dikirim").query.filters, { f_status: "dikirim" });
    assert.deepEqual(en("orders with status baru").query.filters, { f_status: "baru" });
    assert.deepEqual(id("status dibayar").understood, ["Status: dibayar"]);
    const f2: AdminField[] = [{ name: "state", label: "State", type: "enum", options: ["in_progress", "done"], filter: true }];
    assert.deepEqual(parseNlFilter("in progress", f2, { now }).query.filters, { f_state: "in_progress" });
    assert.deepEqual(parseNlFilter("IN_PROGRESS", f2, { now }).query.filters, { f_state: "in_progress" });
  });

  it("boolean", () => {
    assert.deepEqual(id("sudah dibayar").query.filters, { f_paid: "1" });
    assert.deepEqual(id("belum dibayar").query.filters, { f_paid: "0" });
    assert.deepEqual(id("belum dibayar").understood, ["Dibayar: Tidak"]);
    assert.deepEqual(en("paid").query.filters, { f_paid: "1" });
    assert.deepEqual(en("not paid").query.filters, { f_paid: "0" });
    assert.deepEqual(en("unpaid").understood, ["Dibayar: No"]);
    const users: AdminField[] = [
      { name: "name", label: "Nama", type: "text", search: true },
      { name: "isActive", label: "Aktif", type: "boolean", filter: true },
      { name: "verified", label: "Terverifikasi", type: "boolean", filter: true },
    ];
    const u = (t: string) => parseNlFilter(t, users, { now, label: "Pengguna" }).query.filters;
    assert.deepEqual(u("pengguna aktif"), { f_isActive: "1" });
    assert.deepEqual(u("active users"), { f_isActive: "1" });
    assert.deepEqual(u("yes"), { f_isActive: "1" });
    assert.deepEqual(u("tidak aktif"), { f_isActive: "0" });
    assert.deepEqual(u("nonaktif"), { f_isActive: "0" });
    assert.deepEqual(u("inactive"), { f_isActive: "0" });
    assert.deepEqual(u("aktif belum terverifikasi"), { f_isActive: "1", f_verified: "0" });
    assert.deepEqual(u("not verified"), { f_verified: "0" });
  });

  it("urutan", () => {
    assert.deepEqual(id("terbaru").query, { filters: {}, sort: "createdAt", dir: "desc" });
    assert.deepEqual(en("newest").query, { filters: {}, sort: "createdAt", dir: "desc" });
    assert.deepEqual(en("latest").query.sort, "createdAt");
    assert.deepEqual(id("terlama").query.dir, "asc");
    assert.deepEqual(en("oldest").query.dir, "asc");
    assert.deepEqual(id("termahal").query, { filters: {}, sort: "total", dir: "desc" });
    assert.deepEqual(id("total tertinggi").query, { filters: {}, sort: "total", dir: "desc" });
    assert.deepEqual(en("most expensive").query, { filters: {}, sort: "total", dir: "desc" });
    assert.deepEqual(en("highest").query.dir, "desc");
    assert.deepEqual(id("termurah").query.dir, "asc");
    assert.deepEqual(id("terendah").query.dir, "asc");
    assert.deepEqual(en("cheapest").query, { filters: {}, sort: "total", dir: "asc" });
    assert.deepEqual(en("lowest").query.sort, "total");
    assert.deepEqual(id("terbaru").understood, ["Urut: Dibuat (terbaru)"]);
    assert.deepEqual(en("cheapest").understood, ["Sort: Total (lowest)"]);
    // Tanpa sort: true tidak diurutkan.
    const noSort = fields.map((f) => ({ ...f, sort: false }));
    assert.equal(parseNlFilter("terbaru", noSort, { now }).query.sort, undefined);
    assert.equal(parseNlFilter("terbaru", noSort, { now }).rest, "terbaru");
  });

  it("kalimat gabungan dengan sisa teks", () => {
    const r = id("pesanan budi yang sudah dibayar minggu lalu di bawah 500rb terbaru");
    assert.deepEqual(r.query, {
      filters: { ...created("2026-09-21", "2026-09-27"), f_total_to: "499999", f_paid: "1" },
      sort: "createdAt",
      dir: "desc",
      q: "budi",
    });
    assert.equal(r.rest, "budi");
    const e = en("Show me paid orders from Jakarta last 7 days under 500k, cheapest");
    assert.deepEqual(e.query.filters, { ...created("2026-09-22", "2026-09-28"), f_total_to: "499999", f_paid: "1" });
    assert.equal(e.query.sort, "total");
    assert.equal(e.rest, "Jakarta");
  });

  it("tidak ada yang cocok: semua teks jadi pencarian", () => {
    const r = id("Budi Santoso Bandung");
    assert.deepEqual(r.query, { filters: {}, q: "Budi Santoso Bandung" });
    assert.deepEqual(r.understood, []);
    assert.equal(r.rest, "Budi Santoso Bandung");
  });

  it("label tabel diabaikan", () => {
    const r = parseNlFilter("Transaksi dikirim", fields, { now, label: "Transaksi" });
    assert.deepEqual(r.query, { filters: { f_status: "dikirim" } });
  });
});
