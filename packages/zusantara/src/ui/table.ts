import { h, type Child } from "../core/view.js";
import { t } from "../i18n/index.js";
import { EmptyState } from "./index.js";
import { hxAttrs, type HxProps } from "./hx.js";
import { cx, type WithChildren } from "./types.js";

/**
 * Tabel data untuk daftar panjang (panel admin, laporan): kolom bisa diurutkan lewat tautan, sel bisa
 * diubah langsung (InlineEdit), dan di ponsel setiap baris tampil sebagai kartu berlabel. Semuanya
 * tautan dan formulir biasa, jadi berfungsi tanpa JavaScript; prop `hx` membuatnya berjalan tanpa
 * muat ulang halaman lewat htmx.
 */

export interface DataColumn {
  /** Kunci kolom untuk pengurutan (nilai `{key}` di sortHref). */
  key: string;
  label: string;
  /** "num" = rata kanan dengan angka tabular; "end" = kolom aksi rapat di kanan. */
  align?: "num" | "end";
  /** Kolom bisa diurutkan (default false). */
  sortable?: boolean;
}

export interface DataSort {
  key: string;
  dir: "asc" | "desc";
}

/**
 * Tabel data dengan urutan kolom, sel yang bisa diubah langsung, dan tampilan kartu di ponsel.
 * `sortHref` memakai `{key}` dan `{dir}` (default `?sort={key}&dir={dir}`); klik kolom yang sama
 * membalik arah urutan. `hx` memuat hasil urutan lewat htmx, mis. { target: "#hasil", pushUrl: true }.
 * @en Data table with sortable columns, cells that can be edited in place, and a card view on phones. `sortHref` uses `{key}` and `{dir}` (default `?sort={key}&dir={dir}`); clicking the same column flips the order. `hx` loads the sorted result through htmx, e.g. { target: "#results", pushUrl: true }.
 * @group data
 * @example h(DataTable, { columns: [{ key: "name", label: "Nama", sortable: true }, { key: "price", label: "Harga", align: "num", sortable: true }], rows: products.map((p) => [p.name, money(p.price)]), sort: { key: "name", dir: "asc" }, sortHref: "/produk?sort={key}&dir={dir}" })
 */
export function DataTable({
  columns,
  rows,
  sort,
  sortHref = "?sort={key}&dir={dir}",
  empty,
  caption,
  hx,
}: WithChildren<{
  columns: DataColumn[];
  rows: Child[][];
  sort?: DataSort;
  sortHref?: string;
  empty?: Child;
  /** Judul tabel untuk pembaca layar. */
  caption?: string;
  hx?: HxProps;
}>): Child {
  if (rows.length === 0) return empty ?? h(EmptyState, { title: t().ui.noData });
  const m = t().ui;
  const head = columns.map((c) => {
    if (!c.sortable) return h("th", { class: c.align, scope: "col" }, c.label);
    const current = sort?.key === c.key ? sort.dir : undefined;
    const next = current === "asc" ? "desc" : "asc";
    const href = sortHref.replaceAll("{key}", encodeURIComponent(c.key)).replaceAll("{dir}", next);
    return h(
      "th",
      { class: c.align, scope: "col", "aria-sort": current === "asc" ? "ascending" : current === "desc" ? "descending" : undefined },
      h(
        "a",
        { class: cx("zu-sort", current), href, "aria-label": m.sortBy(c.label, next === "asc"), ...hxAttrs(hx, { get: href }) },
        c.label,
        h("span", { class: "zu-sort-icon", "aria-hidden": "true" }, current === "asc" ? "↑" : current === "desc" ? "↓" : "↕"),
      ),
    );
  });
  return h(
    "div",
    { class: "zu-table-wrap" },
    h(
      "table",
      { class: "zu-table zu-datatable" },
      caption ? h("caption", { class: "zu-sr" }, caption) : null,
      h("thead", null, h("tr", null, head)),
      h(
        "tbody",
        null,
        rows.map((row) => h("tr", null, row.map((cell, i) => h("td", { class: columns[i]?.align, "data-label": columns[i]?.align === "end" ? undefined : columns[i]?.label }, cell)))),
      ),
    ),
  );
}

/**
 * Nilai di sel tabel yang bisa diubah langsung: berubah = tersimpan (POST ke `action` lewat htmx,
 * lalu sel diganti dengan respons server). Tanpa JavaScript muncul tombol Simpan kecil. Server
 * membalas dengan InlineEdit yang sama (dengan `error` bila tidak valid).
 * @en A table-cell value that can be edited in place: a change saves it (POST to `action` through htmx, then the cell is replaced with the server's response). Without JavaScript a small Save button shows. The server replies with the same InlineEdit (with `error` when invalid).
 * @group data
 * @example h(InlineEdit, { action: `/admin/products/${p.id}/field/stock`, name: "stock", label: "Stok", type: "number", value: p.stock })
 */
export function InlineEdit({
  action,
  name,
  label,
  type = "text",
  value,
  options,
  error,
}: WithChildren<{
  action: string;
  name: string;
  /** Label untuk pembaca layar (tidak tampil). */
  label: string;
  type?: "text" | "number" | "date" | "select" | "switch";
  value?: string | number | boolean | null;
  /** Pilihan untuk type "select". */
  options?: (string | { value: string; label: string })[];
  error?: string;
}>): Child {
  const m = t().ui;
  const id = `ie-${action.replace(/[^\w-]+/g, "-")}`;
  const aria = { "aria-label": label, "aria-invalid": error ? "true" : undefined, "aria-describedby": error ? `${id}-error` : undefined };
  let control: Child;
  if (type === "switch") {
    control = [
      // Kotak centang yang tidak dicentang tidak terkirim: nilai "0" ini yang terkirim sebagai gantinya.
      h("input", { type: "hidden", name, value: "0" }),
      h("label", { class: "zu-switch" }, h("input", { type: "checkbox", role: "switch", name, value: "1", checked: value === true || value === 1 || value === "1", ...aria }), h("span", { class: "zu-switch-track", "aria-hidden": "true" })),
    ];
  } else if (type === "select") {
    control = h(
      "select",
      { class: "zu-input zu-select", name, ...aria },
      (options ?? []).map((o) => {
        const opt = typeof o === "string" ? { value: o, label: o } : o;
        return h("option", { value: opt.value, selected: String(value ?? "") === opt.value }, opt.label);
      }),
    );
  } else {
    control = h("input", { class: "zu-input", type, name, value: value === null || value === undefined ? "" : String(value), step: type === "number" ? "any" : undefined, ...aria });
  }
  return h(
    "form",
    { class: cx("zu-inline-edit", error && "invalid"), id, method: "post", action, "hx-post": action, "hx-trigger": "change", "hx-target": "this", "hx-swap": "outerHTML" },
    control,
    h("noscript", null, h("button", { class: "zu-btn secondary small", type: "submit" }, m.save)),
    error ? h("span", { class: "zu-error", id: `${id}-error` }, error) : null,
  );
}
