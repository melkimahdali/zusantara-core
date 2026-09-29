import type { ZenContext } from "../core/context.js";
import { t } from "../i18n/index.js";
import type { AdminResource, AutomationEvent } from "./resource.js";

/**
 * Menjalankan `automations` sebuah tabel admin setelah data tersimpan: email, webhook, job, atau
 * fungsi sendiri. Kegagalan dicatat di log aplikasi dan tidak membatalkan penyimpanan data.
 */

/** "Pesanan {id} dari {customerName}" -> nilai kolom data. */
export function fillTemplate(text: string, row: Record<string, unknown>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => {
    const v = row[key];
    if (v === undefined) return all;
    if (v === null) return "";
    return v instanceof Date ? v.toISOString() : String(v);
  });
}

function jsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Record<string, unknown>;
}

export async function runAutomations(
  r: AdminResource,
  event: AutomationEvent,
  row: Record<string, unknown>,
  ctx: ZenContext | undefined,
  changes: Record<string, [unknown, unknown]> = {},
): Promise<void> {
  const list = (r.options.automations ?? []).filter((a) => (Array.isArray(a.on) ? a.on : [a.on]).includes(event));
  if (!list.length) return;
  const safe = r.snapshotOf(row);
  const payload = { event, resource: r.name, id: r.idOf(row), row: jsonSafe(safe), changes: jsonSafe(changes as Record<string, unknown>) };
  for (const [i, a] of list.entries()) {
    try {
      if (a.when && !a.when(safe, { event, changes })) continue;
      if (a.email) {
        const { sendMail } = await import("../backend/mail.js");
        await sendMail({ to: fillTemplate(a.email.to, safe), subject: fillTemplate(a.email.subject, safe), text: fillTemplate(a.email.text, safe) });
      }
      if (a.webhook) {
        const res = await fetch(a.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      if (a.job) {
        const { enqueue } = await import("../backend/jobs.js");
        await enqueue(a.job, payload);
      }
      if (a.run) await a.run(safe, ctx, { event, changes });
    } catch (err) {
      const message = t().admin.x.automationFailed(r.name, i + 1, err instanceof Error ? err.message : String(err));
      if (ctx) ctx.logger.warn(message);
      else console.warn(message);
    }
  }
}
