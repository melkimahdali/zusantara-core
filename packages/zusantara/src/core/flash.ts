import type { ZenContext } from "./context.js";
import { SESSION_SLOT, type Session } from "./session.js";

/**
 * Pesan flash: pesan satu kali yang ditampilkan di halaman berikutnya setelah redirect, mis. "Produk
 * tersimpan" setelah formulir dikirim. Disimpan di session bila middleware `session()` terpasang, bila
 * tidak di cookie pendek `zen_flash`. Tampilkan dengan `h(Toast, { flash: takeFlash(ctx) })`.
 *
 *   flash(ctx, "Produk tersimpan");
 *   return redirect("/produk");
 */

export interface Flash {
  message: string;
  tone: "success" | "info" | "warn" | "error";
  /** Tombol di pesan, dikirim sebagai POST ke `action`, mis. { label: "Urungkan", action: "/admin/produk/3/restore" }. */
  action?: { label: string; action: string };
}

const KEY = "_flash";
const COOKIE = "zen_flash";
const PENDING = Symbol.for("zusantara.flash.pending");
const TONES = new Set(["success", "info", "warn", "error"]);

function sessionOf(ctx: ZenContext): Session | undefined {
  return (ctx as unknown as Record<symbol, Session | undefined>)[SESSION_SLOT];
}

function parse(value: unknown): Flash | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { message, tone, action } = value as Record<string, unknown>;
  if (typeof message !== "string" || !message || typeof tone !== "string" || !TONES.has(tone)) return undefined;
  const out: Flash = { message: message.slice(0, 500), tone: tone as Flash["tone"] };
  const a = action as Record<string, unknown> | undefined;
  // Hanya URL di aplikasi yang sama (diawali satu "/"), agar pesan flash tidak bisa mengarah ke situs lain.
  if (a && typeof a.label === "string" && typeof a.action === "string" && /^\/(?![/\\])/.test(a.action)) out.action = { label: a.label.slice(0, 60), action: a.action };
  return out;
}

/**
 * Simpan pesan untuk ditampilkan satu kali di halaman berikutnya (biasanya tepat sebelum redirect).
 * Tampilkan dengan `h(Toast, { flash: takeFlash(ctx) })` di halaman tujuan. Argumen keempat menambah
 * tombol di pesan, mis. { label: "Urungkan", action: "/admin/produk/3/restore" } setelah menghapus.
 * @en Store a message to show once on the next page (usually right before a redirect). Show it with `h(Toast, { flash: takeFlash(ctx) })` on the target page. A fourth argument adds a button to the message, e.g. { label: "Undo", action: "/admin/products/3/restore" } after a delete.
 * @group feedback
 * @example flash(ctx, "Produk tersimpan"); return redirect("/produk");
 */
export function flash(ctx: ZenContext, message: string, tone: Flash["tone"] = "success", action?: Flash["action"]): void {
  const value: Flash = action ? { message, tone, action } : { message, tone };
  (ctx.state as Record<symbol, unknown>)[PENDING] = value;
  const session = sessionOf(ctx);
  if (session) session.set(KEY, value);
  else ctx.cookies.set(COOKIE, Buffer.from(JSON.stringify(value)).toString("base64url"), { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 300, secure: process.env.NODE_ENV === "production" });
}

/**
 * Ambil pesan flash lalu hapus, atau `undefined` bila tidak ada. Biasanya langsung diberikan ke Toast.
 * @en Take the flash message and remove it, or `undefined` when there is none. Usually passed straight to Toast.
 * @group feedback
 * @example h(Toast, { flash: takeFlash(ctx) })
 */
export function takeFlash(ctx: ZenContext): Flash | undefined {
  const state = ctx.state as Record<symbol, unknown>;
  const pending = parse(state[PENDING]);
  delete state[PENDING];
  const session = sessionOf(ctx);
  let found: Flash | undefined;
  if (session?.has(KEY)) {
    found = parse(session.get(KEY));
    session.delete(KEY);
  }
  const cookie = ctx.cookies.get(COOKIE);
  if (cookie !== undefined || (pending && !session)) {
    if (!found && cookie !== undefined) {
      try {
        found = parse(JSON.parse(Buffer.from(cookie, "base64url").toString("utf8")));
      } catch {
        found = undefined;
      }
    }
    if (!ctx.res.headersSent) ctx.cookies.delete(COOKIE, { path: "/" });
  }
  return pending ?? found;
}
