import { admin } from "../../admin/index.js";
import { requireUserPage } from "../../lib/auth.js";

// Semua halaman tabel admin: daftar, tambah, ubah, hapus. Hak akses dicek per tabel di src/app/admin/<tabel>.ts.
export const middleware = [requireUserPage];
export const GET = admin.handle;
export const POST = admin.handle;
