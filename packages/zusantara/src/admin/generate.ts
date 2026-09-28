import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfigFile, resolveConfig } from "../core/config.js";
import { getLocale, t } from "../i18n/index.js";
import { findBlock, renderBlock, replaceBlock } from "./blocks.js";
import { defaultFields, humanLabel, missingRequired, resourceName, titleKeyOf, type AdminField } from "./fields.js";
import { inspectTable, tablesOf, type AnyTable, type TableInfo } from "./schema.js";

/**
 * `zusantara make:admin <tabel...>`: halaman admin dari schema database. Menulis
 * src/app/admin/<tabel>.ts (field dari schema di blok bertanda), daftar tabel admin di
 * src/app/admin/index.ts, route /admin, menu navigasi, dan tes. Bisa dijalankan ulang setelah schema
 * berubah: hanya blok bertanda yang diperbarui, dan blok yang sudah diubah manual tidak ditimpa.
 */

export interface MakeAdminOptions {
  all?: boolean;
  force?: boolean;
}

export interface MakeAdminResult {
  ok: boolean;
  lines: string[];
  /** File yang dibuat atau diubah (relatif ke root), untuk undo AI. */
  changed: string[];
}

const EXTS = [".ts", ".mts", ".js", ".mjs"];

function findModule(base: string): string | undefined {
  return EXTS.map((e) => base + e).find((f) => fs.existsSync(f));
}


function identifier(name: string): string {
  const camel = name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  return `${/^[a-z]/.test(camel) ? camel : `t${camel}`}Admin`;
}

/** Nilai sebagai literal TypeScript yang rapi: { labelKey: "name" }, ["user", "admin"]. */
function literal(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (value && typeof value === "object") {
    const parts = Object.entries(value).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${literal(v)}`);
    return `{ ${parts.join(", ")} }`;
  }
  return JSON.stringify(value);
}

function fieldLine(f: AdminField): string {
  const parts = Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${literal(v)}`);
  return `    { ${parts.join(", ")} },`;
}

/** Tunggal dari jamak sederhana untuk label ("Produk" tetap, "Users" -> "User"). */
function singularOf(label: string, locale: "id" | "en"): string {
  if (locale === "id") return label;
  if (/ies$/i.test(label)) return label.replace(/ies$/i, "y");
  if (/(ss|us)$/i.test(label)) return label;
  return label.replace(/s$/i, "");
}

function resourceBlock(exportName: string, info: TableInfo, fields: AdminField[], create: boolean, name: string): string {
  const g = t().admin.gen;
  const label = humanLabel(info.name);
  const singular = singularOf(label, getLocale());
  return [
    ...g.resourceHead(`zusantara make:admin ${exportName}`).map((l) => `// ${l}`),
    "const generated: GeneratedResource = {",
    `  name: ${literal(name)},`,
    `  label: ${literal(label)},`,
    `  singular: ${literal(singular)},`,
    `  titleField: ${literal(titleKeyOf(info))},`,
    ...(create ? [] : [`  create: false,`]),
    "  fields: [",
    ...fields.map(fieldLine),
    "  ],",
    "};",
  ].join("\n");
}

function resourceFile(exportName: string, info: TableInfo, fields: AdminField[], create: boolean, name: string): string {
  const g = t().admin.gen;
  return [
    `import { defineResource, type GeneratedResource } from "zusantara/admin";`,
    `import { db } from "../db/index.js";`,
    `import { ${exportName} } from "../db/schema.js";`,
    "",
    renderBlock("admin-resource", resourceBlock(exportName, info, fields, create, name)),
    "",
    "export default defineResource({",
    "  ...generated,",
    `  table: ${exportName},`,
    "  db,",
    `  // ${g.access}`,
    `  access: { view: ["admin"], create: ["admin"], update: ["admin"], delete: ["admin"] },`,
    `  // ${g.overrides}`,
    "  overrides: {},",
    "});",
    "",
  ].join("\n");
}

function registryBlock(names: string[]): string {
  const sorted = [...new Set(names)].sort();
  return [...sorted.map((n) => `import ${identifier(n)} from "./${n}.js";`), "", `const resources = [${sorted.map(identifier).join(", ")}];`].join("\n");
}

function registryFile(names: string[], hasLayout: boolean): string {
  const g = t().admin.gen;
  return [
    `import { defineAdmin } from "zusantara/admin";`,
    ...(hasLayout ? [`import { appPage } from "../lib/ui.js";`] : []),
    "",
    renderBlock("admin-resources", registryBlock(names)),
    "",
    `/** ${g.panel} */`,
    "export const admin = defineAdmin({",
    "  resources,",
    ...(hasLayout ? [`  // ${g.layout}`, "  layout: (ctx, options, ...children) => appPage(ctx, options, ...children),"] : []),
    "});",
    "",
    `/** ${g.nav} */`,
    "export const adminNav = admin.nav;",
    "",
  ].join("\n");
}

/** Nama resource yang terdaftar di blok registry sekarang. */
function registeredNames(text: string): string[] {
  const block = findBlock(text, "admin-resources");
  if (!block) return [];
  return [...block.body.matchAll(/from "\.\/([\w-]+)\.js"/g)].map((m) => m[1]!);
}

function routeFile(kind: "dashboard" | "handle", withAuth: boolean): string {
  const g = t().admin.gen;
  return [
    `import { admin } from "../../admin/index.js";`,
    ...(withAuth ? [`import { requireUserPage } from "../../lib/auth.js";`] : []),
    "",
    `// ${kind === "dashboard" ? g.routeDashboard : g.routeHandle}`,
    ...(withAuth ? ["export const middleware = [requireUserPage];"] : []),
    ...(kind === "dashboard" ? ["export const GET = admin.dashboard;"] : ["export const GET = admin.handle;", "export const POST = admin.handle;"]),
    "",
  ].join("\n");
}

/** Nilai contoh untuk tes tambah data; undefined bila field wajib tidak bisa diisi otomatis. */
function sampleValue(f: AdminField): string | undefined {
  switch (f.type) {
    case "text":
    case "textarea":
      return "`contoh-${stamp}`";
    case "email":
      return "`contoh-${stamp}@example.test`";
    case "url":
      return '"https://example.test"';
    case "number":
      return "1";
    case "enum":
      return f.options?.[0] ? literal(f.options[0]) : undefined;
    case "date":
      return '"2026-01-15"';
    case "datetime":
      return '"2026-01-15T10:30"';
    case "json":
      return '"{}"';
    default:
      return undefined;
  }
}

function testFile(name: string, label: string, fields: AdminField[], create: boolean): string {
  const g = t().admin.gen;
  const base = `/admin/${name}`;
  const required = fields.filter((f) => f.form !== false && !f.readonly && f.required);
  const samples = required.map((f) => [f, sampleValue(f)] as const);
  const canSample = create && samples.every(([, v]) => v !== undefined);
  const search = fields.find((f) => f.search && f.required && (f.type === "text" || f.type === "email"));
  const lines = [
    `import assert from "node:assert/strict";`,
    `import path from "node:path";`,
    `import { before, describe, it } from "node:test";`,
    `import { fileURLToPath } from "node:url";`,
    `import { testAdmin, type AdminTester } from "zusantara/admin";`,
    "",
    `// ${g.testHead(name)}`,
    `process.env.DATABASE_URL = ":memory:";`,
    `const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");`,
    "",
    `describe(${literal(`admin: ${label}`)}, () => {`,
    "  let t: AdminTester;",
    "",
    "  before(async () => {",
    `    const { db } = await import("../src/app/db/index.js");`,
    `    const { migrateDatabase } = await import("zusantara/db");`,
    `    await migrateDatabase(db, path.join(ROOT, "drizzle"));`,
    `    t = testAdmin((await import("../src/app/admin/index.js")).admin);`,
    "  });",
    "",
    `  it(${literal(g.testAccess)}, async () => {`,
    `    const admin = { role: "admin" };`,
    `    assert.equal((await t.get(${literal(base)}, admin)).status, 200);`,
    `    assert.equal((await t.get(${literal(`${base}/new`)}, admin)).status, ${create ? 200 : 403});`,
    `    assert.equal((await t.get(${literal(base)}, { role: "guest" })).status, 403);`,
    `    assert.equal((await t.get(${literal(base)})).status, 401);`,
    "  });",
  ];
  if (canSample) {
    lines.push(
      "",
      `  it(${literal(g.testCreate)}, async () => {`,
      `    const admin = { role: "admin" };`,
      "    const stamp = Date.now();",
      `    const res = await t.post(${literal(base)}, { ${samples.map(([f, v]) => `${f.name}: ${v}`).join(", ")} }, admin);`,
      "    assert.equal(res.status, 303, res.body);",
      ...(search
        ? [`    const list = await t.get(\`${base}?q=contoh-\${stamp}\`, admin);`, "    assert.match(list.body, new RegExp(`contoh-${stamp}`));"]
        : [`    assert.equal((await t.get(${literal(base)}, admin)).status, 200);`]),
      "  });",
    );
  }
  lines.push("});", "");
  return lines.join("\n");
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Tambah menu admin ke navFor() di src/app/lib/ui.ts bila bentuknya seperti template. */
function addNav(file: string): boolean {
  let text = fs.readFileSync(file, "utf8");
  if (text.includes("adminNav")) return false;
  const fn = /function navFor\([^)]*\)[^{]*\{/.exec(text);
  if (!fn) return false;
  const ret = text.indexOf("\n  return nav;", fn.index);
  if (ret < 0) return false;
  text = `${text.slice(0, ret)}\n  nav.push(...adminNav(user));${text.slice(ret)}`;
  const imports = [...text.matchAll(/^import .*;$/gm)];
  const last = imports.at(-1);
  const line = `import { adminNav } from "../admin/index.js";`;
  text = last ? `${text.slice(0, last.index! + last[0].length)}\n${line}${text.slice(last.index! + last[0].length)}` : `${line}\n${text}`;
  fs.writeFileSync(file, text);
  return true;
}

export async function makeAdmin(root: string, names: string[], options: MakeAdminOptions = {}): Promise<MakeAdminResult> {
  const m = t().admin.cli;
  const lines: string[] = [];
  const changed: string[] = [];
  if (!names.length && !options.all) return { ok: false, lines: [m.usage], changed };

  const config = resolveConfig(await loadConfigFile(root), process.env, root);
  const appDir = config.appDir;
  const schemaFile = findModule(path.join(appDir, "db", "schema"));
  if (!schemaFile) return { ok: false, lines: [m.noSchema(rel(root, path.join(appDir, "db", "schema.ts")))], changed };
  const schema = (await import(pathToFileURL(schemaFile).href)) as Record<string, unknown>;
  const tables = tablesOf(schema);
  if (!tables.size) return { ok: false, lines: [m.noTables(rel(root, schemaFile))], changed };

  const infos = new Map<string, TableInfo>();
  const byExport = new Map<string, { table: AnyTable; info: TableInfo }>();
  for (const [exportName, table] of tables) {
    const info = inspectTable(table);
    infos.set(info.name, info);
    byExport.set(exportName, { table, info });
  }

  const wanted: string[] = [];
  if (options.all) wanted.push(...byExport.keys());
  for (const raw of names) {
    const key = raw.toLowerCase();
    const match = [...byExport.entries()].find(([exp, v]) => exp.toLowerCase() === key || v.info.name.toLowerCase() === key || resourceName(v.info.name) === key);
    if (!match) return { ok: false, lines: [m.unknownTable(raw, [...byExport.values()].map((v) => v.info.name).join(", "))], changed };
    if (!wanted.includes(match[0])) wanted.push(match[0]);
  }

  const adminDir = path.join(appDir, "admin");
  const libUi = findModule(path.join(appDir, "lib", "ui"));
  const libAuth = findModule(path.join(appDir, "lib", "auth"));
  const hasLayout = Boolean(libUi && /export function appPage\(/.test(fs.readFileSync(libUi, "utf8")));
  const withAuth = Boolean(libAuth && /export const requireUserPage\b/.test(fs.readFileSync(libAuth, "utf8")));
  const dbModule = findModule(path.join(appDir, "db", "index"));
  const testDir = path.join(root, "test");
  const canTest = fs.existsSync(testDir) && Boolean(dbModule && /DATABASE_URL/.test(fs.readFileSync(dbModule, "utf8"))) && fs.existsSync(path.join(root, "drizzle"));
  let ok = true;
  const generated: string[] = [];

  const write = (file: string, content: string, created: boolean) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    changed.push(rel(root, file));
    lines.push(created ? m.created(rel(root, file)) : m.updated(rel(root, file)));
  };

  for (const exportName of wanted) {
    const { info } = byExport.get(exportName)!;
    if (!info.primaryKey) {
      lines.push(m.noPrimaryKey(info.name));
      continue;
    }
    const name = resourceName(info.name);
    const fields = defaultFields(info, infos);
    const missing = missingRequired(info, fields);
    const create = missing.length === 0;
    // Pesan ini hanya saat file dibuat atau diperbarui, bukan setiap kali dijalankan ulang.
    const noteCreate = () => {
      if (!create) lines.push(m.createDisabled(info.name, missing.join(", ")));
    };
    const file = path.join(adminDir, `${name}.ts`);
    if (!fs.existsSync(file)) {
      noteCreate();
      write(file, resourceFile(exportName, info, fields, create, name), true);
    } else {
      const text = fs.readFileSync(file, "utf8");
      const result = replaceBlock(text, "admin-resource", resourceBlock(exportName, info, fields, create, name), options.force);
      if (result.status === "missing") {
        lines.push(m.noMarkers(rel(root, file)));
        ok = false;
        continue;
      }
      if (result.status === "edited") {
        lines.push(m.edited(rel(root, file), "admin-resource"));
        ok = false;
        continue;
      }
      if (result.status === "updated") {
        noteCreate();
        write(file, result.text, false);
      }
      else lines.push(m.unchanged(rel(root, file)));
    }
    generated.push(name);

    const test = path.join(testDir, `admin-${name}.test.ts`);
    if (canTest && !fs.existsSync(test)) write(test, testFile(name, humanLabel(info.name), fields, create), true);
  }

  if (generated.length) {
    // Daftar tabel admin: tetap memuat tabel yang sudah terdaftar sebelumnya.
    const registry = path.join(adminDir, "index.ts");
    if (!fs.existsSync(registry)) {
      write(registry, registryFile(generated, hasLayout), true);
    } else {
      const text = fs.readFileSync(registry, "utf8");
      const names = [...registeredNames(text), ...generated];
      const result = replaceBlock(text, "admin-resources", registryBlock(names), options.force);
      if (result.status === "missing") {
        lines.push(m.noMarkers(rel(root, registry)));
        ok = false;
      } else if (result.status === "edited") {
        lines.push(m.edited(rel(root, registry), "admin-resources"));
        ok = false;
      } else if (result.status === "updated") write(registry, result.text, false);
    }

    const routes = config.routesDir;
    for (const [file, kind, marker] of [
      [path.join(routes, "admin", "index.ts"), "dashboard", "admin.dashboard"],
      [path.join(routes, "admin", "[...path].ts"), "handle", "admin.handle"],
    ] as const) {
      const existing = findModule(file.replace(/\.ts$/, ""));
      if (!existing) write(file, routeFile(kind, withAuth), true);
      else if (!fs.readFileSync(existing, "utf8").includes(marker)) lines.push(m.routeExists(rel(root, existing)));
    }
    if (!withAuth) lines.push(m.noAuth);

    if (libUi) {
      if (addNav(libUi)) {
        changed.push(rel(root, libUi));
        lines.push(m.navAdded(rel(root, libUi)));
      } else if (!fs.readFileSync(libUi, "utf8").includes("adminNav")) lines.push(m.navHint(rel(root, libUi)));
    }
    lines.push("", m.done(generated.length), m.next);
  }
  return { ok, lines, changed };
}
