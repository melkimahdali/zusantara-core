import { defineResource, type GeneratedResource } from "zusantara/admin";
import { db } from "../db/index.js";
import { notes } from "../db/schema.js";

// zusantara:generated:begin admin-resource sha256=f6fd65dcc5f4
// Dibuat oleh `zusantara make:admin notes` dari schema database. Jalankan perintah itu lagi setelah schema
// berubah: hanya blok ini yang diperbarui. Ubah tampilan lewat `overrides` di bawah, bukan di sini.
const generated: GeneratedResource = {
  name: "notes",
  label: "Catatan",
  singular: "Catatan",
  titleField: "title",
  fields: [
    { name: "id", label: "ID", type: "number", form: false, sort: true },
    { name: "userId", label: "Pengguna", type: "relation", required: true, relation: { labelKey: "name" }, filter: true, sort: true },
    { name: "title", label: "Judul", type: "text", required: true, search: true, sort: true },
    { name: "body", label: "Isi", type: "textarea", list: false },
    { name: "createdAt", label: "Dibuat", type: "datetime", form: false, sort: true, filter: true },
    { name: "updatedAt", label: "Diperbarui", type: "datetime", form: false, sort: true },
  ],
};
// zusantara:generated:end admin-resource

export default defineResource({
  ...generated,
  table: notes,
  db,
  // Siapa yang boleh melihat, menambah, mengubah, dan menghapus (role dari ctx.state.user.role).
  access: { view: ["admin"], create: ["admin"], update: ["admin"], delete: ["admin"] },
  // Ubah field tanpa menyentuh blok di atas, mis. { price: { label: "Harga jual" }, notes: { list: false } }.
  overrides: {},
});
