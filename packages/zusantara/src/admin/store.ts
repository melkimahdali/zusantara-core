import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { bigint, pgTable, serial, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ZenContext } from "../core/context.js";
import type { AdminUser } from "./resource.js";

/**
 * Tabel sistem panel admin di database aplikasi: log audit (juga riwayat revisi), catatan internal
 * per data, dan halaman pengaturan. Tabel dibuat otomatis saat pertama dipakai
 * (`CREATE TABLE IF NOT EXISTS`), jadi tidak perlu migrasi dan tidak ada di schema.ts Anda.
 */

export type LogAction = "create" | "update" | "delete" | "restore" | "revert" | "transition" | "import" | "action" | "destroy";

export interface LogEntry {
  id: number;
  at: Date;
  userId: string | null;
  userName: string | null;
  resource: string;
  recordId: string | null;
  action: LogAction | string;
  /** Kolom yang berubah: nama -> [sebelum, sesudah]. */
  changes: Record<string, [unknown, unknown]> | null;
  /** Isi data sesudah aksi (sebelum dihapus, untuk aksi delete). */
  snapshot: Record<string, unknown> | null;
}

export interface NoteEntry {
  id: number;
  at: Date;
  userName: string | null;
  body: string;
}

const sqliteLog = sqliteTable("zusantara_admin_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  userId: text("user_id"),
  userName: text("user_name"),
  resource: text("resource").notNull(),
  recordId: text("record_id"),
  action: text("action").notNull(),
  changes: text("changes"),
  snapshot: text("snapshot"),
});
const sqliteNotes = sqliteTable("zusantara_admin_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  userId: text("user_id"),
  userName: text("user_name"),
  resource: text("resource").notNull(),
  recordId: text("record_id").notNull(),
  body: text("body").notNull(),
});
const sqliteSettings = sqliteTable("zusantara_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: integer("updated_at").notNull(),
});

const pgLog = pgTable("zusantara_admin_log", {
  id: serial("id").primaryKey(),
  at: bigint("at", { mode: "number" }).notNull(),
  userId: pgText("user_id"),
  userName: pgText("user_name"),
  resource: pgText("resource").notNull(),
  recordId: pgText("record_id"),
  action: pgText("action").notNull(),
  changes: pgText("changes"),
  snapshot: pgText("snapshot"),
});
const pgNotes = pgTable("zusantara_admin_notes", {
  id: serial("id").primaryKey(),
  at: bigint("at", { mode: "number" }).notNull(),
  userId: pgText("user_id"),
  userName: pgText("user_name"),
  resource: pgText("resource").notNull(),
  recordId: pgText("record_id").notNull(),
  body: pgText("body").notNull(),
});
const pgSettings = pgTable("zusantara_settings", {
  key: pgText("key").primaryKey(),
  value: pgText("value"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

const DDL = {
  sqlite: [
    `CREATE TABLE IF NOT EXISTS zusantara_admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, user_name TEXT, resource TEXT NOT NULL, record_id TEXT, action TEXT NOT NULL, changes TEXT, snapshot TEXT)`,
    `CREATE INDEX IF NOT EXISTS zusantara_admin_log_record ON zusantara_admin_log (resource, record_id)`,
    `CREATE TABLE IF NOT EXISTS zusantara_admin_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, user_name TEXT, resource TEXT NOT NULL, record_id TEXT NOT NULL, body TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS zusantara_admin_notes_record ON zusantara_admin_notes (resource, record_id)`,
    `CREATE TABLE IF NOT EXISTS zusantara_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)`,
  ],
  postgres: [
    `CREATE TABLE IF NOT EXISTS zusantara_admin_log (id SERIAL PRIMARY KEY, at BIGINT NOT NULL, user_id TEXT, user_name TEXT, resource TEXT NOT NULL, record_id TEXT, action TEXT NOT NULL, changes TEXT, snapshot TEXT)`,
    `CREATE INDEX IF NOT EXISTS zusantara_admin_log_record ON zusantara_admin_log (resource, record_id)`,
    `CREATE TABLE IF NOT EXISTS zusantara_admin_notes (id SERIAL PRIMARY KEY, at BIGINT NOT NULL, user_id TEXT, user_name TEXT, resource TEXT NOT NULL, record_id TEXT NOT NULL, body TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS zusantara_admin_notes_record ON zusantara_admin_notes (resource, record_id)`,
    `CREATE TABLE IF NOT EXISTS zusantara_settings (key TEXT PRIMARY KEY, value TEXT, updated_at BIGINT NOT NULL)`,
  ],
};

type AnyDb = {
  select: (fields?: unknown) => any;
  insert: (table: unknown) => any;
  update: (table: unknown) => any;
  delete: (table: unknown) => any;
  run?: (query: SQL) => Promise<unknown>;
  execute?: (query: SQL) => Promise<unknown>;
};

/** Nilai yang aman disimpan sebagai JSON (Date -> ISO, Buffer dilewati). */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return undefined;
  if (typeof value === "bigint") return value.toString();
  return value;
}

function jsonOf(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v) && v.length === 2 && !Array.isArray(v[0])) out[k] = [plain(v[0]), plain(v[1])];
    else out[k] = plain(v);
  }
  return JSON.stringify(out);
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Nama dan id pengguna untuk log (tanpa kolom lain dari ctx.state.user). */
export function actorOf(ctx: ZenContext | undefined): { userId: string | null; userName: string | null } {
  const u = ctx?.state.user as AdminUser | undefined;
  if (!u) return { userId: null, userName: null };
  const id = u.id ?? u.email;
  const name = u.name ?? u.email ?? u.id;
  return { userId: id === undefined || id === null ? null : String(id), userName: name === undefined || name === null ? null : String(name) };
}

export class AdminStore {
  private ready: Promise<void> | undefined;
  private readonly t;

  constructor(
    private readonly db: AnyDb,
    readonly dialect: "sqlite" | "postgres",
  ) {
    this.t = dialect === "postgres" ? { log: pgLog, notes: pgNotes, settings: pgSettings } : { log: sqliteLog, notes: sqliteNotes, settings: sqliteSettings };
  }

  /** Buat tabel sistem bila belum ada (sekali per proses). */
  ensure(): Promise<void> {
    this.ready ??= (async () => {
      for (const statement of DDL[this.dialect]) {
        const q = sql.raw(statement);
        if (this.dialect === "postgres") await this.db.execute!(q);
        else await this.db.run!(q);
      }
    })().catch((err) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  async log(
    ctx: ZenContext | undefined,
    entry: { resource: string; recordId?: string | null; action: LogAction | string; changes?: Record<string, [unknown, unknown]> | null; snapshot?: Record<string, unknown> | null },
  ): Promise<void> {
    await this.ensure();
    await this.db.insert(this.t.log).values({
      at: Date.now(),
      ...actorOf(ctx),
      resource: entry.resource,
      recordId: entry.recordId ?? null,
      action: entry.action,
      changes: jsonOf(entry.changes),
      snapshot: jsonOf(entry.snapshot),
    });
  }

  private toEntry(row: Record<string, unknown>): LogEntry {
    return {
      id: Number(row.id),
      at: new Date(Number(row.at)),
      userId: (row.userId as string | null) ?? null,
      userName: (row.userName as string | null) ?? null,
      resource: String(row.resource),
      recordId: (row.recordId as string | null) ?? null,
      action: String(row.action),
      changes: parseJson(row.changes),
      snapshot: parseJson(row.snapshot),
    };
  }

  /** Riwayat satu data, terbaru dulu. */
  async history(resource: string, recordId: string, limit = 100): Promise<LogEntry[]> {
    await this.ensure();
    const l = this.t.log;
    const rows = await this.db.select().from(l).where(and(eq(l.resource, resource), eq(l.recordId, recordId))).orderBy(desc(l.id)).limit(limit);
    return (rows as Record<string, unknown>[]).map((r) => this.toEntry(r));
  }

  /** Log terbaru semua tabel (atau satu tabel), untuk halaman log audit. */
  async recent(options: { resource?: string; limit?: number; offset?: number } = {}): Promise<LogEntry[]> {
    await this.ensure();
    const l = this.t.log;
    const rows = await this.db
      .select()
      .from(l)
      .where(options.resource ? eq(l.resource, options.resource) : undefined)
      .orderBy(desc(l.id))
      .limit(options.limit ?? 50)
      .offset(options.offset ?? 0);
    return (rows as Record<string, unknown>[]).map((r) => this.toEntry(r));
  }

  async entry(id: number): Promise<LogEntry | undefined> {
    await this.ensure();
    const l = this.t.log;
    const rows = (await this.db.select().from(l).where(eq(l.id, id)).limit(1)) as Record<string, unknown>[];
    return rows[0] ? this.toEntry(rows[0]) : undefined;
  }

  async notes(resource: string, recordId: string): Promise<NoteEntry[]> {
    await this.ensure();
    const n = this.t.notes;
    const rows = (await this.db.select().from(n).where(and(eq(n.resource, resource), eq(n.recordId, recordId))).orderBy(desc(n.id)).limit(200)) as Record<string, unknown>[];
    return rows.map((r) => ({ id: Number(r.id), at: new Date(Number(r.at)), userName: (r.userName as string | null) ?? null, body: String(r.body) }));
  }

  async addNote(ctx: ZenContext | undefined, resource: string, recordId: string, body: string): Promise<void> {
    await this.ensure();
    await this.db.insert(this.t.notes).values({ at: Date.now(), ...actorOf(ctx), resource, recordId, body });
  }

  /** Semua pengaturan (kunci -> nilai). */
  async settings(): Promise<Record<string, unknown>> {
    await this.ensure();
    const rows = (await this.db.select().from(this.t.settings)) as { key: string; value: string | null }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value === null ? null : parseJson(r.value);
    return out;
  }

  async setSettings(values: Record<string, unknown>): Promise<void> {
    await this.ensure();
    const s = this.t.settings;
    for (const [key, value] of Object.entries(values)) {
      const row = { key, value: JSON.stringify(plain(value) ?? null), updatedAt: Date.now() };
      await this.db.insert(s).values(row).onConflictDoUpdate({ target: s.key, set: { value: row.value, updatedAt: row.updatedAt } });
    }
  }
}
