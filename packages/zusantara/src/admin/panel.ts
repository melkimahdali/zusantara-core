import fs from "node:fs/promises";
import path from "node:path";
import { readForm, saveUpload } from "../backend/upload.js";
import type { ZenContext } from "../core/context.js";
import { HttpError } from "../core/errors.js";
import { flash, takeFlash } from "../core/flash.js";
import { fragment, htmxTarget, hxRedirect, isHtmx } from "../core/htmx.js";
import { html, ZenResponse } from "../core/response.js";
import { h, renderToString, type Child } from "../core/view.js";
import { getLocale, intlLocale, t } from "../i18n/index.js";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  CheckboxGroup,
  Cluster,
  Columns,
  Combobox,
  ComboboxOptions,
  DataTable,
  DescriptionList,
  DropdownMenu,
  EmptyState,
  Field,
  Fieldset,
  FileInput,
  Form,
  FormActions,
  formatDate,
  formatNumber,
  InlineEdit,
  List,
  page,
  Pagination,
  PostButton,
  Select,
  Split,
  Stack,
  Stat,
  StatGroup,
  Switch,
  Table,
  Tabs,
  Tag,
  Timeline,
  Toast,
  type MenuItem,
  type NavItem,
} from "../ui/index.js";
import { runAutomations } from "./automations.js";
import type { AdminField } from "./fields.js";
import { lastValue, parseField, parseForm } from "./form.js";
import { autoMap, exportCsv, exportName, IMPORT_MAX_ROWS, importFields, prepareImport, readTable, type ImportRow } from "./importer.js";
import { parseNlFilter } from "./nlfilter.js";
import type { AccessRule, AdminResource, AdminUser, AutomationEvent, ListQuery, ListResult } from "./resource.js";
import { AdminStore, type LogEntry } from "./store.js";

/**
 * Panel admin: dasbor dan halaman daftar, tambah, ubah, hapus untuk setiap tabel yang didaftarkan,
 * ditambah log audit, riwayat revisi, tempat sampah, impor/ekspor, aksi massal, catatan internal,
 * pengaturan situs, pustaka media, dan pencarian global. Dipasang oleh `zusantara make:admin` di
 * src/app/admin/index.ts dan dua route:
 *
 *   // src/app/routes/admin/index.ts
 *   export const GET = admin.dashboard;
 *   // src/app/routes/admin/[...path].ts
 *   export const GET = admin.handle;
 *   export const POST = admin.handle;
 */

export interface AdminLayoutOptions {
  title: string;
  subtitle?: string;
  /** href menu yang aktif (/admin). */
  active: string;
  actions?: Child;
}

/** Kerangka halaman aplikasi, mis. appPage dari src/app/lib/ui.ts. */
export type AdminLayout = (ctx: ZenContext, options: AdminLayoutOptions, ...children: Child[]) => string;

/** Satu isian di halaman pengaturan situs. */
export interface SettingField {
  name: string;
  label: string;
  type?: "text" | "textarea" | "email" | "url" | "number" | "boolean" | "image";
  hint?: string;
  /** Nilai bila belum pernah disimpan. */
  default?: unknown;
}

export interface AdminOptions {
  resources: AdminResource[];
  /** Awal URL panel (default /admin). */
  basePath?: string;
  /** Nama aplikasi di kerangka bawaan. */
  appName?: string;
  /** Kerangka halaman aplikasi Anda (mis. appPage), agar panel admin memakai navigasi yang sama. */
  layout?: AdminLayout;
  /** Log audit dan riwayat revisi untuk semua tabel (default true). Per tabel: opsi `audit` di defineResource. */
  audit?: boolean;
  /** Halaman pengaturan tunggal (nama situs, kontak, jam buka), dibaca aplikasi lewat `admin.settings()`. */
  settings?: { label?: string; fields: SettingField[]; access?: AccessRule };
  /** Pustaka media di /admin/_media (default: folder public/uploads, hanya role admin), atau false. */
  media?: false | { dir?: string; access?: AccessRule };
  /** Halaman ubah schema di /admin/_schema (default: hanya saat pengembangan, role admin). */
  schemaEditor?: boolean;
  /** Folder proyek untuk pengubah schema (default process.cwd()). */
  root?: string;
}

export interface AdminPanel {
  readonly resources: AdminResource[];
  readonly basePath: string;
  /** Handler GET dasbor admin (route admin/index.ts). */
  dashboard: (ctx: ZenContext) => Promise<ZenResponse>;
  /** Handler semua halaman tabel (route admin/[...path].ts, GET dan POST). */
  handle: (ctx: ZenContext) => Promise<ZenResponse>;
  /** Menu navigasi admin untuk pengguna ini (kosong bila tidak punya akses ke tabel mana pun). */
  nav: (user: AdminUser | undefined) => NavItem[];
  resource: (name: string) => AdminResource | undefined;
  /** Pengaturan situs (nilai tersimpan, atau `default` tiap isian). */
  settings: () => Promise<Record<string, unknown>>;
  /** Log audit, catatan, dan pengaturan (tabel sistem di database aplikasi). */
  readonly store: AdminStore | undefined;
  /** Tunggu otomasi yang masih berjalan (untuk tes). */
  idle: () => Promise<void>;
}

const RESULTS = "zu-admin-results";
const BULK = "zu-admin-bulk";
const HEADERS = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store", Vary: "HX-Request" };
const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "application/pdf", "text/csv", "application/zip"];

function respond(body: string, status = 200): ZenResponse {
  return html(body, { status, headers: HEADERS });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
}

/** Nilai kolom untuk input formulir. */
function inputValue(f: AdminField, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const d = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    return f.type === "date" ? d : `${d}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
  }
  if (f.type === "json") return JSON.stringify(value, null, 2);
  if (f.type === "datetime" && typeof value === "string") return value.slice(0, 16).replace(" ", "T");
  return String(value);
}

function truncate(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function allows(rule: AccessRule, ctx: ZenContext): boolean {
  const user = ctx.state.user as AdminUser | undefined;
  if (!user) return false;
  if (typeof rule === "boolean") return rule;
  if (typeof rule === "function") return rule(user, ctx);
  return typeof user.role === "string" && rule.includes(user.role);
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${formatNumber(Math.round(n / 102.4) / 10)} KB`;
  return `${formatNumber(Math.round(n / (1024 * 102.4)) / 10)} MB`;
}

export function defineAdmin(options: AdminOptions): AdminPanel {
  const basePath = (options.basePath ?? "/admin").replace(/\/+$/, "");
  const byName = new Map(options.resources.map((r) => [r.name, r]));
  const m = () => t().admin;
  const x = () => t().admin.x;
  const url = (...parts: (string | number)[]) => [basePath, ...parts.map((p) => encodeURIComponent(String(p)))].join("/");
  const first = options.resources[0];
  const store = first ? new AdminStore(first.db as never, first.info.dialect) : undefined;
  const pending = new Set<Promise<void>>();
  const mediaDir = options.media === false ? undefined : path.resolve(options.media?.dir ?? path.join("public", "uploads"));
  const schemaEditor = options.schemaEditor ?? process.env.NODE_ENV !== "production";

  function user(ctx: ZenContext): AdminUser {
    const u = ctx.state.user as AdminUser | undefined;
    if (!u) throw new HttpError(401, m().loginRequired, { expose: true });
    return u;
  }

  function visible(ctx: ZenContext): AdminResource[] {
    return options.resources.filter((r) => r.can(ctx, "view"));
  }

  const canSettings = (ctx: ZenContext) => Boolean(options.settings && store) && allows(options.settings?.access ?? ["admin"], ctx);
  const canMedia = (ctx: ZenContext) => Boolean(mediaDir) && allows((options.media || undefined)?.access ?? ["admin"], ctx);
  const canSchema = (ctx: ZenContext) => schemaEditor && allows(["admin"], ctx);
  const audited = (r: AdminResource) => Boolean(store) && options.audit !== false && r.options.audit !== false;

  function nav(u: AdminUser | undefined): NavItem[] {
    if (!u) return [];
    const ctx = { state: { user: u } } as unknown as ZenContext;
    return visible(ctx).length || canSettings(ctx) ? [{ href: basePath, label: m().title, section: m().section }] : [];
  }

  /** Catat ke log audit; kegagalan log tidak membatalkan perubahan data. */
  async function record(
    ctx: ZenContext | undefined,
    r: AdminResource | string,
    entry: { recordId?: string | null; action: string; changes?: Record<string, [unknown, unknown]> | null; snapshot?: Record<string, unknown> | null },
  ): Promise<void> {
    const name = typeof r === "string" ? r : r.name;
    if (!store || options.audit === false || (typeof r !== "string" && r.options.audit === false)) return;
    try {
      await store.log(ctx, { ...entry, resource: name });
    } catch (err) {
      ctx?.logger.warn(`admin audit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Jalankan otomasi tanpa menahan respons. */
  function automate(r: AdminResource, event: AutomationEvent, row: Record<string, unknown>, ctx: ZenContext | undefined, changes?: Record<string, [unknown, unknown]>): void {
    if (!r.options.automations?.length) return;
    const p = runAutomations(r, event, row, ctx, changes).finally(() => pending.delete(p));
    pending.add(p);
  }

  function searchBox(ctx: ZenContext): Child {
    const q = ctx.path === url("_search") ? (str(ctx.query.q) ?? "") : "";
    return h(
      "form",
      { class: "zu-admin-search", method: "get", action: url("_search"), role: "search" },
      h("input", { class: "zu-input", type: "search", name: "q", value: q, "aria-label": x().searchAll, placeholder: x().searchPlaceholder, "data-zu-hotkey": "k", autocomplete: "off" }),
    );
  }

  /** Halaman lengkap: kerangka aplikasi (bila ada) + sub-navigasi tabel admin. */
  function layout(ctx: ZenContext, o: AdminLayoutOptions & { current?: string }, ...children: Child[]): string {
    const tabs = visible(ctx);
    const items = [{ href: basePath, label: m().dashboard }, ...tabs.map((r) => ({ href: url(r.name), label: r.label }))];
    if (store && options.audit !== false && tabs.some(audited)) items.push({ href: url("_log"), label: x().auditLog });
    if (canMedia(ctx)) items.push({ href: url("_media"), label: x().media });
    if (canSettings(ctx)) items.push({ href: url("_settings"), label: options.settings?.label ?? x().settings });
    const toast = h(Toast, { flash: takeFlash(ctx) });
    const bar = tabs.length ? searchBox(ctx) : null;
    if (options.layout) {
      const sub = items.length > 2 || o.current === undefined ? h(Tabs, { items, active: o.current ?? basePath, label: m().resources }) : null;
      return options.layout(ctx, { title: o.title, subtitle: o.subtitle, active: basePath, actions: o.actions }, toast, h("div", { class: "zu-admin-bar" }, sub, bar), ...children);
    }
    const u = ctx.state.user as AdminUser;
    const shellUser = { name: String(u.name ?? u.email ?? m().title), email: typeof u.email === "string" ? u.email : undefined, role: typeof u.role === "string" ? u.role : undefined };
    return page(
      { title: `${o.title} · ${options.appName ?? m().title}` },
      h(AppShell, { appName: options.appName, nav: items, active: o.current ?? basePath, user: shellUser, title: o.title, subtitle: o.subtitle, actions: o.actions }, toast, bar, children),
    );
  }

  // ── Tampilan nilai ─────────────────────────────────────────────────────────

  function display(r: AdminResource, f: AdminField, row: Record<string, unknown>, labels?: Map<string, Map<string, string>>): Child {
    const v = row[f.name];
    if (r.publishing && f.name === r.publishing.field) {
      const state = r.publishState(row);
      if (state) return h(Badge, { tone: state === "published" ? "ok" : state === "scheduled" ? "accent" : undefined }, x().publish[state]);
    }
    if (v === null || v === undefined || v === "") return h("span", { class: "zu-muted" }, "–");
    switch (f.type) {
      case "boolean":
        return v ? h(Badge, { tone: "ok" }, m().yes) : h(Badge, null, m().no);
      case "enum":
        return h(Badge, { tone: "accent" }, String(v));
      case "date":
        return formatDate(v as Date | string);
      case "datetime":
        return new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(v as Date | string));
      case "number":
        return typeof v === "number" ? formatNumber(v) : String(v);
      case "image":
        return h("img", { class: "zu-admin-thumb", src: String(v), alt: f.label, loading: "lazy" });
      case "file":
        return h("a", { href: String(v), target: "_blank", rel: "noopener" }, truncate(String(v).split("/").pop() ?? String(v), 40));
      case "email":
        return h("a", { href: `mailto:${String(v)}` }, String(v));
      case "url":
        return /^https?:\/\//i.test(String(v)) ? h("a", { href: String(v), target: "_blank", rel: "noopener noreferrer" }, truncate(String(v), 40)) : String(v);
      case "relation": {
        const label = labels?.get(f.name)?.get(String(v)) ?? `#${String(v)}`;
        const target = r.relation(f.name);
        const res = target ? options.resources.find((x) => x.table === target.table) : undefined;
        return res ? h("a", { href: url(res.name, String(v)) }, label) : label;
      }
      case "json":
        return h("code", null, truncate(JSON.stringify(v), 60));
      default:
        return truncate(String(v));
    }
  }

  /** Nilai sebagai teks biasa (riwayat, cetak). */
  function plainValue(r: AdminResource, f: AdminField | undefined, v: unknown): string {
    if (v === null || v === undefined || v === "") return "–";
    const type = f?.type;
    if (type === "boolean") return v ? m().yes : m().no;
    if ((type === "date" || type === "datetime") && (typeof v === "string" || v instanceof Date || typeof v === "number")) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return type === "date" ? formatDate(d) : new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(d);
    }
    if (typeof v === "object") return truncate(JSON.stringify(v), 120);
    return truncate(String(v), 160);
  }

  function inlineCell(r: AdminResource, f: AdminField, row: Record<string, unknown>, error?: string, value?: unknown): Child {
    const current = value === undefined ? row[f.name] : value;
    const common = { action: url(r.name, r.idOf(row), "field", f.name), name: f.name, label: `${f.label} ${r.titleOf(row)}`, error };
    if (f.type === "boolean") return h(InlineEdit, { ...common, type: "switch", value: Boolean(current) });
    const opts = [...(r.column(f.name).notNull ? [] : [{ value: "", label: "–" }]), ...(f.options ?? []).map((o) => ({ value: o, label: o }))];
    return h(InlineEdit, { ...common, type: "select", value: current === null || current === undefined ? "" : String(current), options: opts });
  }

  // ── Daftar ─────────────────────────────────────────────────────────────────

  function listQuery(ctx: ZenContext): ListQuery {
    const filters: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.query)) if (k.startsWith("f_")) filters[k] = str(v) ?? "";
    const dir = str(ctx.query.dir);
    return {
      q: str(ctx.query.q),
      sort: str(ctx.query.sort),
      dir: dir === "desc" ? "desc" : dir === "asc" ? "asc" : undefined,
      page: Number(str(ctx.query.page) ?? 1),
      filters,
      trash: str(ctx.query.trash) === "1" || undefined,
    };
  }

  /** URL daftar dengan query sekarang, ditimpa `change` (nilai kosong = dihapus). */
  function listUrl(r: AdminResource, q: ListQuery, change: Record<string, string | undefined>): string {
    const params = new URLSearchParams();
    const merged: Record<string, string | undefined> = { q: q.q, sort: q.sort, dir: q.dir, page: q.page && q.page > 1 ? String(q.page) : undefined, trash: q.trash ? "1" : undefined, ...q.filters, ...change };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "") params.set(k, v);
    const s = params.toString().replace(/%7B(key|dir|page)%7D/g, "{$1}");
    return url(r.name) + (s ? `?${s}` : "");
  }

  function filterBar(r: AdminResource, q: ListQuery): Child {
    const searchable = r.fields.filter((f) => f.search);
    const controls: Child[] = [];
    if (searchable.length || r.info.columns.find((c) => c.key === r.pk)?.dataType === "number") {
      controls.push(
        h(Field, { name: "q", label: m().searchIn(searchable.map((f) => f.label).join(", ") || "ID"), type: "search", value: q.q ?? "", placeholder: t().ui.searchPlaceholder }),
      );
    }
    for (const f of r.fields.filter((x) => x.filter)) {
      const key = `f_${f.name}`;
      if (f.type === "boolean") {
        controls.push(h(Select, { name: key, label: f.label, value: q.filters[key] ?? "", options: [{ value: "", label: m().all }, { value: "1", label: m().yes }, { value: "0", label: m().no }] }));
      } else if (f.type === "enum") {
        controls.push(h(Select, { name: key, label: f.label, value: q.filters[key] ?? "", options: [{ value: "", label: m().all }, ...(f.options ?? []).map((o) => ({ value: o, label: o }))] }));
      } else if (f.type === "date" || f.type === "datetime" || f.type === "number") {
        const type = f.type === "number" ? "number" : "date";
        controls.push(h(Field, { name: `${key}_from`, label: m().from(f.label), type, value: q.filters[`${key}_from`] ?? "" }));
        controls.push(h(Field, { name: `${key}_to`, label: m().to(f.label), type, value: q.filters[`${key}_to`] ?? "" }));
      }
      // Filter relasi dibaca dari URL (?f_userId=3, mis. dari tautan di halaman lain) tanpa kontrol sendiri.
    }
    if (!controls.length) return null;
    const hidden = [
      q.sort ? h("input", { type: "hidden", name: "sort", value: q.sort }) : null,
      q.dir ? h("input", { type: "hidden", name: "dir", value: q.dir }) : null,
      q.trash ? h("input", { type: "hidden", name: "trash", value: "1" }) : null,
    ];
    for (const f of r.fields.filter((x) => x.type === "relation")) {
      const v = q.filters[`f_${f.name}`];
      if (v) hidden.push(h("input", { type: "hidden", name: `f_${f.name}`, value: v }));
    }
    const filters = h(
      "form",
      {
        class: "zu-admin-filters",
        method: "get",
        action: url(r.name),
        role: "search",
        "hx-get": url(r.name),
        "hx-target": `#${RESULTS}`,
        "hx-swap": "outerHTML",
        "hx-push-url": "true",
        "hx-trigger": "change, input changed delay:300ms from:find input[type=search], search from:find input[type=search], submit",
      },
      hidden,
      controls,
      h("div", { class: "zu-admin-filter-actions" }, h(Button, { variant: "secondary", small: true }, m().filter), h("a", { class: "zu-link", href: url(r.name) }, m().reset)),
    );
    // Filter dengan kalimat: formulir biasa (tanpa htmx) yang diarahkan ke URL filter hasil terjemahannya.
    const nl = r.fields.some((f) => f.filter || f.sort)
      ? h(
          "form",
          { class: "zu-admin-nl", method: "get", action: url(r.name) },
          h(Field, { name: "nl", label: x().nlLabel, placeholder: x().nlPlaceholder, value: "" }),
          h(Button, { variant: "ghost", small: true }, x().nlApply),
        )
      : null;
    return h(Stack, { gap: "sm" }, filters, nl);
  }

  /** Pilihan aksi massal yang boleh dipakai pengguna ini: [nilai, label]. */
  function bulkChoices(ctx: ZenContext, r: AdminResource, trash: boolean): [string, string][] {
    const out: [string, string][] = [];
    if (trash) {
      if (r.can(ctx, "delete")) out.push(["restore", x().restore], ["destroy", x().destroy]);
      return out;
    }
    if (r.can(ctx, "update")) {
      for (const f of r.fields.filter((x) => x.inline && x.form !== false && !x.readonly)) {
        if (f.type === "boolean") out.push([`set:${f.name}:1`, x().bulkSet(f.label, m().yes)], [`set:${f.name}:0`, x().bulkSet(f.label, m().no)]);
        else for (const o of f.options ?? []) out.push([`set:${f.name}:${o}`, x().bulkSet(f.label, o)]);
      }
    }
    for (const a of r.actionsFor(ctx, true)) out.push([`action:${a.name}`, a.label]);
    if (r.can(ctx, "delete")) out.push(["delete", m().delete]);
    out.push(["export", x().exportCsv]);
    return out;
  }

  function results(ctx: ZenContext, r: AdminResource, q: ListQuery, res: ListResult, many: Map<string, Map<string, string[]>>, note?: Child): Child {
    const canUpdate = r.can(ctx, "update") && !q.trash;
    const canDelete = r.can(ctx, "delete");
    const fields = r.listFields;
    const hx = { target: `#${RESULTS}`, swap: "outerHTML", pushUrl: true };
    const choices = res.rows.length ? bulkChoices(ctx, r, Boolean(q.trash)) : [];
    const selectable = choices.length > 1 || (choices.length === 1 && choices[0]![0] !== "export");
    const manyCols = r.many.filter((x) => x.list);
    const columns = [
      ...(selectable ? [{ key: "_select", label: x().selectColumn }] : []),
      ...fields.map((f) => ({ key: f.name, label: f.label, sortable: Boolean(f.sort), align: f.type === "number" && f.name !== r.pk ? ("num" as const) : undefined })),
      ...manyCols.map((rel) => ({ key: `m_${rel.name}`, label: rel.label })),
      { key: "_actions", label: m().actions, align: "end" as const },
    ];
    const rows = res.rows.map((row) => [
      ...(selectable ? [h("input", { type: "checkbox", class: "zu-admin-select", name: "ids", value: r.idOf(row), form: BULK, "aria-label": x().selectRow(r.titleOf(row)) })] : []),
      ...fields.map((f, i) => {
        if (canUpdate && f.inline && (f.type === "boolean" || f.type === "enum")) return inlineCell(r, f, row);
        const value = display(r, f, row, res.labels);
        // Kolom judul (atau kolom pertama) menjadi tautan ke halaman ubah.
        // Tautan tidak boleh bersarang: isi sel yang sudah berupa tautan (email, url, relasi, file) ditampilkan sebagai teks.
        const isTitle = f.name === r.titleField || (i === 0 && !fields.some((x) => x.name === r.titleField));
        if (!isTitle) return value;
        const text = ["email", "url", "file", "relation"].includes(f.type) && row[f.name] != null ? (f.type === "relation" ? r.titleOf(row) : String(row[f.name])) : value;
        return h("a", { href: url(r.name, r.idOf(row)) }, text);
      }),
      ...manyCols.map((rel) => {
        const labels = many.get(rel.name)?.get(r.idOf(row)) ?? [];
        if (!labels.length) return h("span", { class: "zu-muted" }, "–");
        return h("span", { class: "zu-admin-tags" }, labels.slice(0, 3).map((l) => h(Tag, null, truncate(l, 24))), labels.length > 3 ? h("span", { class: "zu-muted" }, `+${labels.length - 3}`) : null);
      }),
      h(
        "div",
        { class: "zu-admin-row-actions" },
        q.trash
          ? canDelete
            ? h(PostButton, { action: url(r.name, r.idOf(row), "restore"), variant: "ghost" }, x().restore)
            : null
          : h(Button, { href: url(r.name, r.idOf(row)), variant: "ghost", small: true }, canUpdate ? m().open : m().view),
        canDelete
          ? q.trash
            ? h(PostButton, { action: url(r.name, r.idOf(row), "destroy"), confirm: x().destroyConfirm(r.titleOf(row)), variant: "ghost" }, x().destroy)
            : h(PostButton, { action: url(r.name, r.idOf(row), "delete"), confirm: r.softDeleteKey ? x().trashConfirm(r.titleOf(row)) : m().deleteConfirm(r.titleOf(row)), variant: "ghost" }, m().delete)
          : null,
      ),
    ]);
    const filtered = Boolean(q.q) || Object.values(q.filters).some((v) => v !== "");
    const empty = q.trash
      ? h(EmptyState, { title: x().trashEmpty, action: h(Button, { href: url(r.name), variant: "secondary", small: true }, x().backToList) })
      : filtered
        ? h(EmptyState, { title: m().noMatch, text: m().noMatchHint, action: h(Button, { href: url(r.name), variant: "secondary", small: true }, m().reset) })
        : h(EmptyState, { title: m().noRows(r.label), text: m().noRowsHint, action: r.can(ctx, "create") ? h(Button, { href: url(r.name, "new"), small: true }, m().add(r.singular)) : undefined });
    const bulk = selectable
      ? h(
          "form",
          { class: "zu-admin-bulkbar", id: BULK, method: "post", action: url(r.name, "_bulk") },
          q.trash ? h("input", { type: "hidden", name: "trash", value: "1" }) : null,
          h("label", { class: "zu-check zu-admin-checkall", hidden: true }, h("input", { type: "checkbox", "data-zu-checkall": BULK }), h("span", null, x().selectAll)),
          h(Select, { name: "bulk", label: x().bulkLabel, value: "", placeholder: "", options: choices.map(([value, label]) => ({ value, label })) }),
          h(Button, { variant: "secondary", small: true }, x().bulkRun),
        )
      : null;
    return h(
      "div",
      { id: RESULTS, class: "zu-results zu-admin-results" },
      note,
      h("p", { class: "zu-admin-count", role: "status" }, m().count(formatNumber(res.total))),
      bulk,
      h(
        Card,
        { flush: true },
        h(DataTable, { columns, rows, sort: { key: res.sort.field, dir: res.sort.dir }, sortHref: listUrl(r, q, { sort: "{key}", dir: "{dir}", page: undefined }), empty, caption: r.label, hx }),
      ),
      h(Pagination, { page: res.page, pages: res.pages, href: listUrl(r, q, { page: "{page}" }), hx }),
    );
  }

  function listActions(ctx: ZenContext, r: AdminResource, q: ListQuery): Child {
    const items: MenuItem[] = [{ label: x().exportCsv, href: url(r.name, "_export") + (listUrl(r, q, {}).split("?")[1] ? `?${listUrl(r, q, {}).split("?")[1]}` : "") }];
    if (r.can(ctx, "create") || r.can(ctx, "update")) items.push({ label: x().importData, href: url(r.name, "_import") });
    if (r.softDeleteKey && r.can(ctx, "delete")) items.push(q.trash ? { label: x().backToList, href: url(r.name) } : { label: x().trash, href: `${url(r.name)}?trash=1` });
    return h(
      Cluster,
      { gap: "sm" },
      h(DropdownMenu, { label: x().moreActions, items, align: "end" }),
      r.can(ctx, "create") && !q.trash ? h(Button, { href: url(r.name, "new") }, m().add(r.singular)) : null,
    );
  }

  async function listPage(ctx: ZenContext, r: AdminResource): Promise<ZenResponse> {
    const q = listQuery(ctx);
    const sentence = str(ctx.query.nl)?.trim();
    if (sentence) {
      // Kalimat -> filter biasa, lalu diarahkan ke URL filter itu (bisa dibagikan dan diubah lewat bilah filter).
      // Kolom angka dan tanggal selalu bisa difilter lewat URL, jadi ikut dipahami walau tanpa kontrol filter.
      const fields = r.fields.map((f) => (["number", "date", "datetime"].includes(f.type) && f.name !== r.pk ? { ...f, filter: true } : f));
      const parsed = parseNlFilter(sentence, fields, { locale: getLocale(), label: r.label });
      const next: ListQuery = { filters: { ...parsed.query.filters }, q: parsed.query.q, sort: parsed.query.sort, dir: parsed.query.dir, trash: q.trash };
      const said = [parsed.understood.length ? x().nlUnderstood(parsed.understood.join(", ")) : x().nlNothing, parsed.understood.length && parsed.rest ? x().nlRest(parsed.rest) : ""].filter(Boolean).join(" ");
      flash(ctx, said, "info");
      return hxRedirect(ctx, listUrl(r, next, {}));
    }
    const res = await r.list(q);
    const many = await r.manyLabels(res.rows);
    // URL yang dicatat di riwayat dibersihkan dari parameter kosong (formulir filter mengirim semua kolom).
    if (htmxTarget(ctx) === RESULTS) return fragment(renderToString(results(ctx, r, q, res, many)), { ...HEADERS, "HX-Push-Url": listUrl(r, q, {}) });
    const title = q.trash ? x().trashTitle(r.label) : r.label;
    return respond(
      layout(ctx, { title, subtitle: m().count(formatNumber(res.total)), active: basePath, current: url(r.name), actions: listActions(ctx, r, q) }, h(Stack, { gap: "md" }, filterBar(r, q), results(ctx, r, q, res, many))),
    );
  }

  // ── Formulir ───────────────────────────────────────────────────────────────

  async function formControl(r: AdminResource, f: AdminField, row: Record<string, unknown> | undefined, raw: Record<string, string> | undefined, error: string | undefined): Promise<Child> {
    const value = raw && f.name in raw && f.type !== "boolean" ? raw[f.name] : inputValue(f, row?.[f.name]);
    const common = { name: f.name, label: f.label, error, hint: f.hint, required: f.required, disabled: f.readonly };
    switch (f.type) {
      case "boolean":
        return h(Switch, { name: f.name, label: f.label, hint: f.hint, checked: raw && f.name in raw ? raw[f.name] !== "" && raw[f.name] !== "0" : Boolean(row?.[f.name] ?? r.column(f.name).default === true), disabled: f.readonly });
      case "enum":
        return h(Select, { ...common, value, placeholder: f.required ? undefined : "", options: (f.options ?? []).map((o) => ({ value: o, label: o })) });
      case "textarea":
        return h(Field, { ...common, type: "textarea", rows: 6, value });
      case "json":
        return h(Field, { ...common, type: "textarea", rows: 8, value });
      case "number":
        return h(Field, { ...common, type: "number", step: r.info.columns.find((c) => c.key === f.name)?.integer ? 1 : "any", value });
      case "date":
        return h(Field, { ...common, type: "date", value });
      case "datetime":
        return h(Field, { ...common, type: "datetime-local", value, hint: f.hint ?? (r.publishing?.at === f.name ? x().publishAtHint : undefined) });
      case "email":
        return h(Field, { ...common, type: "email", value, autocomplete: "off" });
      case "url":
        return h(Field, { ...common, type: "url", value });
      case "image":
      case "file": {
        const current = row?.[f.name];
        return h(FileInput, {
          name: f.name,
          label: f.label,
          types: f.types ?? (f.type === "image" ? ["image/*"] : undefined),
          maxBytes: f.maxBytes ?? "5mb",
          preview: f.type === "image" && current ? String(current) : undefined,
          required: f.required && !current,
          error,
          hint: current ? m().keepFile : f.hint,
          disabled: f.readonly,
        });
      }
      case "relation": {
        const selected = value || undefined;
        const found = await r.relationOptions(f.name, undefined, selected);
        return h(Combobox, {
          name: f.name,
          label: f.label,
          source: url(r.name, "_options", f.name),
          value: selected ?? null,
          selected: found.selected,
          options: found.options,
          required: f.required,
          error,
          hint: f.hint,
        });
      }
      default:
        return h(Field, { ...common, value, maxlength: f.group === "seo" && /title/i.test(f.name) ? 70 : f.group === "seo" && /description/i.test(f.name) ? 200 : undefined });
    }
  }

  type FormState = { raw: Record<string, string>; errors: Record<string, string>; message?: string; many?: Record<string, string[]> };

  async function editForm(ctx: ZenContext, r: AdminResource, row: Record<string, unknown> | undefined, state?: FormState): Promise<Child> {
    const id = "zu-admin-form";
    const action = row ? url(r.name, r.idOf(row)) : url(r.name);
    const fields = r.formFields;
    const control = (f: AdminField) => formControl(r, f, row, state?.raw, state?.errors[f.name]);
    const controls: Child[] = [];
    for (const f of fields) {
      if (f.group === "seo" || (f.translationOf && fields.some((s) => s.name === f.translationOf))) continue;
      const translation = fields.find((t) => t.translationOf === f.name);
      if (translation) controls.push(h(Columns, { cols: 2 }, await control(f), await control(translation)));
      else controls.push(await control(f));
    }
    for (const rel of r.many) {
      const values = state?.many?.[rel.name] ?? (row ? await r.manyValues(rel.name, r.parseId(r.idOf(row))!) : []);
      controls.push(
        h("input", { type: "hidden", name: `m_${rel.name}`, value: "" }),
        h(CheckboxGroup, { name: `m_${rel.name}`, label: rel.label, inline: true, options: await r.manyOptions(rel.name), values }),
      );
    }
    const seo = fields.filter((f) => f.group === "seo");
    if (seo.length) {
      const seoControls: Child[] = [];
      for (const f of seo) seoControls.push(await control(f));
      controls.push(h(Fieldset, { legend: x().seo, hint: x().seoLead, box: true }, seoControls));
    }
    const hasErrors = state && (Object.keys(state.errors).length || state.message);
    return h(
      Form,
      { action, upload: r.hasFiles, id, hx: { target: "this", swap: "outerHTML" } },
      hasErrors ? h(Alert, { tone: "error" }, state!.message ?? m().errors.form) : null,
      controls,
      h(FormActions, null, h(Button, { loading: m().saving }, m().save), h(Button, { href: url(r.name), variant: "ghost" }, m().cancel)),
    );
  }

  async function sidePanel(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>, labels: Map<string, Map<string, string>>): Promise<Child> {
    const id = r.idOf(row);
    const items = r.fields.filter((f) => f.form === false || f.readonly).map((f) => ({ label: f.label, value: display(r, f, row, labels) }));
    const buttons: Child[] = [];
    if (r.options.previewUrl) buttons.push(h(Button, { href: r.options.previewUrl(row), variant: "secondary", small: true }, x().preview));
    if (audited(r)) buttons.push(h(Button, { href: url(r.name, id, "history"), variant: "secondary", small: true }, x().history));
    buttons.push(h(Button, { href: url(r.name, id, "print"), variant: "secondary", small: true }, x().print));
    for (const a of r.actionsFor(ctx)) buttons.push(h(PostButton, { action: url(r.name, id, "action", a.name), confirm: a.confirm, variant: "secondary" }, a.label));
    if (r.can(ctx, "delete")) buttons.push(h(PostButton, { action: url(r.name, id, "delete"), confirm: r.softDeleteKey ? x().trashConfirm(r.titleOf(row)) : m().deleteConfirm(r.titleOf(row)) }, m().delete));
    const wf = r.options.workflow;
    const transitions = r.transitionsFor(ctx, row);
    const workflow = wf
      ? h(
          Stack,
          { gap: "sm" },
          h("p", { class: "zu-admin-status" }, x().statusNow(String(row[wf.field] ?? "–"))),
          transitions.length ? h(Cluster, { gap: "sm" }, transitions.map((tr) => h(PostButton, { action: url(r.name, id, "transition", tr.to), variant: "primary" }, tr.label ?? x().moveTo(tr.to)))) : null,
        )
      : null;
    const cards: Child[] = [h(Card, { title: m().info }, h(Stack, { gap: "md" }, workflow, items.length ? h(DescriptionList, { items }) : null, h(Cluster, { gap: "sm" }, buttons)))];
    if (store) cards.push(await notesCard(ctx, r, row));
    return h(Stack, { gap: "md" }, cards);
  }

  async function notesCard(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>): Promise<Child> {
    const notes = await store!.notes(r.name, r.idOf(row));
    const form = r.can(ctx, "update")
      ? h(Form, { action: url(r.name, r.idOf(row), "notes") }, h(Field, { name: "body", label: x().note, type: "textarea", rows: 3, required: true }), h(Button, { variant: "secondary", small: true }, x().addNote))
      : null;
    return h(
      Card,
      { title: x().notes },
      h(
        Stack,
        { gap: "md" },
        h("p", { class: "zu-muted zu-admin-small" }, x().notesHint),
        notes.length
          ? h(
              Timeline,
              { items: notes.map((n) => ({ title: n.userName ?? x().system, time: new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(n.at), text: h("p", { class: "zu-admin-note" }, n.body) })) },
            )
          : h("p", { class: "zu-muted" }, x().noNotes),
        form,
      ),
    );
  }

  /** Data anak: tabel lain di panel yang merujuk tabel ini lewat foreign key. */
  async function childCards(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>): Promise<Child[]> {
    if (r.options.children === false) return [];
    const out: Child[] = [];
    for (const c of visible(ctx)) {
      if (c === r) continue;
      for (const f of c.fields.filter((x) => x.type === "relation")) {
        const rel = c.relation(f.name);
        if (!rel || rel.table !== r.table) continue;
        const filters = { [`f_${f.name}`]: r.idOf(row) };
        const res = await c.list({ filters, page: 1 });
        // Kolom judul dulu (walau tidak tampil di daftar, mis. isi komentar), lalu kolom daftar lain.
        const title = c.field(c.titleField);
        const shown = [...(title && title.name !== f.name ? [title] : []), ...c.listFields.filter((x) => x.name !== f.name && x.name !== c.titleField && x.name !== c.pk)].slice(0, 4);
        const columns = shown.map((x) => ({ key: x.name, label: x.label, align: x.type === "number" && x.name !== c.pk ? ("num" as const) : undefined }));
        const rows = res.rows.map((cr) => shown.map((x, i) => (i === 0 ? h("a", { href: url(c.name, c.idOf(cr)) }, x.type === "relation" ? c.titleOf(cr) : display(c, x, cr, res.labels)) : display(c, x, cr, res.labels))));
        const query = new URLSearchParams(filters).toString();
        const actions = h(
          Cluster,
          { gap: "sm" },
          res.total > res.rows.length ? h(Button, { href: `${url(c.name)}?${query}`, variant: "secondary", small: true }, `${m().viewAll} (${formatNumber(res.total)})`) : null,
          c.can(ctx, "create") ? h(Button, { href: `${url(c.name, "new")}?${query}`, variant: "secondary", small: true }, m().add(c.singular)) : null,
        );
        out.push(h(Card, { title: shown.length ? x().children(c.label) : c.label, flush: true, actions }, h(DataTable, { columns, rows, empty: h(EmptyState, { title: m().noRows(c.label) }), caption: c.label })));
      }
    }
    return out;
  }

  async function formPage(ctx: ZenContext, r: AdminResource, row: Record<string, unknown> | undefined, state?: FormState, status = 200): Promise<ZenResponse> {
    if (row && r.isDeleted(row)) return trashedPage(ctx, r, row);
    if (!row && !state) {
      // Isian awal dari URL, mis. /admin/order-items/new?f_orderId=3 dari halaman induk.
      const raw: Record<string, string> = {};
      for (const f of r.formFields) {
        const v = str(ctx.query[`f_${f.name}`]);
        if (v !== undefined) raw[f.name] = v;
      }
      if (Object.keys(raw).length) state = { raw, errors: {} };
    }
    const form = await editForm(ctx, r, row, state);
    if (status !== 200 && isHtmx(ctx)) return fragment(renderToString(form), HEADERS, status);
    const canEdit = !row || r.can(ctx, "update");
    const title = row ? (canEdit ? m().editOf(r.titleOf(row)) : r.titleOf(row)) : m().newTitle(r.singular);
    const labels = row ? await r.relationLabels([row]) : new Map();
    let body: Child;
    if (!row) body = h(Card, null, form);
    else {
      const main = canEdit ? h(Card, null, form) : h(Card, null, h(DescriptionList, { items: r.fields.map((f) => ({ label: f.label, value: display(r, f, row, labels) })) }));
      body = h(Split, null, h(Stack, { gap: "md" }, main, ...(await childCards(ctx, r, row))), await sidePanel(ctx, r, row, labels));
    }
    return respond(layout(ctx, { title, subtitle: r.label, active: basePath, current: url(r.name) }, body), status);
  }

  async function trashedPage(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>): Promise<ZenResponse> {
    const labels = await r.relationLabels([row]);
    const id = r.idOf(row);
    const buttons = r.can(ctx, "delete")
      ? h(
          Cluster,
          { gap: "sm" },
          h(PostButton, { action: url(r.name, id, "restore"), variant: "primary" }, x().restore),
          h(PostButton, { action: url(r.name, id, "destroy"), confirm: x().destroyConfirm(r.titleOf(row)) }, x().destroy),
        )
      : null;
    const body = h(
      Stack,
      { gap: "md" },
      h(Alert, { tone: "warn" }, x().inTrash),
      buttons,
      h(Card, null, h(DescriptionList, { items: r.fields.map((f) => ({ label: f.label, value: display(r, f, row, labels) })) })),
    );
    return respond(layout(ctx, { title: r.titleOf(row), subtitle: x().trashTitle(r.label), active: basePath, current: url(r.name) }, body));
  }

  /** Isi otomatis sebelum simpan: slug dari judul dan waktu terbit. */
  async function autofill(r: AdminResource, values: Record<string, unknown>, row: Record<string, unknown> | undefined): Promise<void> {
    for (const f of r.formFields.filter((x) => x.slugFrom)) {
      const current = values[f.name] ?? row?.[f.name];
      if (current !== undefined && current !== null && current !== "") continue;
      const source = values[f.slugFrom!] ?? row?.[f.slugFrom!];
      if (source !== undefined && source !== null && source !== "") values[f.name] = await r.uniqueSlug(f.name, String(source), row ? r.parseId(r.idOf(row)) : undefined);
    }
    const p = r.publishing;
    if (p?.at && values[p.field] === p.published) {
      const at = values[p.at] ?? row?.[p.at];
      if (at === undefined || at === null || at === "") values[p.at] = r.nowFor(p.at);
    }
  }

  /** Simpan satu data (formulir, impor): beforeSave, isi otomatis, many-to-many, log, otomasi. */
  async function persist(ctx: ZenContext, r: AdminResource, row: Record<string, unknown> | undefined, values: Record<string, unknown>, many?: Record<string, string[]>, action: "create" | "update" | "import" = row ? "update" : "create"): Promise<Record<string, unknown>> {
    await r.options.beforeSave?.(values, ctx, row);
    await autofill(r, values, row);
    const saved = row ? ((await r.update(r.parseId(r.idOf(row))!, values)) ?? row) : await r.insert(values);
    const id = r.parseId(r.idOf(saved))!;
    const changes = r.diff(row, saved);
    for (const [name, ids] of Object.entries(many ?? {})) {
      const before = row ? await r.manyValues(name, id) : [];
      await r.setMany(name, id, ids);
      const after = [...new Set(ids.filter((v) => v !== ""))];
      if (before.slice().sort().join(",") !== after.slice().sort().join(",")) changes[name] = [before, after];
    }
    if (!row || Object.keys(changes).length) await record(ctx, r, { recordId: r.idOf(saved), action, changes: row ? changes : null, snapshot: r.snapshotOf(saved) });
    automate(r, row ? "update" : "create", saved, ctx, changes);
    return saved;
  }

  function manyFromForm(r: AdminResource, form: FormData): Record<string, string[]> | undefined {
    if (!r.many.length) return undefined;
    const out: Record<string, string[]> = {};
    for (const rel of r.many) if (form.has(`m_${rel.name}`)) out[rel.name] = form.getAll(`m_${rel.name}`).filter((v): v is string => typeof v === "string" && v !== "");
    return out;
  }

  async function save(ctx: ZenContext, r: AdminResource, row: Record<string, unknown> | undefined): Promise<ZenResponse> {
    const form = await readForm(ctx, { maxBytes: r.hasFiles ? "20mb" : "1mb" });
    const parsed = await parseForm(r, form, row);
    const many = manyFromForm(r, form);
    if (Object.keys(parsed.errors).length) return formPage(ctx, r, row, { ...parsed, many }, 422);
    try {
      await persist(ctx, r, row, parsed.values, many);
      flash(ctx, row ? m().updated(r.singular) : m().created(r.singular));
      return hxRedirect(ctx, url(r.name));
    } catch (err) {
      const friendly = r.friendlyError(err);
      if (!friendly) throw err;
      const errors = friendly.field ? { [friendly.field]: friendly.message } : {};
      return formPage(ctx, r, row, { raw: parsed.raw, errors, message: friendly.field ? undefined : friendly.message, many }, 422);
    }
  }

  async function saveField(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>, f: AdminField): Promise<ZenResponse> {
    const form = await readForm(ctx, { maxBytes: "1mb" });
    const parsed = await parseField(r, f, lastValue(form, f.name), row);
    // Tanpa JavaScript (tombol Simpan di <noscript>): kembali ke daftar dengan pesan.
    const reply = (cell: Child, status: number, message: string, tone: "success" | "error") => {
      if (isHtmx(ctx)) return fragment(renderToString(cell), HEADERS, status);
      flash(ctx, message, tone);
      return hxRedirect(ctx, url(r.name));
    };
    if (parsed.error) return reply(inlineCell(r, f, row, parsed.error, parsed.raw), 422, `${f.label}: ${parsed.error}`, "error");
    try {
      let saved = row;
      if (parsed.value !== undefined) saved = await persist(ctx, r, row, { [f.name]: parsed.value });
      return reply(inlineCell(r, f, saved), 200, m().updated(r.singular), "success");
    } catch (err) {
      const friendly = r.friendlyError(err);
      if (!friendly) throw err;
      return reply(inlineCell(r, f, row, friendly.message), 422, friendly.message, "error");
    }
  }

  /** Hapus satu data (lunak bila bisa); mengembalikan jenis hapus atau pesan error. */
  async function removeOne(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>): Promise<"soft" | "hard"> {
    const kind = await r.remove(r.parseId(r.idOf(row))!);
    await record(ctx, r, { recordId: r.idOf(row), action: kind === "soft" ? "delete" : "destroy", snapshot: r.snapshotOf(row, true) });
    automate(r, "delete", row, ctx);
    return kind;
  }

  async function remove(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>): Promise<ZenResponse> {
    try {
      const kind = await removeOne(ctx, r, row);
      // Urungkan: data yang dihapus lunak dipulihkan; yang dihapus permanen dibuat lagi dari salinan di log audit.
      const undo = kind === "soft" || audited(r) ? { label: x().undo, action: url(r.name, r.idOf(row), "restore") } : undefined;
      flash(ctx, kind === "soft" ? x().trashed(r.singular) : m().deleted(r.singular), "success", undo);
    } catch (err) {
      const friendly = r.friendlyError(err);
      if (!friendly) throw err;
      flash(ctx, m().errors.inUse(r.singular), "error");
    }
    return hxRedirect(ctx, url(r.name));
  }

  async function restore(ctx: ZenContext, r: AdminResource, id: string | number, row: Record<string, unknown> | undefined): Promise<ZenResponse> {
    if (row && r.isDeleted(row)) {
      await r.restore(id);
      await record(ctx, r, { recordId: r.idOf(row), action: "restore", snapshot: r.snapshotOf({ ...row, [r.softDeleteKey!]: null }) });
    } else if (!row && store && audited(r)) {
      const last = (await store.history(r.name, String(id), 20)).find((e) => (e.action === "destroy" || e.action === "delete") && e.snapshot);
      if (!last) throw new HttpError(404, m().notFound, { expose: true });
      try {
        const saved = await r.insert(r.fromSnapshot(last.snapshot!, true));
        await record(ctx, r, { recordId: r.idOf(saved), action: "restore", snapshot: r.snapshotOf(saved) });
      } catch (err) {
        const friendly = r.friendlyError(err);
        if (!friendly) throw err;
        flash(ctx, friendly.message, "error");
        return hxRedirect(ctx, url(r.name));
      }
    } else if (!row) throw new HttpError(404, m().notFound, { expose: true });
    flash(ctx, x().restored(r.singular));
    return hxRedirect(ctx, url(r.name, id));
  }

  async function destroy(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>): Promise<ZenResponse> {
    try {
      await r.destroy(r.parseId(r.idOf(row))!);
      await record(ctx, r, { recordId: r.idOf(row), action: "destroy", snapshot: r.snapshotOf(row, true) });
      flash(ctx, x().destroyed(r.singular));
    } catch (err) {
      const friendly = r.friendlyError(err);
      if (!friendly) throw err;
      flash(ctx, m().errors.inUse(r.singular), "error");
    }
    return hxRedirect(ctx, r.softDeleteKey ? `${url(r.name)}?trash=1` : url(r.name));
  }

  async function optionsFor(ctx: ZenContext, r: AdminResource, fieldName: string): Promise<ZenResponse> {
    const f = r.field(fieldName);
    if (!f || f.type !== "relation") throw new HttpError(404);
    const selected = str(ctx.query[f.name]);
    const found = await r.relationOptions(f.name, str(ctx.query.q), selected);
    return fragment(renderToString(h(ComboboxOptions, { name: f.name, options: found.options, value: selected ?? null, selected: found.selected, allowEmpty: !f.required })), HEADERS);
  }

  // ── Riwayat dan log audit ──────────────────────────────────────────────────

  const when = (d: Date) => new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(d);

  function changesTable(r: AdminResource | undefined, changes: Record<string, [unknown, unknown]>): Child {
    const rows = Object.entries(changes).map(([k, [a, b]]) => {
      const f = r?.field(k);
      const label = f?.label ?? r?.manyOf(k)?.label ?? k;
      return [label, plainValue(r!, f, Array.isArray(a) ? a.join(", ") : a), plainValue(r!, f, Array.isArray(b) ? b.join(", ") : b)];
    });
    return h(Table, { columns: [x().field, x().before, x().after], rows });
  }

  function entryItem(r: AdminResource | undefined, e: LogEntry, revert?: string): { title: string; time: string; text?: Child; tone?: "accent" | "ok" | "warn" | "danger" } {
    const action = x().logActions[e.action] ?? e.action;
    const who = e.userName ?? x().system;
    const tone = e.action === "create" || e.action === "restore" ? "ok" : e.action === "delete" || e.action === "destroy" ? "danger" : "accent";
    const changes = e.changes && Object.keys(e.changes).length ? changesTable(r, e.changes) : null;
    const text = h(Stack, { gap: "sm" }, h("span", { class: "zu-muted" }, x().by(who)), changes, revert ? h(PostButton, { action: revert, confirm: x().revertConfirm, variant: "secondary" }, x().revert) : null);
    return { title: action, time: when(e.at), text, tone };
  }

  async function historyPage(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>): Promise<ZenResponse> {
    if (!store) throw new HttpError(404);
    const entries = await store.history(r.name, r.idOf(row));
    const canRevert = r.can(ctx, "update") && !r.isDeleted(row);
    const items = entries.map((e, i) => entryItem(r, e, canRevert && i > 0 && e.snapshot && e.action !== "delete" && e.action !== "destroy" ? url(r.name, r.idOf(row), "revert", e.id) : undefined));
    const body = h(
      Stack,
      { gap: "md" },
      h(Cluster, { gap: "sm" }, h(Button, { href: url(r.name, r.idOf(row)), variant: "secondary", small: true }, m().editOf(r.titleOf(row)))),
      h(Card, null, items.length ? h(Timeline, { items }) : h(EmptyState, { title: x().noHistory })),
    );
    return respond(layout(ctx, { title: x().historyOf(r.titleOf(row)), subtitle: r.label, active: basePath, current: url(r.name) }, body));
  }

  async function revert(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>, logId: string): Promise<ZenResponse> {
    const e = store && /^\d+$/.test(logId) ? await store.entry(Number(logId)) : undefined;
    if (!e || e.resource !== r.name || e.recordId !== r.idOf(row)) throw new HttpError(404);
    if (!e.snapshot) {
      flash(ctx, x().noSnapshot, "error");
      return hxRedirect(ctx, url(r.name, r.idOf(row), "history"));
    }
    // Hanya kolom yang ada di salinan dan bukan kolom rahasia atau kolom waktu hapus.
    const values = r.fromSnapshot(e.snapshot);
    delete values[r.softDeleteKey ?? ""];
    try {
      const saved = (await r.update(r.parseId(r.idOf(row))!, values)) ?? row;
      await record(ctx, r, { recordId: r.idOf(row), action: "revert", changes: r.diff(row, saved), snapshot: r.snapshotOf(saved) });
      automate(r, "update", saved, ctx, r.diff(row, saved));
      flash(ctx, x().reverted);
    } catch (err) {
      const friendly = r.friendlyError(err);
      if (!friendly) throw err;
      flash(ctx, friendly.message, "error");
    }
    return hxRedirect(ctx, url(r.name, r.idOf(row)));
  }

  async function auditPage(ctx: ZenContext): Promise<ZenResponse> {
    if (!store) throw new HttpError(404);
    const names = new Set(visible(ctx).filter(audited).map((r) => r.name));
    if (!names.size) throw new HttpError(403, m().forbidden, { expose: true });
    const only = str(ctx.query.resource);
    const pageNo = Math.max(1, Number(str(ctx.query.page) ?? 1) || 1);
    const per = 50;
    const entries = (await store.recent({ resource: only && names.has(only) ? only : undefined, limit: per * 4, offset: (pageNo - 1) * per * 4 })).filter((e) => names.has(e.resource)).slice(0, per);
    const rows = entries.map((e) => {
      const r = byName.get(e.resource);
      const link = r && e.recordId ? h("a", { href: url(r.name, e.recordId) }, `${r.singular} #${e.recordId}`) : `${e.resource} ${e.recordId ?? ""}`;
      const detail = e.changes && Object.keys(e.changes).length ? x().changedFields(Object.keys(e.changes).length) : "";
      return [when(e.at), e.userName ?? x().system, x().logActions[e.action] ?? e.action, link, detail];
    });
    const filter = h(
      "form",
      { method: "get", action: url("_log"), class: "zu-admin-filters" },
      h(Select, { name: "resource", label: x().record, value: only ?? "", options: [{ value: "", label: m().all }, ...[...names].map((n) => ({ value: n, label: byName.get(n)!.label }))] }),
      h("div", { class: "zu-admin-filter-actions" }, h(Button, { variant: "secondary", small: true }, m().filter)),
    );
    const more = entries.length === per ? h(Button, { href: `${url("_log")}?${new URLSearchParams({ ...(only ? { resource: only } : {}), page: String(pageNo + 1) })}`, variant: "secondary", small: true }, x().olderEntries) : null;
    const body = h(
      Stack,
      { gap: "md" },
      filter,
      h(Card, { flush: true }, h(DataTable, { columns: [{ key: "at", label: x().when }, { key: "who", label: t().admin.labels.user ?? "User" }, { key: "action", label: m().actions }, { key: "record", label: x().record }, { key: "detail", label: x().field }], rows, empty: h(EmptyState, { title: x().auditEmpty }), caption: x().auditLog })),
      more,
    );
    return respond(layout(ctx, { title: x().auditLog, subtitle: x().auditLead, active: basePath, current: url("_log") }, body));
  }

  // ── Catatan, cetak, transisi, aksi khusus ──────────────────────────────────

  async function addNote(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>): Promise<ZenResponse> {
    const form = await readForm(ctx, { maxBytes: "100kb" });
    const body = String(form.get("body") ?? "").replace(/\r\n/g, "\n").trim().slice(0, 5000);
    if (body) {
      await store!.addNote(ctx, r.name, r.idOf(row), body);
      flash(ctx, x().noteAdded);
    } else flash(ctx, m().errors.required, "error");
    return hxRedirect(ctx, url(r.name, r.idOf(row)));
  }

  async function printPage(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>): Promise<ZenResponse> {
    const labels = await r.relationLabels([row]);
    const many = await r.manyLabels([row]);
    const items = [
      ...r.fields.map((f) => ({ label: f.label, value: f.type === "image" && row[f.name] ? display(r, f, row, labels) : f.type === "relation" ? (labels.get(f.name)?.get(String(row[f.name])) ?? plainValue(r, f, row[f.name])) : plainValue(r, f, row[f.name]) })),
      ...r.many.map((rel) => ({ label: rel.label, value: (many.get(rel.name)?.get(r.idOf(row)) ?? []).join(", ") || "–" })),
    ];
    const body = h(
      "main",
      { class: "zu-admin-print" },
      h("div", { class: "zu-print-hide zu-admin-print-bar" }, h(Button, { href: url(r.name, r.idOf(row)), variant: "ghost", small: true }, x().backToList), h("button", { class: "zu-btn primary small", type: "button", "data-zu-print": "", hidden: true }, x().printNow)),
      h("header", null, h("p", { class: "zu-muted" }, r.singular), h("h1", null, r.titleOf(row))),
      h(DescriptionList, { items }),
      h("p", { class: "zu-muted zu-admin-small" }, x().printedAt(when(new Date()))),
    );
    return respond(page({ title: `${r.titleOf(row)} · ${r.singular}` }, body));
  }

  async function transition(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>, to: string): Promise<ZenResponse> {
    const wf = r.options.workflow;
    const tr = r.transitionsFor(ctx, row).find((x) => x.to === to);
    if (!wf) throw new HttpError(404);
    if (!tr) throw new HttpError(403, x().transitionDenied, { expose: true });
    const values: Record<string, unknown> = { [wf.field]: to };
    try {
      await r.options.beforeSave?.(values, ctx, row);
      await autofill(r, values, row);
      const saved = (await r.update(r.parseId(r.idOf(row))!, values)) ?? row;
      const changes = r.diff(row, saved);
      await record(ctx, r, { recordId: r.idOf(row), action: "transition", changes, snapshot: r.snapshotOf(saved) });
      automate(r, "update", saved, ctx, changes);
      flash(ctx, x().transitioned(tr.label ?? to));
    } catch (err) {
      const friendly = r.friendlyError(err);
      if (!friendly) throw err;
      flash(ctx, friendly.message, "error");
    }
    return hxRedirect(ctx, url(r.name, r.idOf(row)));
  }

  /** Jalankan aksi khusus untuk beberapa data; mengembalikan pesan untuk pengguna. */
  async function runAction(ctx: ZenContext, r: AdminResource, name: string, rows: Record<string, unknown>[]): Promise<string> {
    const a = r.actionsFor(ctx).find((x) => x.name === name);
    if (!a) throw new HttpError(403, m().forbidden, { expose: true });
    let message: string | void = undefined;
    if (a.run) message = await a.run(rows, ctx);
    if (a.job) {
      const { enqueue } = await import("../backend/jobs.js");
      await enqueue(a.job, { resource: r.name, ids: rows.map((row) => r.idOf(row)) });
    }
    for (const row of rows) await record(ctx, r, { recordId: r.idOf(row), action: "action", changes: { [a.label]: [null, a.job ?? a.name] } });
    return typeof message === "string" && message ? message : a.job && !a.run ? x().actionQueued(a.label) : x().actionDone(a.label);
  }

  async function customAction(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>, name: string): Promise<ZenResponse> {
    try {
      flash(ctx, await runAction(ctx, r, name, [row]));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const friendly = r.friendlyError(err);
      flash(ctx, friendly?.message ?? (err instanceof Error ? err.message : String(err)), "error");
    }
    return hxRedirect(ctx, url(r.name, r.idOf(row)));
  }

  // ── Aksi massal, ekspor, impor ─────────────────────────────────────────────

  function csvResponse(r: AdminResource, rows: Record<string, unknown>[]): ZenResponse {
    return new ZenResponse(exportCsv(r, rows), {
      headers: { ...HEADERS, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${exportName(r)}"` },
    });
  }

  async function exportList(ctx: ZenContext, r: AdminResource): Promise<ZenResponse> {
    const q = listQuery(ctx);
    return csvResponse(r, await r.all(q));
  }

  async function bulk(ctx: ZenContext, r: AdminResource): Promise<ZenResponse> {
    const form = await readForm(ctx, { maxBytes: "1mb" });
    const trash = form.get("trash") === "1";
    const choice = String(form.get("bulk") ?? "");
    const back = trash ? `${url(r.name)}?trash=1` : url(r.name);
    const ids = form
      .getAll("ids")
      .map((v) => r.parseId(String(v)))
      .filter((v): v is string | number => v !== undefined)
      .slice(0, 1000);
    const allowed = bulkChoices(ctx, r, trash);
    const picked = allowed.find(([v]) => v === choice);
    if (!ids.length || !picked) {
      flash(ctx, !ids.length ? x().bulkNone : x().bulkChoose, "error");
      return hxRedirect(ctx, back);
    }
    const rows = await r.all({ filters: {}, ids, trash });
    if (choice === "export") return csvResponse(r, rows);
    if (form.get("confirm") !== "1") {
      // Konfirmasi dengan jumlah dan daftar data sebelum aksi massal dijalankan.
      const shown = rows.slice(0, 20).map((row) => r.titleOf(row));
      const body = h(
        Card,
        null,
        h(
          Stack,
          { gap: "md" },
          h("p", null, x().bulkConfirmLead),
          h(List, { items: [...shown, ...(rows.length > shown.length ? [x().bulkMore(rows.length - shown.length)] : [])] }),
          h(
            "form",
            { method: "post", action: url(r.name, "_bulk") },
            rows.map((row) => h("input", { type: "hidden", name: "ids", value: r.idOf(row) })),
            h("input", { type: "hidden", name: "bulk", value: choice }),
            h("input", { type: "hidden", name: "confirm", value: "1" }),
            trash ? h("input", { type: "hidden", name: "trash", value: "1" }) : null,
            h(FormActions, null, h(Button, { variant: choice === "delete" || choice === "destroy" ? "danger" : "primary" }, x().bulkConfirm(rows.length)), h(Button, { href: back, variant: "ghost" }, m().cancel)),
          ),
        ),
      );
      return respond(layout(ctx, { title: x().bulkConfirmTitle(picked[1], rows.length), subtitle: r.label, active: basePath, current: url(r.name) }, body));
    }
    let done = 0;
    const failures: string[] = [];
    let message: string | undefined;
    if (choice.startsWith("action:")) {
      try {
        message = await runAction(ctx, r, choice.slice(7), rows);
        done = rows.length;
      } catch (err) {
        if (err instanceof HttpError) throw err;
        failures.push(err instanceof Error ? err.message : String(err));
      }
    } else {
      for (const row of rows) {
        try {
          const id = r.parseId(r.idOf(row))!;
          if (choice === "delete") await removeOne(ctx, r, row);
          else if (choice === "destroy") {
            await r.destroy(id);
            await record(ctx, r, { recordId: r.idOf(row), action: "destroy", snapshot: r.snapshotOf(row, true) });
          } else if (choice === "restore") {
            await r.restore(id);
            await record(ctx, r, { recordId: r.idOf(row), action: "restore" });
          } else if (choice.startsWith("set:")) {
            const [, name, ...rest] = choice.split(":");
            const f = r.field(name!)!;
            const parsed = await parseField(r, f, rest.join(":"), row);
            if (parsed.error) throw new Error(parsed.error);
            await persist(ctx, r, row, { [f.name]: parsed.value });
          }
          done++;
        } catch (err) {
          const friendly = r.friendlyError(err);
          failures.push(`${r.titleOf(row)}: ${friendly?.message ?? (err instanceof Error ? err.message : String(err))}`);
        }
      }
    }
    if (failures.length) flash(ctx, `${done ? `${x().bulkDone(done)} ` : ""}${x().bulkFailed(failures.length, failures[0]!)}`, "error");
    else flash(ctx, message ?? x().bulkDone(done));
    return hxRedirect(ctx, back);
  }

  function importPage(ctx: ZenContext, r: AdminResource, content: Child, status = 200): ZenResponse {
    return respond(layout(ctx, { title: x().importTitle(r.label), subtitle: r.label, active: basePath, current: url(r.name) }, content), status);
  }

  function uploadForm(r: AdminResource, error?: string): Child {
    return h(
      Card,
      null,
      h(
        Form,
        { action: url(r.name, "_import"), upload: true },
        h("p", null, x().importLead),
        h(FileInput, { name: "file", label: x().importFile, types: [".csv", ".xlsx", "text/csv"], maxBytes: "10mb", required: true, error }),
        h(FormActions, null, h(Button, null, x().importNext), h(Button, { href: url(r.name), variant: "ghost" }, m().cancel)),
      ),
    );
  }

  function hiddenTable(table: string[][], mapping?: Record<string, number>): Child[] {
    return [
      h("input", { type: "hidden", name: "data", value: Buffer.from(JSON.stringify(table)).toString("base64url") }),
      mapping ? h("input", { type: "hidden", name: "mapping", value: JSON.stringify(mapping) }) : null,
    ];
  }

  function readHidden(form: FormData): { table: string[][]; mapping?: Record<string, number> } | undefined {
    try {
      const table = JSON.parse(Buffer.from(String(form.get("data") ?? ""), "base64url").toString("utf8")) as unknown;
      if (!Array.isArray(table) || !table.every((row) => Array.isArray(row) && row.every((c) => typeof c === "string"))) return undefined;
      let mapping: Record<string, number> | undefined;
      if (form.has("mapping")) mapping = JSON.parse(String(form.get("mapping"))) as Record<string, number>;
      return { table: table as string[][], mapping };
    } catch {
      return undefined;
    }
  }

  async function importData(ctx: ZenContext, r: AdminResource): Promise<ZenResponse> {
    if (ctx.method !== "POST") return importPage(ctx, r, uploadForm(r));
    const form = await readForm(ctx, { maxBytes: "25mb" });
    const step = String(form.get("step") ?? "upload");
    const fields = importFields(r);

    if (step === "upload") {
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) return importPage(ctx, r, uploadForm(r, m().errors.required), 422);
      let table: string[][];
      try {
        table = await readTable(file);
      } catch {
        return importPage(ctx, r, uploadForm(r, x().importBadFile), 422);
      }
      if (table.length < 2) return importPage(ctx, r, uploadForm(r, x().importEmpty), 422);
      if (table.length - 1 > IMPORT_MAX_ROWS) return importPage(ctx, r, uploadForm(r, x().importTooMany(IMPORT_MAX_ROWS)), 422);
      const headers = table[0]!;
      const auto = autoMap(headers, fields);
      const selects = fields.map((f) =>
        h(Select, {
          name: `map_${f.name}`,
          label: f.label,
          value: auto[f.name] === undefined ? "" : String(auto[f.name]),
          options: [{ value: "", label: x().importSkip }, ...headers.map((head, i) => ({ value: String(i), label: head || `#${i + 1}` }))],
        }),
      );
      const content = h(
        Card,
        { title: x().importMapping },
        h(
          Form,
          { action: url(r.name, "_import") },
          h("p", null, x().importMappingLead),
          hiddenTable(table),
          h("input", { type: "hidden", name: "step", value: "check" }),
          h("div", { class: "zu-admin-filters" }, selects),
          h(FormActions, null, h(Button, null, x().importCheck), h(Button, { href: url(r.name, "_import"), variant: "ghost" }, m().cancel)),
        ),
      );
      return importPage(ctx, r, content);
    }

    const hidden = readHidden(form);
    if (!hidden || hidden.table.length - 1 > IMPORT_MAX_ROWS) return importPage(ctx, r, uploadForm(r, x().importExpired), 422);
    let mapping = hidden.mapping;
    if (!mapping) {
      mapping = {};
      for (const f of fields) {
        const v = String(form.get(`map_${f.name}`) ?? "");
        if (/^\d+$/.test(v) && Number(v) < (hidden.table[0]?.length ?? 0)) mapping[f.name] = Number(v);
      }
    }
    const canCreate = r.can(ctx, "create");
    const canUpdate = r.can(ctx, "update");
    const prepared = (await prepareImport(r, hidden.table, mapping)).map((row): ImportRow => {
      if (row.id !== undefined && !canUpdate) return { ...row, errors: { ...row.errors, [r.pk]: m().forbidden } };
      if (row.id === undefined && !canCreate) return { ...row, errors: { ...row.errors, [r.pk]: m().forbidden } };
      return row;
    });
    const good = prepared.filter((row) => !Object.keys(row.errors).length);

    if (step === "save") {
      let done = 0;
      const failures: string[] = [];
      const existing = new Map((await r.all({ filters: {}, ids: good.filter((g) => g.id !== undefined).map((g) => g.id!) })).map((row) => [r.idOf(row), row]));
      for (const row of good) {
        try {
          await persist(ctx, r, row.id !== undefined ? existing.get(String(row.id)) : undefined, row.values, undefined, "import");
          done++;
        } catch (err) {
          const friendly = r.friendlyError(err);
          failures.push(`${x().importLine} ${row.line}: ${friendly?.message ?? (err instanceof Error ? err.message : String(err))}`);
        }
      }
      if (failures.length) flash(ctx, `${x().importDone(done)} ${x().bulkFailed(failures.length, failures[0]!)}`, "error");
      else flash(ctx, x().importDone(done));
      return hxRedirect(ctx, url(r.name));
    }

    // Pratinjau: ringkasan, baris bermasalah dulu, lalu contoh baris yang siap disimpan.
    const bad = prepared.filter((row) => Object.keys(row.errors).length);
    const mapped = fields.filter((f) => mapping![f.name] !== undefined);
    const sample = [...bad.slice(0, 50), ...good.slice(0, Math.max(0, 50 - Math.min(bad.length, 50)))];
    const rows = sample.map((row) => {
      const cells = hidden.table[row.line - 1] ?? [];
      const status = Object.keys(row.errors).length ? h(Badge, { tone: "danger" }, x().importBad) : row.id !== undefined ? h(Badge, { tone: "accent" }, x().importUpdate) : h(Badge, { tone: "ok" }, x().importNew);
      return [
        String(row.line),
        status,
        ...mapped.map((f) => {
          const raw = truncate(cells[mapping![f.name]!] ?? "", 40);
          const error = row.errors[f.name];
          return error ? h("span", { class: "zu-admin-cell-error" }, raw ? `${raw} · ` : "", h("b", null, error)) : raw || h("span", { class: "zu-muted" }, "–");
        }),
      ];
    });
    const created = good.filter((g) => g.id === undefined).length;
    const columns = [{ key: "line", label: x().importLine }, { key: "status", label: x().importStatus }, ...mapped.map((f) => ({ key: f.name, label: f.label }))];
    const content = h(
      Stack,
      { gap: "md" },
      h(Alert, { tone: bad.length ? "warn" : "success" }, x().importSummary(created, good.length - created, bad.length)),
      h(Card, { title: x().importPreview, flush: true }, h(DataTable, { columns, rows, caption: x().importPreview })),
      good.length
        ? h(
            Form,
            { action: url(r.name, "_import") },
            hiddenTable(hidden.table, mapping),
            h("input", { type: "hidden", name: "step", value: "save" }),
            bad.length ? h("p", { class: "zu-muted" }, x().importBadSkipped) : null,
            h(FormActions, null, h(Button, { loading: m().saving }, x().importConfirm(good.length)), h(Button, { href: url(r.name, "_import"), variant: "ghost" }, m().cancel)),
          )
        : h(Alert, { tone: "error" }, x().importNoValid),
    );
    return importPage(ctx, r, content, good.length ? 200 : 422);
  }

  // ── Pencarian global ───────────────────────────────────────────────────────

  async function searchPage(ctx: ZenContext): Promise<ZenResponse> {
    const q = (str(ctx.query.q) ?? "").trim().slice(0, 100);
    const list = visible(ctx).filter((r) => r.fields.some((f) => f.search));
    const cards: Child[] = [];
    if (q.length >= 2) {
      for (const r of list) {
        const res = await r.list({ q, filters: {}, page: 1 });
        if (!res.total) continue;
        cards.push(
          h(
            Card,
            { title: `${r.label} (${formatNumber(res.total)})`, flush: true, actions: h(Button, { href: `${url(r.name)}?${new URLSearchParams({ q })}`, variant: "secondary", small: true }, m().viewAll) },
            h(List, { items: res.rows.slice(0, 5).map((row) => [h("a", { href: url(r.name, r.idOf(row)) }, truncate(r.titleOf(row), 60)), h("span", { class: "zu-muted" }, `#${r.idOf(row)}`)]) }),
          ),
        );
      }
    }
    const body = q.length < 2 ? h(EmptyState, { title: x().searchShort }) : cards.length ? h(Stack, { gap: "md" }, cards) : h(EmptyState, { title: x().searchNone(q) });
    return respond(layout(ctx, { title: x().searchTitle, subtitle: q ? `"${q}"` : undefined, active: basePath, current: url("_search") }, body));
  }

  // ── Pengaturan situs ───────────────────────────────────────────────────────

  async function settings(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const f of options.settings?.fields ?? []) out[f.name] = f.default ?? null;
    if (!store || !options.settings) return out;
    const saved = await store.settings();
    for (const f of options.settings.fields) if (f.name in saved) out[f.name] = saved[f.name];
    return out;
  }

  async function settingsPage(ctx: ZenContext): Promise<ZenResponse> {
    if (!canSettings(ctx)) throw new HttpError(options.settings ? 403 : 404, options.settings ? m().forbidden : undefined, { expose: true });
    const fields = options.settings!.fields;
    let values = await settings();
    const errors: Record<string, string> = {};
    if (ctx.method === "POST") {
      const form = await readForm(ctx, { maxBytes: "10mb" });
      const next: Record<string, unknown> = {};
      for (const f of fields) {
        const entry = lastValue(form, f.name);
        const type = f.type ?? "text";
        if (type === "boolean") next[f.name] = entry === "1" || entry === "on" || entry === "true";
        else if (type === "image") {
          if (entry instanceof File && entry.size > 0) {
            try {
              next[f.name] = (await saveUpload(entry, { dir: mediaDir, maxBytes: "5mb", types: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"] })).url;
            } catch (err) {
              if (!(err instanceof HttpError)) throw err;
              errors[f.name] = m().errors.upload(err.message);
            }
          }
        } else {
          const raw = typeof entry === "string" ? entry.replace(/\r\n/g, "\n").trim() : "";
          if (type === "number" && raw !== "") {
            const n = Number(raw.replace(",", "."));
            if (Number.isFinite(n)) next[f.name] = n;
            else errors[f.name] = m().errors.number;
          } else if (type === "email" && raw !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) errors[f.name] = m().errors.email;
          else if (type === "url" && raw !== "" && !/^https?:\/\/\S+$/i.test(raw)) errors[f.name] = m().errors.url;
          else next[f.name] = raw === "" ? null : raw;
        }
      }
      if (!Object.keys(errors).length) {
        const before = await settings();
        await store!.setSettings(next);
        const changes: Record<string, [unknown, unknown]> = {};
        for (const [k, v] of Object.entries(next)) if (JSON.stringify(before[k] ?? null) !== JSON.stringify(v ?? null)) changes[k] = [before[k] ?? null, v];
        if (Object.keys(changes).length && options.audit !== false) {
          try {
            await store!.log(ctx, { resource: "_settings", action: "update", changes });
          } catch (err) {
            ctx.logger.warn(`admin audit: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        flash(ctx, x().settingsSaved);
        return hxRedirect(ctx, url("_settings"));
      }
      values = { ...values, ...next };
    }
    const controls = fields.map((f) => {
      const v = values[f.name];
      const common = { name: f.name, label: f.label, hint: f.hint, error: errors[f.name] };
      switch (f.type ?? "text") {
        case "boolean":
          return h(Switch, { name: f.name, label: f.label, hint: f.hint, checked: Boolean(v) });
        case "textarea":
          return h(Field, { ...common, type: "textarea", rows: 4, value: v === null || v === undefined ? "" : String(v) });
        case "image":
          return h(FileInput, { name: f.name, label: f.label, types: ["image/*"], maxBytes: "5mb", preview: v ? String(v) : undefined, hint: v ? m().keepFile : f.hint, error: errors[f.name] });
        default:
          return h(Field, { ...common, type: f.type === "number" ? "number" : f.type === "email" ? "email" : f.type === "url" ? "url" : "text", value: v === null || v === undefined ? "" : String(v) });
      }
    });
    const body = h(
      Card,
      null,
      h(
        Form,
        { action: url("_settings"), upload: fields.some((f) => f.type === "image") },
        Object.keys(errors).length ? h(Alert, { tone: "error" }, m().errors.form) : null,
        controls,
        h(FormActions, null, h(Button, { loading: m().saving }, m().save)),
      ),
    );
    return respond(layout(ctx, { title: options.settings!.label ?? x().settings, subtitle: x().settingsLead, active: basePath, current: url("_settings") }, body), Object.keys(errors).length ? 422 : 200);
  }

  // ── Pustaka media ──────────────────────────────────────────────────────────

  function publicUrl(file: string): string | undefined {
    const publicDir = path.resolve("public");
    return file.startsWith(publicDir + path.sep) ? "/" + path.relative(publicDir, file).split(path.sep).join("/") : undefined;
  }

  async function mediaPage(ctx: ZenContext, parts: string[]): Promise<ZenResponse> {
    if (!canMedia(ctx)) throw new HttpError(mediaDir ? 403 : 404, mediaDir ? m().forbidden : undefined, { expose: true });
    const dir = mediaDir!;
    if (ctx.method === "POST" && parts[1] === "delete") {
      const name = parts[2] ?? "";
      if (!name || name !== path.basename(name) || name.startsWith(".")) throw new HttpError(400);
      await fs.rm(path.join(dir, name), { force: true });
      await record(ctx, "_media", { recordId: name, action: "destroy" });
      flash(ctx, x().mediaDeleted);
      return hxRedirect(ctx, url("_media"));
    }
    let error: string | undefined;
    if (ctx.method === "POST") {
      const form = await readForm(ctx, { maxBytes: "50mb" });
      const files = form.getAll("files").filter((f) => f instanceof File && f.size > 0) as unknown as File[];
      let saved = 0;
      for (const file of files) {
        try {
          const out = await saveUpload(file, { dir, maxBytes: "20mb", types: MEDIA_TYPES });
          await record(ctx, "_media", { recordId: out.name, action: "create" });
          saved++;
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          error = m().errors.upload(err.message);
        }
      }
      if (!error) {
        flash(ctx, x().mediaUploaded(saved));
        return hxRedirect(ctx, url("_media"));
      }
    }
    let entries: { name: string; size: number; at: Date }[] = [];
    try {
      const names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && !d.name.startsWith("."));
      entries = await Promise.all(names.map(async (d) => ({ name: d.name, ...(await fs.stat(path.join(dir, d.name)).then((s) => ({ size: s.size, at: s.mtime }))) })));
    } catch {
      entries = [];
    }
    entries.sort((a, b) => b.at.getTime() - a.at.getTime());
    const rows = entries.slice(0, 500).map((e) => {
      const href = publicUrl(path.join(dir, e.name));
      const image = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(e.name);
      return [
        image && href ? h("img", { class: "zu-admin-thumb", src: href, alt: e.name, loading: "lazy" }) : h("span", { class: "zu-muted" }, e.name.split(".").pop()?.toUpperCase() ?? ""),
        href ? h("a", { href, target: "_blank", rel: "noopener" }, truncate(e.name, 48)) : truncate(e.name, 48),
        href ? h("code", null, href) : "",
        bytes(e.size),
        when(e.at),
        h(PostButton, { action: url("_media", "delete", e.name), confirm: x().mediaDeleteConfirm(e.name), variant: "ghost" }, m().delete),
      ];
    });
    const upload = h(
      Card,
      null,
      h(Form, { action: url("_media"), upload: true }, h(FileInput, { name: "files", label: x().mediaUpload, multiple: true, maxBytes: "20mb", required: true, error }), h(FormActions, null, h(Button, null, x().mediaUpload))),
    );
    const table = h(
      Card,
      { flush: true },
      h(DataTable, {
        columns: [{ key: "thumb", label: "" }, { key: "name", label: m().labels.name ?? "Name" }, { key: "url", label: "URL" }, { key: "size", label: x().mediaSize, align: "num" }, { key: "at", label: x().mediaDate }, { key: "_actions", label: m().actions, align: "end" }],
        rows,
        empty: h(EmptyState, { title: x().mediaEmpty }),
        caption: x().media,
      }),
    );
    const rel = path.relative(process.cwd(), dir).split(path.sep).join("/") || ".";
    return respond(layout(ctx, { title: x().media, subtitle: x().mediaLead(rel), active: basePath, current: url("_media") }, h(Stack, { gap: "md" }, upload, table)), error ? 422 : 200);
  }

  // ── Dasbor ─────────────────────────────────────────────────────────────────

  async function dashboard(ctx: ZenContext): Promise<ZenResponse> {
    user(ctx);
    const list = visible(ctx);
    if (!list.length && !canSettings(ctx)) throw new HttpError(403, m().forbidden, { expose: true });
    const counts = await Promise.all(list.map((r) => r.count()));
    const recent = await Promise.all(list.map((r) => r.recent(5)));
    const stats = list.length
      ? h(
          StatGroup,
          null,
          list.map((r, i) => h("a", { class: "zu-admin-stat", href: url(r.name) }, h(Stat, { label: r.label, value: formatNumber(counts[i]!) }))),
        )
      : null;
    const cards = list.map((r, i) =>
      h(
        Card,
        { title: `${r.label} · ${m().recent.toLowerCase()}`, flush: true, actions: h(Button, { href: url(r.name), variant: "secondary", small: true }, m().viewAll) },
        recent[i]!.length
          ? h(List, { items: recent[i]!.map((row) => [h("a", { href: url(r.name, r.idOf(row)) }, truncate(r.titleOf(row), 60)), h("span", { class: "zu-muted" }, `#${r.idOf(row)}`)]) })
          : h(EmptyState, { title: m().noRows(r.label) }),
      ),
    );
    let activity: Child = null;
    const names = new Set(list.filter(audited).map((r) => r.name));
    if (store && names.size) {
      try {
        const entries = (await store.recent({ limit: 40 })).filter((e) => names.has(e.resource)).slice(0, 6);
        if (entries.length) {
          activity = h(
            Card,
            { title: x().auditLog, actions: h(Button, { href: url("_log"), variant: "secondary", small: true }, m().viewAll) },
            h(Timeline, {
              items: entries.map((e) => {
                const r = byName.get(e.resource)!;
                return { title: `${x().logActions[e.action] ?? e.action}: ${r.singular} #${e.recordId ?? ""}`, time: when(e.at), text: x().by(e.userName ?? x().system) };
              }),
            }),
          );
        }
      } catch (err) {
        ctx.logger.warn(`admin audit: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return respond(layout(ctx, { title: m().dashboard, subtitle: m().dashboardLead, active: basePath }, h(Stack, { gap: "lg" }, stats, h(Columns, { cols: 2 }, cards), activity)));
  }

  async function handle(ctx: ZenContext): Promise<ZenResponse> {
    user(ctx);
    const rel = ctx.path.startsWith(basePath) ? ctx.path.slice(basePath.length) : ctx.path;
    let parts: string[];
    try {
      parts = rel.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    } catch {
      throw new HttpError(400);
    }
    const get = ctx.method === "GET" || ctx.method === "HEAD";
    const post = ctx.method === "POST";
    const notAllowed = (allow: string) => new HttpError(405, undefined, { headers: { Allow: allow } });
    if (parts.length === 0) {
      if (!get) throw notAllowed("GET, HEAD");
      return dashboard(ctx);
    }
    // Halaman panel (bukan tabel) diawali garis bawah; nama tabel tidak pernah diawali garis bawah.
    switch (parts[0]) {
      case "_search":
        if (!get || parts.length !== 1) throw notAllowed("GET, HEAD");
        if (!visible(ctx).length) throw new HttpError(403, m().forbidden, { expose: true });
        return searchPage(ctx);
      case "_log":
        if (!get || parts.length !== 1) throw notAllowed("GET, HEAD");
        return auditPage(ctx);
      case "_settings":
        if (parts.length !== 1) throw new HttpError(404);
        if (!get && !post) throw notAllowed("GET, HEAD, POST");
        return settingsPage(ctx);
      case "_media":
        if (parts.length === 2 || parts.length > 3 || (parts.length === 3 && parts[1] !== "delete")) throw new HttpError(404);
        if (parts.length === 3 && !post) throw notAllowed("POST");
        if (!get && !post) throw notAllowed("GET, HEAD, POST");
        return mediaPage(ctx, parts);
      case "_schema": {
        if (!canSchema(ctx)) throw new HttpError(schemaEditor ? 403 : 404, schemaEditor ? m().forbidden : undefined, { expose: true });
        if (!get && !post) throw notAllowed("GET, HEAD, POST");
        const { schemaPage } = await import("./schema-page.js");
        return schemaPage(ctx, { url, layout: (c, o, ...children) => respond(layout(c, { ...o, active: basePath, current: url("_schema") }, ...children), o.status ?? 200), root: options.root ?? process.cwd() });
      }
    }
    const r = byName.get(parts[0]!);
    if (!r) throw new HttpError(404);
    if (!r.can(ctx, "view")) throw new HttpError(403, m().forbidden, { expose: true });
    const deny = (action: "create" | "update" | "delete") => {
      if (!r.can(ctx, action)) throw new HttpError(403, m().forbidden, { expose: true });
    };

    if (parts.length === 1) {
      if (get) return listPage(ctx, r);
      if (post) {
        deny("create");
        return save(ctx, r, undefined);
      }
      throw notAllowed("GET, HEAD, POST");
    }
    if (parts.length === 2) {
      switch (parts[1]) {
        case "new":
          if (!get) throw notAllowed("GET, HEAD");
          deny("create");
          return formPage(ctx, r, undefined);
        case "_export":
          if (!get) throw notAllowed("GET, HEAD");
          return exportList(ctx, r);
        case "_bulk":
          if (!post) throw notAllowed("POST");
          return bulk(ctx, r);
        case "_import":
          if (!get && !post) throw notAllowed("GET, HEAD, POST");
          if (!r.can(ctx, "create") && !r.can(ctx, "update")) throw new HttpError(403, m().forbidden, { expose: true });
          return importData(ctx, r);
      }
    }
    if (parts[1] === "_options" && parts.length === 3) {
      if (!get) throw notAllowed("GET, HEAD");
      return optionsFor(ctx, r, parts[2]!);
    }
    const id = r.parseId(parts[1]!);
    const row = id === undefined ? undefined : await r.find(id);
    // Urungkan hapus permanen: datanya sudah tidak ada, jadi dipulihkan dari salinan di log audit.
    if (parts[2] === "restore" && parts.length === 3 && id !== undefined) {
      if (!post) throw notAllowed("POST");
      deny("delete");
      return restore(ctx, r, id, row);
    }
    if (!row) throw new HttpError(404, m().notFound, { expose: true });
    const deleted = r.isDeleted(row);
    if (parts.length === 2) {
      if (get) return formPage(ctx, r, row);
      if (post) {
        deny("update");
        if (deleted) throw new HttpError(409, x().inTrash, { expose: true });
        return save(ctx, r, row);
      }
      throw notAllowed("GET, HEAD, POST");
    }
    const sub = parts[2];
    if (parts.length === 3) {
      switch (sub) {
        case "delete":
          if (!post) throw notAllowed("POST");
          deny("delete");
          return deleted ? destroy(ctx, r, row) : remove(ctx, r, row);
        case "destroy":
          if (!post) throw notAllowed("POST");
          deny("delete");
          return destroy(ctx, r, row);
        case "history":
          if (!get) throw notAllowed("GET, HEAD");
          if (!audited(r)) throw new HttpError(404);
          return historyPage(ctx, r, row);
        case "print":
          if (!get) throw notAllowed("GET, HEAD");
          return printPage(ctx, r, row);
        case "notes":
          if (!post) throw notAllowed("POST");
          deny("update");
          if (!store) throw new HttpError(404);
          return addNote(ctx, r, row);
      }
    }
    if (parts.length === 4 && !deleted) {
      switch (sub) {
        case "field": {
          if (!post) throw notAllowed("POST");
          deny("update");
          const f = r.field(parts[3]!);
          if (!f || f.form === false || f.readonly || !f.inline) throw new HttpError(404);
          return saveField(ctx, r, row, f);
        }
        case "revert":
          if (!post) throw notAllowed("POST");
          deny("update");
          return revert(ctx, r, row, parts[3]!);
        case "transition":
          if (!post) throw notAllowed("POST");
          deny("update");
          return transition(ctx, r, row, parts[3]!);
        case "action":
          if (!post) throw notAllowed("POST");
          deny("update");
          return customAction(ctx, r, row, parts[3]!);
      }
    }
    throw new HttpError(404);
  }

  return {
    resources: options.resources,
    basePath,
    dashboard,
    handle,
    nav,
    resource: (name) => byName.get(name),
    settings,
    store,
    idle: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

