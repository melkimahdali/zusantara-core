import type { ZenContext } from "./context.js";
import { html, redirect, ZenResponse, type ResponseHeaders } from "./response.js";

/**
 * Bantuan server untuk [htmx](https://htmx.org), yang disajikan framework di /_zusantara/htmx.js dan
 * dimuat otomatis oleh `page()` bila halaman memakai atribut `hx-*` (lihat prop `hx` di kit UI).
 *
 *   export async function GET(ctx: ZenContext) {
 *     const rows = await cariProduk(ctx.query.q);
 *     // Permintaan htmx ke #hasil cukup dijawab dengan potongan tabelnya saja.
 *     if (htmxTarget(ctx) === "hasil") return html(renderToString(tabel(rows)), { headers: { Vary: "HX-Request" } });
 *     return page({ title: "Produk" }, ...);
 *   }
 */

export interface HtmxRequest {
  /** Permintaan dikirim oleh htmx (header HX-Request). */
  request: boolean;
  /** Link atau formulir yang di-boost (hx-boost). */
  boosted: boolean;
  /** id elemen tujuan (HX-Target), tanpa "#". */
  target?: string;
  /** id elemen pemicu (HX-Trigger). */
  trigger?: string;
  /** name elemen pemicu (HX-Trigger-Name). */
  triggerName?: string;
  /** URL halaman di browser saat permintaan dikirim (HX-Current-URL). */
  currentUrl?: string;
  /** Permintaan pemulihan riwayat (tombol Back setelah cache htmx habis): kirim halaman utuh. */
  historyRestore: boolean;
}

function header(ctx: ZenContext, name: string): string | undefined {
  const value = ctx.req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Keterangan permintaan htmx dari header-nya. */
export function htmxRequest(ctx: ZenContext): HtmxRequest {
  return {
    request: header(ctx, "hx-request") === "true",
    boosted: header(ctx, "hx-boosted") === "true",
    target: header(ctx, "hx-target") || undefined,
    trigger: header(ctx, "hx-trigger") || undefined,
    triggerName: header(ctx, "hx-trigger-name") || undefined,
    currentUrl: header(ctx, "hx-current-url") || undefined,
    historyRestore: header(ctx, "hx-history-restore-request") === "true",
  };
}

/**
 * true bila permintaan datang dari htmx dan bukan dari link yang di-boost atau pemulihan riwayat,
 * yaitu saat cukup mengirim potongan HTML, bukan halaman utuh.
 * @example if (isHtmx(ctx)) return html(renderToString(h(Baris, { item })));
 */
export function isHtmx(ctx: ZenContext): boolean {
  const hx = htmxRequest(ctx);
  return hx.request && !hx.boosted && !hx.historyRestore;
}

/** id elemen tujuan permintaan htmx (tanpa "#"), atau undefined bila bukan potongan untuk elemen tertentu. */
export function htmxTarget(ctx: ZenContext): string | undefined {
  return isHtmx(ctx) ? htmxRequest(ctx).target : undefined;
}

export interface HxResponseOptions {
  /** Event yang dipicu di browser setelah respons diterima (HX-Trigger), mis. "tersimpan" atau { tersimpan: { id: 3 } }. */
  trigger?: string | Record<string, unknown>;
  /** Ganti URL di bilah alamat (HX-Push-Url), atau false agar tidak diubah. */
  pushUrl?: string | false;
  /** Ganti URL tanpa menambah riwayat (HX-Replace-Url). */
  replaceUrl?: string | false;
  /** Ganti elemen tujuan (HX-Retarget), selektor CSS. */
  retarget?: string;
  /** Ganti cara menukar isi (HX-Reswap), mis. "outerHTML". */
  reswap?: string;
  /** Muat ulang seluruh halaman (HX-Refresh). */
  refresh?: boolean;
}

/** Header respons htmx dari opsi yang mudah dibaca. */
export function hxHeaders(options: HxResponseOptions): ResponseHeaders {
  const headers: ResponseHeaders = {};
  if (options.trigger !== undefined) headers["HX-Trigger"] = typeof options.trigger === "string" ? options.trigger : JSON.stringify(options.trigger);
  if (options.pushUrl !== undefined) headers["HX-Push-Url"] = options.pushUrl === false ? "false" : options.pushUrl;
  if (options.replaceUrl !== undefined) headers["HX-Replace-Url"] = options.replaceUrl === false ? "false" : options.replaceUrl;
  if (options.retarget) headers["HX-Retarget"] = options.retarget;
  if (options.reswap) headers["HX-Reswap"] = options.reswap;
  if (options.refresh) headers["HX-Refresh"] = "true";
  return headers;
}

/**
 * Pindah halaman setelah formulir berhasil disimpan. Untuk htmx: halaman tujuan dimuat tanpa muat
 * ulang penuh (HX-Location); tanpa htmx: redirect 303 biasa. Pakai bersama flash() untuk pesan sukses.
 * @example flash(ctx, "Produk tersimpan."); return hxRedirect(ctx, "/admin/products");
 */
export function hxRedirect(ctx: ZenContext, location: string): ZenResponse {
  if (htmxRequest(ctx).request) return new ZenResponse(null, { status: 200, headers: { "HX-Location": location } });
  return redirect(location, 303);
}

/**
 * Potongan HTML untuk htmx, dengan `Vary: HX-Request` agar cache tidak mencampurnya dengan halaman utuh.
 * @example if (htmxTarget(ctx) === "hasil") return fragment(renderToString(tabel(rows)));
 */
export function fragment(body: string, headers: ResponseHeaders = {}, status = 200): ZenResponse {
  return html(body, { status, headers: { Vary: "HX-Request", ...headers } });
}
