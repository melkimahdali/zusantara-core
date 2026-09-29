import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readForm } from "../backend/upload.js";
import type { ZenContext } from "../core/context.js";
import type { ZenResponse } from "../core/response.js";
import { h, type Child } from "../core/view.js";
import { t } from "../i18n/index.js";
import { Alert, Button, Card, CodeBlock, Field, Form, FormActions, Select, Stack, Switch } from "../ui/index.js";
import { tableExports } from "./schema-edit.js";
import { cliArgs, parseColumnLines, planSchemaChange, schemaFile, type SchemaChange } from "./schema-apply.js";

/**
 * Halaman /admin/_schema (hanya saat pengembangan, role admin): buat tabel atau tambah kolom lewat
 * formulir. Pratinjau menampilkan kode dan perintah yang akan dijalankan; setelah disetujui, perintah
 * `zusantara make:table` / `make:column` dijalankan di latar belakang (schema.ts, db:generate,
 * db:migrate, make:admin), lalu server dev memuat ulang.
 */

interface PageKit {
  url: (...parts: (string | number)[]) => string;
  layout: (ctx: ZenContext, o: { title: string; subtitle?: string; status?: number }, ...children: Child[]) => ZenResponse;
  root: string;
}

function changeFrom(form: FormData): SchemaChange {
  const mode = String(form.get("mode") ?? "table");
  if (mode === "column") {
    const [column] = parseColumnLines(String(form.get("column") ?? ""));
    if (!column) throw new Error(t().admin.schema.noColumns);
    return { kind: "column", table: String(form.get("table") ?? ""), column };
  }
  const columns = parseColumnLines(String(form.get("columns") ?? ""));
  if (!columns.length) throw new Error(t().admin.schema.noColumns);
  return { kind: "table", table: { name: String(form.get("name") ?? "").trim(), columns, timestamps: form.getAll("timestamps").at(-1) !== "0" } };
}

/** Jalankan CLI proyek di latar belakang; keluaran ditulis ke .zusantara/logs/schema.log. */
function runDetached(root: string, args: string[]): string {
  const logDir = path.join(root, ".zusantara", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, "schema.log");
  const fd = fs.openSync(log, "a");
  fs.writeSync(fd, `\n# ${new Date().toISOString()} zusantara ${args.join(" ")}\n`);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = [path.join(here, "..", "cli.js"), path.join(root, "node_modules", "zusantara", "dist", "cli.js")].find((f) => fs.existsSync(f));
  const child = cli
    ? spawn(process.execPath, [cli, ...args], { cwd: root, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ZUSANTARA_NONINTERACTIVE: "1" } })
    : spawn("npx", ["zusantara", ...args], { cwd: root, detached: true, stdio: ["ignore", fd, fd], shell: process.platform === "win32" });
  child.unref();
  fs.closeSync(fd);
  return path.relative(root, log).split(path.sep).join("/");
}

export async function schemaPage(ctx: ZenContext, kit: PageKit): Promise<ZenResponse> {
  const m = t().admin.schema;
  const file = schemaFile(kit.root);
  if (!file) return kit.layout(ctx, { title: m.title, status: 404 }, h(Alert, { tone: "error" }, m.noSchema));
  const exports = tableExports(fs.readFileSync(file, "utf8"));
  let error: string | undefined;
  let values: Record<string, string> = {};

  if (ctx.method === "POST") {
    const form = await readForm(ctx, { maxBytes: "100kb" });
    values = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    try {
      const change = changeFrom(form);
      const plan = planSchemaChange(kit.root, change);
      const args = cliArgs(change);
      if (form.get("step") === "apply") {
        const log = runDetached(kit.root, args);
        return kit.layout(ctx, { title: m.title }, h(Stack, { gap: "md" }, h(Alert, { tone: "success" }, m.applied), h("p", { class: "zu-muted" }, m.logFile(log)), h(Button, { href: kit.url(), variant: "secondary" }, t().admin.dashboard)));
      }
      const hidden = [...form.entries()].filter(([k]) => k !== "step").map(([k, v]) => h("input", { type: "hidden", name: k, value: String(v) }));
      const steps = [`zusantara ${args.join(" ")}`, "  1. src/app/db/schema.ts", "  2. zusantara db:generate", "  3. zusantara db:migrate", `  4. zusantara make:admin ${plan.exportName}`].join("\n");
      return kit.layout(
        ctx,
        { title: m.previewTitle },
        h(
          Stack,
          { gap: "md" },
          h("p", null, m.previewLead),
          h(CodeBlock, { code: plan.added.join("\n"), title: path.relative(kit.root, file).split(path.sep).join("/"), lang: "ts" }),
          h(CodeBlock, { code: steps, title: m.commands, lang: "bash" }),
          h(Form, { action: kit.url("_schema") }, hidden, h("input", { type: "hidden", name: "step", value: "apply" }), h(FormActions, null, h(Button, null, m.apply), h(Button, { href: kit.url("_schema"), variant: "ghost" }, t().admin.cancel))),
        ),
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const tableForm = h(
    Card,
    { title: m.newTable },
    h(
      Form,
      { action: kit.url("_schema") },
      h("input", { type: "hidden", name: "mode", value: "table" }),
      h(Field, { name: "name", label: m.tableName, hint: m.tableNameHint, required: true, value: values.mode === "table" ? values.name : "" }),
      h(Field, { name: "columns", label: m.columns, type: "textarea", rows: 6, hint: m.columnsHint, required: true, value: values.mode === "table" ? values.columns : "", placeholder: "title:text:required\nprice:integer:default=0\nstatus:enum(draft,published):default=draft" }),
      h(Switch, { name: "timestamps", label: m.timestamps, checked: values.mode === "table" ? values.timestamps !== "0" : true }),
      h(FormActions, null, h(Button, null, m.preview)),
    ),
  );
  const columnForm = exports.length
    ? h(
        Card,
        { title: m.addColumn },
        h(
          Form,
          { action: kit.url("_schema") },
          h("input", { type: "hidden", name: "mode", value: "column" }),
          h(Select, { name: "table", label: m.table, value: values.mode === "column" ? values.table : "", options: exports.map((e) => ({ value: e, label: e })) }),
          h(Field, { name: "column", label: m.column, hint: m.columnsHint, required: true, value: values.mode === "column" ? values.column : "", placeholder: "phone:text" }),
          h(FormActions, null, h(Button, null, m.preview)),
        ),
      )
    : null;
  return kit.layout(
    ctx,
    { title: m.title, subtitle: m.lead, status: error ? 422 : 200 },
    h(Stack, { gap: "md" }, error ? h(Alert, { tone: "error" }, h("span", { class: "zu-admin-pre" }, error)) : null, h("p", { class: "zu-muted" }, m.types), tableForm, columnForm),
  );
}
