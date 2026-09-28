import type { Props } from "../core/view.js";

/**
 * Prop `hx` di komponen kit UI: atribut [htmx](https://htmx.org) dalam bentuk objek yang mudah dibaca.
 * Halaman yang memakainya otomatis memuat htmx lewat `page()`. Tanpa JavaScript, komponen tetap
 * berfungsi seperti biasa (link dan formulir biasa).
 *
 *   h(Search, { action: "/produk", value: q, hx: { target: "#hasil", trigger: "input changed delay:300ms", pushUrl: true } })
 */
export interface HxProps {
  /** URL untuk GET lewat htmx (hx-get). Link dan formulir GET memakai href/action-nya bila kosong. */
  get?: string;
  /** URL untuk POST lewat htmx (hx-post). Formulir POST memakai action-nya bila kosong. */
  post?: string;
  put?: string;
  patch?: string;
  delete?: string;
  /** Elemen yang diganti isinya, selektor CSS (mis. "#hasil", "closest tr", "this"). */
  target?: string;
  /** Cara mengganti: innerHTML (default), outerHTML, beforeend, afterbegin, delete, none, dll. */
  swap?: string;
  /** Kapan permintaan dikirim, mis. "change", "input changed delay:300ms", "load", "revealed". */
  trigger?: string;
  /** Ubah URL di bilah alamat (true = URL permintaan). */
  pushUrl?: boolean | string;
  /** Ambil sebagian respons saja, selektor CSS. */
  select?: string;
  /** Elemen yang tampil selama permintaan berjalan (mis. Spinner dengan class htmx-indicator). */
  indicator?: string;
  /** Konfirmasi browser sebelum mengirim. */
  confirm?: string;
  /** Ikut kirim nilai elemen lain, selektor CSS (mis. "#filter"). */
  include?: string;
  /** Nilai tambahan yang dikirim, mis. { tab: "aktif" }. */
  vals?: Record<string, string | number | boolean>;
  /** Link dan formulir di dalam elemen ini dimuat lewat htmx tanpa muat ulang halaman. */
  boost?: boolean;
  /** Kunci elemen selama permintaan berjalan, selektor CSS (mis. "this" atau "find button"). */
  disabledElt?: string;
}

/**
 * Atribut hx-* untuk h(). `fallback` mengisi hx-get/hx-post dari href/action komponen bila tidak
 * ditulis di `hx`.
 */
export function hxAttrs(hx: HxProps | undefined, fallback?: { get?: string; post?: string }): Props {
  if (!hx) return {};
  const attrs: Props = {};
  const verbs = ["get", "post", "put", "patch", "delete"] as const;
  const hasVerb = verbs.some((v) => hx[v]);
  for (const v of verbs) if (hx[v]) attrs[`hx-${v}`] = hx[v];
  if (!hasVerb && fallback?.get) attrs["hx-get"] = fallback.get;
  if (!hasVerb && fallback?.post) attrs["hx-post"] = fallback.post;
  if (hx.target) attrs["hx-target"] = hx.target;
  if (hx.swap) attrs["hx-swap"] = hx.swap;
  if (hx.trigger) attrs["hx-trigger"] = hx.trigger;
  if (hx.pushUrl !== undefined) attrs["hx-push-url"] = String(hx.pushUrl);
  if (hx.select) attrs["hx-select"] = hx.select;
  if (hx.indicator) attrs["hx-indicator"] = hx.indicator;
  if (hx.confirm) attrs["hx-confirm"] = hx.confirm;
  if (hx.include) attrs["hx-include"] = hx.include;
  if (hx.vals) attrs["hx-vals"] = JSON.stringify(hx.vals);
  if (hx.boost) attrs["hx-boost"] = "true";
  if (hx.disabledElt) attrs["hx-disabled-elt"] = hx.disabledElt;
  return attrs;
}

/** Halaman yang HTML-nya memuat atribut hx-* membutuhkan htmx. */
export function usesHtmx(markup: string): boolean {
  return /\shx-(?:get|post|put|patch|delete|boost|trigger|on)[\s=:]/.test(markup);
}
