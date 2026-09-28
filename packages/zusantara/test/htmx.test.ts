import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fragment, h, hxHeaders, hxRedirect, htmxTarget, isHtmx, renderToString, type ZenContext } from "../src/core/index.js";
import { Button, Combobox, ComboboxOptions, DataTable, Form, InlineEdit, NavItem, page, Pagination, PostButton, Search, Tabs } from "../src/ui/index.js";
import { HTMX_VERSION } from "../src/ui/htmx.gen.js";
import { startServer } from "./helpers.js";

const ctxWith = (headers: Record<string, string>) => ({ req: { headers } }) as unknown as ZenContext;

describe("htmx di inti", () => {
  it("isHtmx dan htmxTarget: hanya permintaan htmx biasa, bukan boost atau pemulihan riwayat", () => {
    assert.equal(isHtmx(ctxWith({})), false);
    assert.equal(isHtmx(ctxWith({ "hx-request": "true" })), true);
    assert.equal(isHtmx(ctxWith({ "hx-request": "true", "hx-boosted": "true" })), false);
    assert.equal(isHtmx(ctxWith({ "hx-request": "true", "hx-history-restore-request": "true" })), false);
    assert.equal(htmxTarget(ctxWith({ "hx-request": "true", "hx-target": "hasil" })), "hasil");
    assert.equal(htmxTarget(ctxWith({ "hx-target": "hasil" })), undefined);
  });

  it("hxRedirect, fragment, dan hxHeaders", () => {
    const plain = hxRedirect(ctxWith({}), "/produk");
    assert.equal(plain.status, 303);
    assert.equal(plain.headers.Location ?? plain.headers.location, "/produk");
    const viaHtmx = hxRedirect(ctxWith({ "hx-request": "true" }), "/produk");
    assert.equal(viaHtmx.status, 200);
    assert.equal(viaHtmx.headers["HX-Location"], "/produk");
    const frag = fragment("<li>a</li>", { "HX-Trigger": "tersimpan" }, 422);
    assert.equal(frag.status, 422);
    assert.equal(frag.headers.Vary, "HX-Request");
    assert.equal(frag.headers["HX-Trigger"], "tersimpan");
    assert.deepEqual(hxHeaders({ trigger: { tersimpan: { id: 3 } }, pushUrl: false, refresh: true }), {
      "HX-Trigger": '{"tersimpan":{"id":3}}',
      "HX-Push-Url": "false",
      "HX-Refresh": "true",
    });
  });

  it("htmx.js dan lisensinya disajikan dari /_zusantara", async () => {
    const { base, close } = await startServer();
    try {
      const js = await fetch(`${base}/_zusantara/htmx.js`);
      assert.equal(js.status, 200);
      assert.match(js.headers.get("content-type") ?? "", /javascript/);
      assert.match(await js.text(), /htmx/);
      assert.match(await (await fetch(`${base}/_zusantara/htmx.LICENSE.txt`)).text(), /Zero-Clause BSD|0BSD|BSD Zero Clause/i);
    } finally {
      await close();
    }
  });
});

describe("htmx di kit UI", () => {
  it("page memuat htmx hanya bila markup memakai hx-*", () => {
    assert.doesNotMatch(page({ title: "t" }, h("p", null, "hx-get sebagai teks biasa")), /htmx\.js/);
    const html = page({ title: "t" }, h(Button, { href: "/lagi", hx: { target: "#daftar" } }, "Muat"));
    assert.match(html, new RegExp(`<script src="/_zusantara/htmx\\.js\\?v=${HTMX_VERSION.replace(/\./g, "\\.")}" defer></script>`));
    assert.match(html, /<meta name="htmx-config"/);
    assert.match(page({ title: "t", htmx: true }), /htmx\.js/);
    assert.doesNotMatch(page({ title: "t", htmx: false }, h(Button, { hx: { get: "/x" } }, "x")), /htmx\.js/);
  });

  it("prop hx di Button, PostButton, Form, Search, Tabs, dan Pagination", () => {
    const html = renderToString(
      h(
        "div",
        null,
        h(Button, { href: "/lagi", hx: { target: "#daftar", swap: "beforeend" } }, "Muat"),
        h(PostButton, { action: "/hapus/1", hx: { target: "closest tr", swap: "outerHTML" } }, "Hapus"),
        h(Form, { action: "/simpan", hx: { post: "/simpan", target: "this" } }, "isi"),
        h(Search, { action: "/produk", hx: { target: "#hasil" } }),
        h(Tabs, { items: [{ href: "/a", label: "A" }], active: "/a", hx: { target: "#isi" } }),
        h(Pagination, { page: 1, pages: 3, href: "/p?page={page}", hx: { target: "#isi" } }),
      ),
    );
    assert.match(html, /<a class="zu-btn primary" href="\/lagi" hx-get="\/lagi" hx-target="#daftar" hx-swap="beforeend">Muat<\/a>/);
    assert.match(html, /hx-target="closest tr" hx-swap="outerHTML"/);
    assert.match(html, /hx-post="\/simpan" hx-target="this"/);
    assert.match(html, /hx-get="\/produk" hx-target="#hasil" hx-trigger="input changed delay:300ms/);
    assert.match(html, /href="\/a"[^>]*hx-get="\/a" hx-target="#isi"/);
    assert.match(html, /href="\/p\?page=2"[^>]*hx-get="\/p\?page=2"/);
    // Nilai atribut tetap di-escape.
    assert.match(renderToString(h(Button, { hx: { get: '/x?a="b"' } }, "x")), /hx-get="\/x\?a=&quot;b&quot;"/);
  });

  it("DataTable: tautan urut dengan aria-sort, label kartu di HP, dan tabel kosong", () => {
    const html = renderToString(
      h(DataTable, {
        columns: [
          { key: "name", label: "Nama", sortable: true },
          { key: "price", label: "Harga", sortable: true, align: "num" },
        ],
        rows: [["Kopi", "18.000"]],
        sort: { key: "price", dir: "asc" },
      }),
    );
    assert.match(html, /<th scope="col" aria-sort="ascending" class="num">|<th class="num" scope="col" aria-sort="ascending">/);
    assert.match(html, /href="\?sort=price&amp;dir=desc"/);
    assert.match(html, /href="\?sort=name&amp;dir=asc"/);
    assert.match(html, /<td data-label="Nama">Kopi<\/td>/);
    assert.match(renderToString(h(DataTable, { columns: [{ key: "a", label: "A" }], rows: [], empty: "Belum ada" })), /Belum ada/);
  });

  it("InlineEdit: formulir kecil yang menyimpan saat nilai berubah", () => {
    const sel = renderToString(h(InlineEdit, { action: "/p/1/field/status", name: "status", label: "Status", type: "select", value: "live", options: ["draft", "live"] }));
    assert.match(sel, /hx-post="\/p\/1\/field\/status"/);
    assert.match(sel, /hx-trigger="change"/);
    assert.match(sel, /hx-swap="outerHTML"/);
    assert.match(sel, /<option value="live" selected>live<\/option>/);
    assert.match(sel, /<noscript>/);
    const sw = renderToString(h(InlineEdit, { action: "/p/1/field/active", name: "active", label: "Aktif", type: "switch", value: true }));
    assert.match(sw, /<input type="hidden" name="active" value="0">/);
    assert.match(sw, /name="active" value="1" checked/);
    assert.match(renderToString(h(InlineEdit, { action: "/x", name: "n", label: "N", value: "", error: "Wajib diisi" })), /Wajib diisi/);
  });

  it("Combobox: cari di server, pilihan radio, dan input cari tidak ikut terkirim", () => {
    const html = renderToString(
      h(Combobox, { name: "categoryId", label: "Kategori", source: "/admin/products/_options/categoryId", value: "2", options: [{ value: "2", label: "Teh" }] }),
    );
    assert.match(html, /hx-get="\/admin\/products\/_options\/categoryId"/);
    assert.match(html, /form="[^"]+-none"/);
    assert.match(html, /type="radio"[^>]* name="categoryId" value="2" checked/);
    const opts = renderToString(h(ComboboxOptions, { name: "categoryId", options: [], allowEmpty: true }));
    assert.match(opts, /zu-combo-empty|zu-combo-item none/);
  });

  it("NavItem badge", () => {
    const item: NavItem = { href: "/pesanan", label: "Pesanan", badge: 3 };
    assert.equal(item.badge, 3);
  });
});
