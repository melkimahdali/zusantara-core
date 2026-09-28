/**
 * Panel admin Zusantara (`zusantara/admin`): halaman daftar, tambah, ubah, dan hapus dari tabel
 * Drizzle, dengan pencarian, filter, urutan, hak akses per role, dan htmx. Biasanya dibuat oleh
 * `zusantara make:admin <tabel>`, bukan ditulis tangan.
 */
export { defineAdmin, type AdminLayout, type AdminLayoutOptions, type AdminOptions, type AdminPanel } from "./panel.js";
export { AdminError, AdminResource, defineResource, type AccessRule, type AdminAction, type AdminUser, type GeneratedResource, type ListQuery, type ListResult, type ResourceOptions } from "./resource.js";
export { defaultFields, humanLabel, type AdminField, type FieldType } from "./fields.js";
export { inspectTable, isSecretColumn, tablesOf, type ColumnInfo, type TableInfo } from "./schema.js";
export { testAdmin, type AdminTester, type TestResponse } from "./testing.js";
