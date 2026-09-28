import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadJobs } from "../backend/jobs.js";
import { loadConfigFile, resolveConfig } from "../core/config.js";
import { ZenLogger } from "../core/logger.js";
import { allowedMethods, ZenRouter } from "../core/router.js";
import { getLocale, t } from "../i18n/index.js";
import type { AdminPanel } from "./panel.js";
import type { AccessRule } from "./resource.js";
import type { TableInfo } from "./schema.js";

/**
 * `zusantara describe [--json]`: manifest aplikasi untuk manusia, Zusantara AI, dan agen lain
 * (route, tabel dan kolom, panel admin, job, plugin), tanpa kolom rahasia dan tanpa isi data. Dibaca
 * dari kode proyek, bukan dari database.
 */

export interface ManifestColumn {
  name: string;
  /** Nama properti di Drizzle (bila beda dengan nama kolom SQL). */
  key?: string;
  type: string;
  notNull: boolean;
  primary?: true;
  unique?: true;
  default?: true;
  enum?: string[];
  references?: string;
}

export interface AppManifest {
  manifestVersion: 1;
  app: { name: string; version?: string; zusantara?: string; locale: string; root: string };
  routes: { pattern: string; methods: string[]; file: string }[];
  tables: { name: string; export: string; columns: ManifestColumn[]; hiddenColumns: number }[];
  admin: { basePath: string; resources: { name: string; table: string; label: string; fields: string[]; search: string[]; filters: string[]; access: Record<string, string[] | boolean | "custom"> }[] } | null;
  jobs: { name: string; schedule?: string; retries: number }[];
  plugins: string[];
  suggestions: { indexes: { table: string; column: string; reason: "search" | "filter" | "sort" }[] };
}

const EXTS = [".ts", ".mts", ".js", ".mjs"];
const findModule = (base: string) => EXTS.map((e) => base + e).find((f) => fs.existsSync(f));

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function accessOf(rule: AccessRule | undefined): string[] | boolean | "custom" {
  if (rule === undefined) return ["admin"];
  if (typeof rule === "function") return "custom";
  return rule;
}

export async function describeApp(root: string, zusantaraVersion?: string): Promise<AppManifest> {
  const user = await loadConfigFile(root);
  const config = resolveConfig(user, process.env, root);
  const pkg = readJson(path.join(root, "package.json"));
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");

  const router = new ZenRouter(new ZenLogger("silent"));
  if (fs.existsSync(config.routesDir)) await router.loadRoutes(config.routesDir);
  const routes = router.list.map((r) => ({ pattern: r.pattern, methods: allowedMethods(r.module).filter((m) => m !== "HEAD" && m !== "OPTIONS"), file: rel(r.file) }));

  const tables: AppManifest["tables"] = [];
  const infoByTable = new Map<string, TableInfo>();
  const schemaFile = findModule(path.join(config.appDir, "db", "schema"));
  if (schemaFile) {
    // Dimuat saat dipakai saja: proyek tanpa database tidak perlu memasang drizzle-orm.
    const { inspectTable, tablesOf } = await import("./schema.js");
    const schema = (await import(pathToFileURL(schemaFile).href)) as Record<string, unknown>;
    for (const [exportName, table] of tablesOf(schema)) {
      const info = inspectTable(table);
      infoByTable.set(info.name, info);
      const visible = info.columns.filter((c) => !c.secret);
      tables.push({
        name: info.name,
        export: exportName,
        hiddenColumns: info.columns.length - visible.length,
        columns: visible.map((c) => {
          const col: ManifestColumn = { name: c.name, type: c.enumValues ? "enum" : c.dataType, notNull: c.notNull };
          if (c.key !== c.name) col.key = c.key;
          if (c.primary) col.primary = true;
          if (c.unique) col.unique = true;
          if (c.hasDefault) col.default = true;
          if (c.enumValues) col.enum = c.enumValues;
          if (c.references) col.references = `${c.references.table}.${c.references.column}`;
          return col;
        }),
      });
    }
  }

  let admin: AppManifest["admin"] = null;
  const indexes: AppManifest["suggestions"]["indexes"] = [];
  const registry = findModule(path.join(config.appDir, "admin", "index"));
  if (registry) {
    const mod = (await import(pathToFileURL(registry).href)) as { admin?: AdminPanel };
    if (mod.admin) {
      admin = {
        basePath: mod.admin.basePath,
        resources: mod.admin.resources.map((r) => {
          const access: Record<string, string[] | boolean | "custom"> = {};
          for (const a of ["view", "create", "update", "delete"] as const) access[a] = a === "create" && r.options.create === false ? false : accessOf(r.options.access?.[a]);
          const info = infoByTable.get(r.info.name) ?? r.info;
          const indexed = new Set(info.indexed);
          const suggest = (key: string, reason: "search" | "filter" | "sort") => {
            const col = info.columns.find((c) => c.key === key);
            if (col && !indexed.has(col.name) && !indexes.some((x) => x.table === info.name && x.column === col.name)) indexes.push({ table: info.name, column: col.name, reason });
          };
          for (const f of r.fields) {
            if (f.filter) suggest(f.name, "filter");
            else if (f.search) suggest(f.name, "search");
          }
          if (r.options.defaultSort) suggest(r.options.defaultSort.field, "sort");
          return {
            name: r.name,
            table: r.info.name,
            label: r.label,
            fields: r.fields.map((f) => f.name),
            search: r.fields.filter((f) => f.search).map((f) => f.name),
            filters: r.fields.filter((f) => f.filter).map((f) => f.name),
            access,
          };
        }),
      };
    }
  }

  const jobsDir = path.join(path.dirname(config.routesDir), "jobs");
  const jobs = (fs.existsSync(jobsDir) ? await loadJobs(jobsDir) : []).map((j) => ({ name: j.name, retries: j.retries, ...(j.schedule ? { schedule: j.schedule.source } : {}) }));

  return {
    manifestVersion: 1,
    app: { name: config.appName, version: typeof pkg?.version === "string" ? pkg.version : undefined, zusantara: zusantaraVersion, locale: getLocale(), root: "." },
    routes,
    tables,
    admin,
    jobs,
    plugins: config.plugins.map((p) => p.name),
    suggestions: { indexes },
  };
}

/** Manifest untuk dibaca manusia di terminal. */
export function formatManifest(m: AppManifest): string {
  const d = t().admin.describe;
  const out: string[] = [d.title(m.app.name) + (m.app.version ? ` ${m.app.version}` : "") + (m.app.zusantara ? ` · zusantara ${m.app.zusantara}` : "")];
  out.push("", `${d.routes} (${m.routes.length})`);
  for (const r of m.routes) out.push(`  ${r.methods.join("|").padEnd(18)} ${r.pattern.padEnd(28)} ${r.file}`);
  if (!m.routes.length) out.push(`  ${d.none}`);
  out.push("", `${d.tables} (${m.tables.length})`);
  for (const tb of m.tables) {
    const cols = tb.columns.map((c) => `${c.name}${c.primary ? "*" : ""}${c.references ? `→${c.references}` : ""}`).join(", ");
    out.push(`  ${tb.name}: ${cols}${tb.hiddenColumns ? ` (${d.secretHidden(tb.hiddenColumns)})` : ""}`);
  }
  if (!m.tables.length) out.push(`  ${d.noSchema}`);
  out.push("", `${d.admin}${m.admin ? ` (${m.admin.basePath})` : ""}`);
  if (m.admin?.resources.length) for (const r of m.admin.resources) out.push(`  ${r.name.padEnd(20)} ${r.label}`);
  else out.push(`  ${d.none}`);
  out.push("", `${d.jobs} (${m.jobs.length})`);
  for (const j of m.jobs) out.push(`  ${j.name}${j.schedule ? `  ${j.schedule}` : ""}`);
  if (!m.jobs.length) out.push(`  ${d.none}`);
  out.push("", `${d.plugins}: ${m.plugins.length ? m.plugins.join(", ") : d.none}`);
  if (m.suggestions.indexes.length) {
    out.push("", d.indexHint);
    const why = { search: d.searched, filter: d.filtered, sort: d.sorted };
    for (const s of m.suggestions.indexes) out.push(`  ${d.indexAdvice(s.table, s.column, why[s.reason])}`);
  }
  out.push("", d.json);
  return out.join("\n");
}
