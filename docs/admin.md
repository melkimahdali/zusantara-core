---
title: Panel admin
order: 2
group: Front-End
description: Halaman kelola data dari schema database dengan satu perintah, lengkap dengan pencarian, filter, hak akses per role, htmx, dan tes.
---

# Panel admin

`zusantara make:admin` membuat halaman kelola data dari tabel di `src/app/db/schema.ts`: dasbor, daftar dengan pencarian, filter, dan urutan, formulir tambah dan ubah, hapus, ubah langsung di tabel, dan tesnya. Panel memakai kit UI dan tema aplikasi, bekerja tanpa JavaScript, dan lebih cepat dengan htmx.

```bash
npx zusantara make:admin products            # satu tabel (nama tabel atau nama export di schema)
npx zusantara make:admin products categories
npx zusantara make:admin --all               # semua tabel
```

Buka `/admin` saat `zusantara dev` berjalan. Proyek baru dari template `api` sudah punya panel untuk tabel `users` dan `notes`.

## File yang dibuat

| File | Isi |
|---|---|
| `src/app/admin/<tabel>.ts` | satu tabel: label, field, hak akses, dan penyesuaian Anda |
| `src/app/admin/index.ts` | daftar tabel panel dan `adminNav` untuk menu aplikasi |
| `src/app/routes/admin/index.ts` | dasbor `/admin` |
| `src/app/routes/admin/[...path].ts` | semua halaman tabel di bawah `/admin/*` |
| `test/admin-<tabel>.test.ts` | tes daftar, formulir, dan hak akses (bila proyek punya folder `test/` dan migrasi) |

Menu **Admin** ditambahkan ke `navFor()` di `src/app/lib/ui.ts`, dan hanya muncul bagi pengguna yang boleh melihat minimal satu tabel. Bila `src/app/lib/auth.ts` punya `requireUserPage`, route admin memakainya, jadi tamu diarahkan ke `/login`.

```ts
// src/app/admin/products.ts
import { defineResource, type GeneratedResource } from "zusantara/admin";
import { db } from "../db/index.js";
import { products } from "../db/schema.js";

// zusantara:generated:begin admin-resource sha256=4f0c2a9d1b7e
const generated: GeneratedResource = {
  name: "products",
  label: "Produk",
  singular: "Produk",
  titleField: "name",
  fields: [
    { name: "id", label: "ID", type: "number", form: false, sort: true },
    { name: "name", label: "Nama", type: "text", required: true, search: true, sort: true },
    { name: "status", label: "Status", type: "enum", options: ["draft", "live"], filter: true, sort: true, inline: true },
    { name: "categoryId", label: "Kategori", type: "relation", relation: { labelKey: "name" }, filter: true, sort: true },
  ],
};
// zusantara:generated:end admin-resource

export default defineResource({
  ...generated,
  table: products,
  db,
  access: { view: ["admin", "staff"], create: ["admin"], update: ["admin"], delete: ["admin"] },
  overrides: { name: { label: "Nama produk" } },
});
```

## Menjalankan ulang setelah schema berubah

Setelah menambah kolom, jalankan lagi `make:admin` untuk tabel itu. Generator hanya menulis ulang isi blok `zusantara:generated`, jadi `access`, `overrides`, dan kode Anda di luar blok tetap utuh.

Baris pembuka blok menyimpan sidik sha256 isinya. Bila isi blok diubah tangan, `make:admin` tidak menimpanya dan memberi tahu file mana yang dilewati. Pindahkan ubahan itu ke `overrides`, atau jalankan dengan `--force` bila memang ingin menimpanya.

Alur lengkap untuk *"tambah kolom status ke produk"*, yang juga dijalankan Zusantara AI:

```bash
# 1. tambah kolom di src/app/db/schema.ts
npx zusantara db:generate && npx zusantara db:migrate
npx zusantara make:admin products
npm test
```

## Field

Tipe field dibaca dari kolom Drizzle:

| Tipe | Dari kolom | Formulir | Daftar |
|---|---|---|---|
| `text`, `email`, `url`, `textarea` | teks (email/url/body/description dikenali dari nama) | input, textarea | teks, tautan |
| `number` | integer, real, numeric | input angka | angka berformat |
| `boolean` | `integer({ mode: "boolean" })`, `boolean()` | switch | Ya/Tidak, bisa diubah langsung |
| `enum` | `text({ enum: [...] })`, `pgEnum` | pilihan | badge, bisa diubah langsung |
| `date`, `datetime` | date, timestamp | input tanggal | tanggal lokal |
| `relation` | kolom dengan `.references()` | Combobox dengan pencarian di server | label data tujuan, bisa diklik |
| `image`, `file` | kolom bernama image/photo/avatar/file/... | FileInput dengan pratinjau | gambar kecil, tautan |
| `json` | `json()`, `text({ mode: "json" })` | textarea JSON | ringkasan |

Setiap field punya pengaturan yang bisa diubah lewat `overrides`:

| Opsi | Arti |
|---|---|
| `label`, `hint` | teks untuk manusia |
| `list: false` | tidak tampil di daftar |
| `form: false`, `readonly: true` | tidak ada di formulir, atau tampil tetapi tidak bisa diubah |
| `search`, `filter`, `sort` | ikut pencarian, punya filter, bisa diurutkan |
| `inline` | bisa diubah langsung di daftar (boolean dan enum) |
| `required` | wajib diisi |
| `options` | pilihan untuk enum |
| `types`, `maxBytes` | jenis dan ukuran file untuk image/file, sama seperti `saveUpload` |

Kolom rahasia (password, hash, token, secret, salt, api key, OTP, kode pemulihan) tidak pernah tampil di panel, di tes, maupun di `describe`, apa pun isi konfigurasinya. Bila ada kolom wajib yang tidak bisa diisi dari formulir, misalnya `password_hash`, tambah data untuk tabel itu dimatikan dan datanya dibuat dari kode aplikasi.

## Pencarian, filter, dan urutan

- Pencarian `?q=` mencari di semua field `search` (teks, tanpa membedakan huruf besar) dan juga ID bila angka.
- Filter sesuai tipe: pilihan untuk enum, Ya/Tidak untuk boolean, rentang dari/sampai untuk tanggal (dan untuk angka bila field-nya diberi `filter: true`). Filter relasi dibaca dari URL, mis. `/admin/notes?f_userId=3`.
- Klik judul kolom untuk mengurutkan. Urutan bawaan: `defaultSort`, atau data terbaru.
- Dengan htmx, hasil diperbarui saat mengetik tanpa memuat ulang halaman, dan URL di bilah alamat tetap bersih sehingga bisa dibagikan.

## Hak akses

```ts
access: {
  view: ["admin", "staff"],
  create: ["admin"],
  update: (user) => user.role === "admin" || user.id === 1,
  delete: false,
},
```

Setiap aksi (`view`, `create`, `update`, `delete`) diatur terpisah dengan daftar role, `true`/`false`, atau fungsi. Aksi yang tidak diisi hanya untuk role `admin`, dan tidak mewarisi `view`. Role dibaca dari `ctx.state.user.role`. Tamu mendapat 401 (atau diarahkan ke login oleh middleware), role lain 403. Tombol yang tidak boleh dipakai tidak ditampilkan.

## Validasi dan pesan error

Formulir yang salah dikembalikan dengan status 422 dan pesan di bawah field. Galat database juga diterjemahkan: nilai unik yang sudah dipakai muncul di field-nya ("Email ini sudah dipakai data lain."), dan data yang masih dirujuk tabel lain tidak dihapus.

Untuk aturan sendiri, pakai `beforeSave`. Fungsi ini juga dijalankan saat mengubah langsung di tabel (dengan `values` berisi satu kolom itu saja):

```ts
import { AdminError, defineResource } from "zusantara/admin";

export default defineResource({
  ...generated,
  table: products,
  db,
  beforeSave(values, ctx, existing) {
    if (typeof values.name === "string") values.slug = values.name.toLowerCase().replace(/\s+/g, "-");
    if (values.price !== undefined && Number(values.price) < 0) throw new AdminError("Harga tidak boleh negatif.", "price");
  },
});
```

## Tampilan

Panel memakai `appPage()` aplikasi bila ada, jadi navigasi dan tema sama dengan halaman lain; bila tidak, panel punya kerangka sendiri. Di layar HP, tabel berubah menjadi kartu per data. Semua halaman admin dikirim dengan `X-Robots-Tag: noindex` dan `Cache-Control: no-store`.

## Tanpa generator

`defineResource({ table, db })` cukup untuk tabel sederhana: nama, label, dan field dibaca langsung dari schema.

```ts
import { defineAdmin, defineResource } from "zusantara/admin";

export const admin = defineAdmin({
  resources: [defineResource({ table: products, db }), defineResource({ table: categories, db, access: { delete: false } })],
  basePath: "/admin",
});
```

## Menguji panel

`testAdmin(admin)` menjalankan permintaan langsung ke panel tanpa server dan tanpa login:

```ts
import { testAdmin } from "zusantara/admin";

const t = testAdmin(admin);
assert.equal((await t.get("/admin/products", { role: "admin" })).status, 200);
assert.equal((await t.post("/admin/products", { name: "Kopi", price: 18000 }, { role: "admin" })).status, 303);
assert.equal((await t.get("/admin/products", { role: "guest" })).status, 403);
```

## Manifest aplikasi: `zusantara describe`

```bash
npx zusantara describe          # ringkasan untuk dibaca
npx zusantara describe --json   # manifest untuk AI dan alat lain
```

Isinya: route dan method, tabel dengan kolom, relasi, dan tipe, panel admin dengan hak aksesnya, job, dan plugin. Kolom rahasia tidak ikut, hanya jumlahnya (`hiddenColumns`), dan isi data tidak pernah dibaca. `describe` juga menyarankan index untuk kolom yang dicari, difilter, atau diurutkan di panel tetapi belum punya index. Zusantara AI memakai manifest ini sebagai konteks, dan nanti menjadi alat utama `zusantara mcp`.

## htmx

Panel ini dibangun dengan htmx, yang sudah ada di Zusantara. Anda bisa memakainya di halaman sendiri lewat prop `hx` di kit UI; lihat [Kit UI: htmx](ui.html#htmx).
