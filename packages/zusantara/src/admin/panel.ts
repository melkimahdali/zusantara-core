import { readForm } from "../backend/upload.js";
import type { ZenContext } from "../core/context.js";
import { HttpError } from "../core/errors.js";
import { flash, takeFlash } from "../core/flash.js";
import { fragment, htmxTarget, hxRedirect, isHtmx } from "../core/htmx.js";
import { html, ZenResponse } from "../core/response.js";
import { h, renderToString, type Child } from "../core/view.js";
import { intlLocale, t } from "../i18n/index.js";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  Combobox,
  ComboboxOptions,
  DataTable,
  DescriptionList,
  EmptyState,
  Field,
  FileInput,
  Form,
  FormActions,
  formatDate,
  formatNumber,
  InlineEdit,
  page,
  Pagination,
  PostButton,
  Select,
  Split,
  Stack,
  Stat,
  StatGroup,
  Switch,
  Tabs,
  Toast,
  Columns,
  List,
  type NavItem,
} from "../ui/index.js";
import type { AdminField } from "./fields.js";
import { lastValue, parseField, parseForm } from "./form.js";
import type { AdminResource, AdminUser, ListQuery, ListResult } from "./resource.js";

/**
 * Panel admin: dasbor dan halaman daftar, tambah, ubah, hapus untuk setiap tabel yang didaftarkan.
 * Dipasang oleh `zusantara make:admin` di src/app/admin/index.ts dan dua route:
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

export interface AdminOptions {
  resources: AdminResource[];
  /** Awal URL panel (default /admin). */
  basePath?: string;
  /** Nama aplikasi di kerangka bawaan. */
  appName?: string;
  /** Kerangka halaman aplikasi Anda (mis. appPage), agar panel admin memakai navigasi yang sama. */
  layout?: AdminLayout;
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
}

const RESULTS = "zu-admin-results";
const HEADERS = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store", Vary: "HX-Request" };

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

export function defineAdmin(options: AdminOptions): AdminPanel {
  const basePath = (options.basePath ?? "/admin").replace(/\/+$/, "");
  const byName = new Map(options.resources.map((r) => [r.name, r]));
  const m = () => t().admin;
  const url = (...parts: (string | number)[]) => [basePath, ...parts.map((p) => encodeURIComponent(String(p)))].join("/");

  function user(ctx: ZenContext): AdminUser {
    const u = ctx.state.user as AdminUser | undefined;
    if (!u) throw new HttpError(401, m().loginRequired, { expose: true });
    return u;
  }

  function visible(ctx: ZenContext): AdminResource[] {
    return options.resources.filter((r) => r.can(ctx, "view"));
  }

  function nav(u: AdminUser | undefined): NavItem[] {
    if (!u) return [];
    const ctx = { state: { user: u } } as unknown as ZenContext;
    return visible(ctx).length ? [{ href: basePath, label: m().title, section: m().section }] : [];
  }

  /** Halaman lengkap: kerangka aplikasi (bila ada) + sub-navigasi tabel admin. */
  function layout(ctx: ZenContext, o: AdminLayoutOptions & { current?: string }, ...children: Child[]): string {
    const tabs = visible(ctx);
    const items = [{ href: basePath, label: m().dashboard }, ...tabs.map((r) => ({ href: url(r.name), label: r.label }))];
    const toast = h(Toast, { flash: takeFlash(ctx) });
    if (options.layout) {
      const sub = tabs.length > 1 || o.current === undefined ? h(Tabs, { items, active: o.current ?? basePath, label: m().resources }) : null;
      return options.layout(ctx, { title: o.title, subtitle: o.subtitle, active: basePath, actions: o.actions }, toast, sub, ...children);
    }
    const u = ctx.state.user as AdminUser;
    const shellUser = { name: String(u.name ?? u.email ?? m().title), email: typeof u.email === "string" ? u.email : undefined, role: typeof u.role === "string" ? u.role : undefined };
    return page(
      { title: `${o.title} · ${options.appName ?? m().title}` },
      h(AppShell, { appName: options.appName, nav: items, active: o.current ?? basePath, user: shellUser, title: o.title, subtitle: o.subtitle, actions: o.actions }, toast, children),
    );
  }

  // ── Tampilan nilai ─────────────────────────────────────────────────────────

  function display(r: AdminResource, f: AdminField, row: Record<string, unknown>, labels?: Map<string, Map<string, string>>): Child {
    const v = row[f.name];
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
    return { q: str(ctx.query.q), sort: str(ctx.query.sort), dir: dir === "desc" ? "desc" : dir === "asc" ? "asc" : undefined, page: Number(str(ctx.query.page) ?? 1), filters };
  }

  /** URL daftar dengan query sekarang, ditimpa `change` (nilai kosong = dihapus). */
  function listUrl(r: AdminResource, q: ListQuery, change: Record<string, string | undefined>): string {
    const params = new URLSearchParams();
    const merged: Record<string, string | undefined> = { q: q.q, sort: q.sort, dir: q.dir, page: q.page && q.page > 1 ? String(q.page) : undefined, ...q.filters, ...change };
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
    const hidden = [q.sort ? h("input", { type: "hidden", name: "sort", value: q.sort }) : null, q.dir ? h("input", { type: "hidden", name: "dir", value: q.dir }) : null];
    for (const f of r.fields.filter((x) => x.filter && x.type === "relation")) {
      const v = q.filters[`f_${f.name}`];
      if (v) hidden.push(h("input", { type: "hidden", name: `f_${f.name}`, value: v }));
    }
    return h(
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
  }

  function results(ctx: ZenContext, r: AdminResource, q: ListQuery, res: ListResult): Child {
    const canUpdate = r.can(ctx, "update");
    const canDelete = r.can(ctx, "delete");
    const fields = r.listFields;
    const hx = { target: `#${RESULTS}`, swap: "outerHTML", pushUrl: true };
    const columns = [
      ...fields.map((f) => ({ key: f.name, label: f.label, sortable: Boolean(f.sort), align: f.type === "number" && f.name !== r.pk ? ("num" as const) : undefined })),
      { key: "_actions", label: m().actions, align: "end" as const },
    ];
    const rows = res.rows.map((row) => [
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
      h(
        "div",
        { class: "zu-admin-row-actions" },
        h(Button, { href: url(r.name, r.idOf(row)), variant: "ghost", small: true }, canUpdate ? m().open : m().view),
        canDelete ? h(PostButton, { action: url(r.name, r.idOf(row), "delete"), confirm: m().deleteConfirm(r.titleOf(row)), variant: "ghost" }, m().delete) : null,
      ),
    ]);
    const filtered = Boolean(q.q) || Object.values(q.filters).some((v) => v !== "");
    const empty = filtered
      ? h(EmptyState, { title: m().noMatch, text: m().noMatchHint, action: h(Button, { href: url(r.name), variant: "secondary", small: true }, m().reset) })
      : h(EmptyState, { title: m().noRows(r.label), text: m().noRowsHint, action: r.can(ctx, "create") ? h(Button, { href: url(r.name, "new"), small: true }, m().add(r.singular)) : undefined });
    return h(
      "div",
      { id: RESULTS, class: "zu-results zu-admin-results" },
      h("p", { class: "zu-admin-count", role: "status" }, m().count(formatNumber(res.total))),
      h(
        Card,
        { flush: true },
        h(DataTable, { columns, rows, sort: { key: res.sort.field, dir: res.sort.dir }, sortHref: listUrl(r, q, { sort: "{key}", dir: "{dir}", page: undefined }), empty, caption: r.label, hx }),
      ),
      h(Pagination, { page: res.page, pages: res.pages, href: listUrl(r, q, { page: "{page}" }), hx }),
    );
  }

  async function listPage(ctx: ZenContext, r: AdminResource): Promise<ZenResponse> {
    const q = listQuery(ctx);
    const res = await r.list(q);
    // URL yang dicatat di riwayat dibersihkan dari parameter kosong (formulir filter mengirim semua kolom).
    if (htmxTarget(ctx) === RESULTS) return fragment(renderToString(results(ctx, r, q, res)), { ...HEADERS, "HX-Push-Url": listUrl(r, q, {}) });
    const actions = r.can(ctx, "create") ? h(Button, { href: url(r.name, "new") }, m().add(r.singular)) : undefined;
    return respond(layout(ctx, { title: r.label, subtitle: m().count(formatNumber(res.total)), active: basePath, current: url(r.name), actions }, h(Stack, { gap: "md" }, filterBar(r, q), results(ctx, r, q, res))));
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
        return h(Field, { ...common, type: "datetime-local", value });
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
        return h(Field, { ...common, value });
    }
  }

  async function editForm(ctx: ZenContext, r: AdminResource, row: Record<string, unknown> | undefined, state?: { raw: Record<string, string>; errors: Record<string, string>; message?: string }): Promise<Child> {
    const id = "zu-admin-form";
    const action = row ? url(r.name, r.idOf(row)) : url(r.name);
    const controls: Child[] = [];
    for (const f of r.formFields) controls.push(await formControl(r, f, row, state?.raw, state?.errors[f.name]));
    const hasErrors = state && (Object.keys(state.errors).length || state.message);
    return h(
      Form,
      { action, upload: r.hasFiles, id, hx: { target: "this", swap: "outerHTML" } },
      hasErrors ? h(Alert, { tone: "error" }, state!.message ?? m().errors.form) : null,
      controls,
      h(FormActions, null, h(Button, { loading: m().saving }, m().save), h(Button, { href: url(r.name), variant: "ghost" }, m().cancel)),
    );
  }

  function infoPanel(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>, labels: Map<string, Map<string, string>>): Child {
    const items = r.fields.filter((f) => f.form === false || f.readonly).map((f) => ({ label: f.label, value: display(r, f, row, labels) }));
    const del = r.can(ctx, "delete") ? h(PostButton, { action: url(r.name, r.idOf(row), "delete"), confirm: m().deleteConfirm(r.titleOf(row)) }, m().delete) : null;
    if (!items.length && !del) return null;
    return h(Card, { title: m().info }, h(Stack, { gap: "md" }, items.length ? h(DescriptionList, { items }) : null, del));
  }

  async function formPage(ctx: ZenContext, r: AdminResource, row: Record<string, unknown> | undefined, state?: { raw: Record<string, string>; errors: Record<string, string>; message?: string }, status = 200): Promise<ZenResponse> {
    const form = await editForm(ctx, r, row, state);
    if (status !== 200 && isHtmx(ctx)) return fragment(renderToString(form), HEADERS, status);
    const canEdit = !row || r.can(ctx, "update");
    const title = row ? (canEdit ? m().editOf(r.titleOf(row)) : r.titleOf(row)) : m().newTitle(r.singular);
    const labels = row ? await r.relationLabels([row]) : new Map();
    const body = row
      ? canEdit
        ? h(Split, null, h(Card, null, form), infoPanel(ctx, r, row, labels))
        : h(Card, null, h(DescriptionList, { items: r.fields.map((f) => ({ label: f.label, value: display(r, f, row, labels) })) }))
      : h(Card, null, form);
    return respond(layout(ctx, { title, subtitle: r.label, active: basePath, current: url(r.name) }, body), status);
  }

  async function save(ctx: ZenContext, r: AdminResource, row: Record<string, unknown> | undefined): Promise<ZenResponse> {
    const form = await readForm(ctx, { maxBytes: r.hasFiles ? "20mb" : "1mb" });
    const parsed = await parseForm(r, form, row);
    if (Object.keys(parsed.errors).length) return formPage(ctx, r, row, parsed, 422);
    try {
      await r.options.beforeSave?.(parsed.values, ctx, row);
      if (row) await r.update(r.parseId(r.idOf(row))!, parsed.values);
      else await r.insert(parsed.values);
      flash(ctx, row ? m().updated(r.singular) : m().created(r.singular));
      return hxRedirect(ctx, url(r.name));
    } catch (err) {
      const friendly = r.friendlyError(err);
      if (!friendly) throw err;
      const errors = friendly.field ? { [friendly.field]: friendly.message } : {};
      return formPage(ctx, r, row, { raw: parsed.raw, errors, message: friendly.field ? undefined : friendly.message }, 422);
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
      if (parsed.value !== undefined) {
        const values: Record<string, unknown> = { [f.name]: parsed.value };
        await r.options.beforeSave?.(values, ctx, row);
        saved = (await r.update(r.parseId(r.idOf(row))!, values)) ?? row;
      }
      return reply(inlineCell(r, f, saved), 200, m().updated(r.singular), "success");
    } catch (err) {
      const friendly = r.friendlyError(err);
      if (!friendly) throw err;
      return reply(inlineCell(r, f, row, friendly.message), 422, friendly.message, "error");
    }
  }

  async function remove(ctx: ZenContext, r: AdminResource, row: Record<string, unknown>): Promise<ZenResponse> {
    try {
      await r.remove(r.parseId(r.idOf(row))!);
      flash(ctx, m().deleted(r.singular));
    } catch (err) {
      const friendly = r.friendlyError(err);
      if (!friendly) throw err;
      flash(ctx, m().errors.inUse(r.singular), "error");
    }
    return hxRedirect(ctx, url(r.name));
  }

  async function optionsFor(ctx: ZenContext, r: AdminResource, fieldName: string): Promise<ZenResponse> {
    const f = r.field(fieldName);
    if (!f || f.type !== "relation") throw new HttpError(404);
    const selected = str(ctx.query[f.name]);
    const found = await r.relationOptions(f.name, str(ctx.query.q), selected);
    return fragment(renderToString(h(ComboboxOptions, { name: f.name, options: found.options, value: selected ?? null, selected: found.selected, allowEmpty: !f.required })), HEADERS);
  }

  // ── Dasbor ─────────────────────────────────────────────────────────────────

  async function dashboard(ctx: ZenContext): Promise<ZenResponse> {
    user(ctx);
    const list = visible(ctx);
    if (!list.length) throw new HttpError(403, m().forbidden, { expose: true });
    const counts = await Promise.all(list.map((r) => r.count()));
    const recent = await Promise.all(list.map((r) => r.recent(5)));
    const stats = h(
      StatGroup,
      null,
      list.map((r, i) => h("a", { class: "zu-admin-stat", href: url(r.name) }, h(Stat, { label: r.label, value: formatNumber(counts[i]!) }))),
    );
    const cards = list.map((r, i) =>
      h(
        Card,
        { title: `${r.label} · ${m().recent.toLowerCase()}`, flush: true, actions: h(Button, { href: url(r.name), variant: "secondary", small: true }, m().viewAll) },
        recent[i]!.length
          ? h(List, { items: recent[i]!.map((row) => [h("a", { href: url(r.name, r.idOf(row)) }, truncate(r.titleOf(row), 60)), h("span", { class: "zu-muted" }, `#${r.idOf(row)}`)]) })
          : h(EmptyState, { title: m().noRows(r.label) }),
      ),
    );
    return respond(layout(ctx, { title: m().dashboard, subtitle: m().dashboardLead, active: basePath }, h(Stack, { gap: "lg" }, stats, h(Columns, { cols: 2 }, cards))));
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
    if (parts.length === 0) {
      if (ctx.method !== "GET" && ctx.method !== "HEAD") throw new HttpError(405, undefined, { headers: { Allow: "GET, HEAD" } });
      return dashboard(ctx);
    }
    const r = byName.get(parts[0]!);
    if (!r) throw new HttpError(404);
    if (!r.can(ctx, "view")) throw new HttpError(403, m().forbidden, { expose: true });
    const get = ctx.method === "GET" || ctx.method === "HEAD";
    const post = ctx.method === "POST";
    const deny = (action: "create" | "update" | "delete") => {
      if (!r.can(ctx, action)) throw new HttpError(403, m().forbidden, { expose: true });
    };
    const notAllowed = (allow: string) => new HttpError(405, undefined, { headers: { Allow: allow } });

    if (parts.length === 1) {
      if (get) return listPage(ctx, r);
      if (post) {
        deny("create");
        return save(ctx, r, undefined);
      }
      throw notAllowed("GET, HEAD, POST");
    }
    if (parts[1] === "new" && parts.length === 2) {
      if (!get) throw notAllowed("GET, HEAD");
      deny("create");
      return formPage(ctx, r, undefined);
    }
    if (parts[1] === "_options" && parts.length === 3) {
      if (!get) throw notAllowed("GET, HEAD");
      return optionsFor(ctx, r, parts[2]!);
    }
    const id = r.parseId(parts[1]!);
    const row = id === undefined ? undefined : await r.find(id);
    if (!row) throw new HttpError(404, m().notFound, { expose: true });
    if (parts.length === 2) {
      if (get) return formPage(ctx, r, row);
      if (post) {
        deny("update");
        return save(ctx, r, row);
      }
      throw notAllowed("GET, HEAD, POST");
    }
    if (parts[2] === "delete" && parts.length === 3) {
      if (!post) throw notAllowed("POST");
      deny("delete");
      return remove(ctx, r, row);
    }
    if (parts[2] === "field" && parts.length === 4) {
      if (!post) throw notAllowed("POST");
      deny("update");
      const f = r.field(parts[3]!);
      if (!f || f.form === false || f.readonly || !f.inline) throw new HttpError(404);
      return saveField(ctx, r, row, f);
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
  };
}
