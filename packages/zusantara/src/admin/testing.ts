import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createContext } from "../core/context.js";
import { HttpError } from "../core/errors.js";
import { ZenLogger } from "../core/logger.js";
import { ZenResponse } from "../core/response.js";
import type { AdminPanel } from "./panel.js";
import type { AdminUser } from "./resource.js";

/**
 * Uji panel admin tanpa server dan tanpa login: permintaan dijalankan langsung ke handler panel
 * dengan `ctx.state.user` yang Anda tentukan. Dipakai tes buatan `zusantara make:admin`.
 *
 *   const t = testAdmin(admin);
 *   assert.equal((await t.get("/admin/products", { role: "admin" })).status, 200);
 *   assert.equal((await t.post("/admin/products", { name: "Kopi" }, { role: "admin" })).status, 303);
 */

export interface TestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface AdminTester {
  get(path: string, user?: AdminUser, options?: { htmx?: boolean; target?: string }): Promise<TestResponse>;
  post(path: string, fields: Record<string, string | number | boolean>, user?: AdminUser, options?: { htmx?: boolean; target?: string }): Promise<TestResponse>;
}

async function run(panel: AdminPanel, method: string, path: string, user: AdminUser | undefined, body: string | undefined, options: { htmx?: boolean; target?: string } = {}): Promise<TestResponse> {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = path;
  req.headers = { host: "localhost" };
  if (body !== undefined) {
    req.headers["content-type"] = "application/x-www-form-urlencoded";
    req.headers["content-length"] = String(Buffer.byteLength(body));
    req.push(body);
  }
  if (options.htmx) {
    req.headers["hx-request"] = "true";
    if (options.target) req.headers["hx-target"] = options.target;
  }
  req.push(null);
  const res = new ServerResponse(req);
  const ctx = createContext(req, res, { bodyLimit: 1024 * 1024, logger: new ZenLogger("silent") });
  if (user) ctx.state.user = { name: "Admin", email: "admin@example.test", ...user };
  const pathname = ctx.path.replace(/\/+$/, "") || "/";
  let result: unknown;
  try {
    result = pathname === panel.basePath ? await panel.dashboard(ctx) : await panel.handle(ctx);
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, headers: {}, body: err.expose ? err.message : "" };
    throw err;
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.getHeaders())) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  if (result instanceof ZenResponse) {
    for (const [k, v] of Object.entries(result.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
    const text = result.body === null ? "" : typeof result.body === "string" ? result.body : Buffer.from(result.body).toString("utf8");
    return { status: result.status, headers, body: text };
  }
  return { status: 200, headers, body: typeof result === "string" ? result : JSON.stringify(result) };
}

export function testAdmin(panel: AdminPanel): AdminTester {
  return {
    get: (path, user, options) => run(panel, "GET", path, user, undefined, options),
    post: (path, fields, user, options) =>
      run(panel, "POST", path, user, new URLSearchParams(Object.entries(fields).map(([k, v]): [string, string] => [k, String(v)])).toString(), options),
  };
}
