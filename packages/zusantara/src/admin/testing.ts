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

/** File untuk formulir unggah di tes, mis. { file: { name: "produk.csv", type: "text/csv", content: "name\nKopi" } }. */
export interface TestFile {
  name: string;
  type?: string;
  content: string | Uint8Array;
}

export interface TestRequestOptions {
  htmx?: boolean;
  target?: string;
  /** Kirim sebagai multipart/form-data dengan file ini (impor, unggah media). */
  files?: Record<string, TestFile>;
}

export type TestFields = Record<string, string | number | boolean | (string | number)[]>;

export interface AdminTester {
  get(path: string, user?: AdminUser, options?: TestRequestOptions): Promise<TestResponse>;
  post(path: string, fields: TestFields, user?: AdminUser, options?: TestRequestOptions): Promise<TestResponse>;
}

function pairs(fields: TestFields): [string, string][] {
  return Object.entries(fields).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x): [string, string] => [k, String(x)]) : [[k, String(v)] as [string, string]]));
}

/** Badan multipart/form-data sederhana untuk tes. */
function multipart(fields: TestFields, files: Record<string, TestFile>): { body: Buffer; type: string } {
  const boundary = `----zusantara${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of pairs(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const [k, f] of Object.entries(files)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${f.name}"\r\nContent-Type: ${f.type ?? "application/octet-stream"}\r\n\r\n`));
    parts.push(typeof f.content === "string" ? Buffer.from(f.content) : Buffer.from(f.content));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

async function run(panel: AdminPanel, method: string, path: string, user: AdminUser | undefined, body: string | Buffer | undefined, options: TestRequestOptions & { type?: string } = {}): Promise<TestResponse> {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = path;
  req.headers = { host: "localhost" };
  if (body !== undefined) {
    req.headers["content-type"] = options.type ?? "application/x-www-form-urlencoded";
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
    post: (path, fields, user, options) => {
      if (options?.files) {
        const m = multipart(fields, options.files);
        return run(panel, "POST", path, user, m.body, { ...options, type: m.type });
      }
      return run(panel, "POST", path, user, new URLSearchParams(pairs(fields)).toString(), options);
    },
  };
}
