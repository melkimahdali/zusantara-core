import { admin } from "../../admin/index.js";
import { requireUserPage } from "../../lib/auth.js";

// Every admin table page: list, add, edit, delete. Access is checked per table in src/app/admin/<table>.ts.
export const middleware = [requireUserPage];
export const GET = admin.handle;
export const POST = admin.handle;
