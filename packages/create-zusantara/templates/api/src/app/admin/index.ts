import { defineAdmin } from "zusantara/admin";
import { appPage } from "../lib/ui.js";

// zusantara:generated:begin admin-resources sha256=56fb73e96eae
import notesAdmin from "./notes.js";
import usersAdmin from "./users.js";

const resources = [notesAdmin, usersAdmin];
// zusantara:generated:end admin-resources

/** Panel admin di /admin (route src/app/routes/admin). Tabel ditambahkan oleh `zusantara make:admin <tabel>`. */
export const admin = defineAdmin({
  resources,
  // Kerangka halaman aplikasi, jadi panel admin memakai navigasi yang sama.
  layout: (ctx, options, ...children) => appPage(ctx, options, ...children),
  // Halaman pengaturan situs di /admin/_settings. Baca di route dengan: const s = await admin.settings();
  settings: {
    fields: [
      { name: "siteName", label: "Nama situs", default: "Aplikasi Saya" },
      { name: "contactEmail", label: "Email kontak", type: "email" },
      { name: "openingHours", label: "Jam buka", type: "textarea", hint: "Mis. Senin–Jumat 08.00–17.00" },
    ],
  },
});

/** Menu Admin untuk navigasi aplikasi (hanya muncul bagi pengguna yang punya akses). */
export const adminNav = admin.nav;
