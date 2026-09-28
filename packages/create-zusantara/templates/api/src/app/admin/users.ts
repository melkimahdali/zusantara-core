import { AdminError, defineResource, type GeneratedResource } from "zusantara/admin";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

// zusantara:generated:begin admin-resource sha256=659b40359f2a
// Dibuat oleh `zusantara make:admin users` dari schema database. Jalankan perintah itu lagi setelah schema
// berubah: hanya blok ini yang diperbarui. Ubah tampilan lewat `overrides` di bawah, bukan di sini.
const generated: GeneratedResource = {
  name: "users",
  label: "Pengguna",
  singular: "Pengguna",
  titleField: "name",
  create: false,
  fields: [
    { name: "id", label: "ID", type: "number", form: false, sort: true },
    { name: "email", label: "Email", type: "email", required: true, search: true, sort: true },
    { name: "name", label: "Nama", type: "text", required: true, search: true, sort: true },
    { name: "role", label: "Peran", type: "enum", options: ["user", "admin"], filter: true, sort: true, inline: true },
    { name: "createdAt", label: "Dibuat", type: "datetime", form: false, sort: true, filter: true },
  ],
};
// zusantara:generated:end admin-resource

export default defineResource({
  ...generated,
  table: users,
  db,
  // Siapa yang boleh melihat, menambah, mengubah, dan menghapus (role dari ctx.state.user.role).
  // Akun baru dibuat lewat halaman daftar, dan akun tidak dihapus dari panel (catatannya ikut terkait).
  access: { view: ["admin"], update: ["admin"], delete: false },
  // Ubah field tanpa menyentuh blok di atas, mis. { price: { label: "Harga jual" }, notes: { list: false } }.
  overrides: {},
  // Admin tidak bisa mencabut perannya sendiri, jadi panel tidak pernah kehilangan admin terakhir tanpa sengaja.
  beforeSave(values, ctx, existing) {
    const me = ctx.state.user as { id?: number } | undefined;
    if (existing && existing.id === me?.id && values.role !== undefined && values.role !== "admin") throw new AdminError("Anda tidak bisa mencabut peran admin Anda sendiri.", "role");
  },
});
