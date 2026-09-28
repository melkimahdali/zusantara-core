import { admin } from "../../admin/index.js";
import { requireUserPage } from "../../lib/auth.js";

// Dasbor admin. Hak akses dicek per tabel di src/app/admin/<tabel>.ts.
export const middleware = [requireUserPage];
export const GET = admin.dashboard;
