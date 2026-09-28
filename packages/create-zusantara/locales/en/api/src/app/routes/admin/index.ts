import { admin } from "../../admin/index.js";
import { requireUserPage } from "../../lib/auth.js";

// Admin dashboard. Access is checked per table in src/app/admin/<table>.ts.
export const middleware = [requireUserPage];
export const GET = admin.dashboard;
