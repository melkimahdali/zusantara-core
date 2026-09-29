---
title: Panel admin
order: 2
group: Front-End
description: Halaman kelola data dari schema database dengan satu perintah, lengkap dengan pencarian, filter, hak akses per role, relasi, impor/ekspor, log audit, konten, alur kerja, htmx, dan tes.
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

## Relasi

### Many-to-many

Tabel penghubung dengan dua foreign key (mis. `post_tags` dengan `post_id` dan `tag_id`) dikenali `make:admin`, yang menambahkan opsi `many` di file admin baru. Formulir mendapat kotak centang, dan daftar menampilkan labelnya sebagai tag.

```ts
export default defineResource({
  ...generated,
  table: posts,
  db,
  many: { tags: { through: postTags, label: "Tag" } },
});
```

### Data anak di halaman induk

Tabel lain di panel yang merujuk tabel ini tampil otomatis di halaman ubah induknya, mis. item pesanan di halaman pesanan. Tombol **Tambah** membuka formulir dengan induknya sudah terisi (`/admin/order-items/new?f_orderId=3`), dan **Lihat semua** membuka daftar yang sudah difilter. Matikan dengan `children: false`.

## Data massal

- **Aksi massal:** centang beberapa baris, pilih aksi (hapus, ubah enum atau boolean, aksi khusus, atau ekspor), lalu setujui di halaman konfirmasi yang menyebut jumlah dan daftar datanya. Setiap baris dicatat di log audit.
- **Ekspor CSV:** menu **Aksi lain → Ekspor CSV** mengekspor semua data yang cocok dengan pencarian dan filter saat itu. File dibuka rapi di Excel (UTF-8 dengan BOM), dan sel yang diawali `=`, `+`, `-`, atau `@` diamankan dari formula injection.
- **Impor CSV dan Excel (.xlsx):** unggah file, cocokkan kolom file dengan field (kolom bernama sama dipilih otomatis), lalu lihat pratinjau. Setiap baris diperiksa dengan aturan formulir; baris yang bermasalah ditandai per sel dan tidak disimpan. Kolom id yang terisi memperbarui data yang ada, kolom relasi boleh berisi id atau label (mis. nama kategori), angka seperti `Rp 12.000` dan tanggal `28/09/2026` dikenali. Paling banyak 5.000 baris sekali impor.
- **Filter dengan kalimat:** ketik mis. *"dibuat bulan ini, harga di atas 100 ribu"* atau *"status dibayar, terbaru"*. Kalimat diubah menjadi filter biasa di URL dan tertulis cara memahaminya. Kata yang tidak dipahami dipakai sebagai pencarian teks. Aturannya berjalan di server tanpa provider AI.

## Jejak data

- **Log audit:** setiap tambah, ubah, hapus, pulihkan, impor, pindah status, dan aksi khusus dicatat dengan waktu, pengguna, dan kolom yang berubah (sebelum dan sesudah). Lihat semuanya di **Log audit** (`/admin/_log`) dan ringkasannya di dasbor.
- **Riwayat revisi:** tombol **Riwayat** di halaman data menampilkan setiap perubahan dengan diff, dan **Kembalikan versi ini** memulihkan isi data ke versi mana pun.
- **Hapus lunak:** tabel dengan kolom `deletedAt` (atau `deleted_at`) yang boleh kosong tidak menghapus datanya, tetapi memindahkannya ke **Tempat sampah**. Dari sana data bisa dipulihkan atau dihapus permanen.
- **Urungkan:** setelah menghapus, pesan di pojok layar punya tombol **Urungkan**. Untuk tabel tanpa hapus lunak, datanya dibuat lagi dari salinan di log audit.

Log, catatan, dan pengaturan disimpan di tabel `zusantara_admin_log`, `zusantara_admin_notes`, dan `zusantara_settings` di database aplikasi. Tabel itu dibuat otomatis saat pertama dipakai, jadi tidak ada di `schema.ts` dan tidak perlu migrasi. Matikan log dengan `audit: false` di `defineAdmin` atau per tabel. Kolom rahasia tidak pernah masuk riwayat yang ditampilkan.

## Konten

- **Draf, terbit, dan terjadwal:** tabel dengan kolom enum `status` yang punya nilai `published` (atau `terbit`/`live`) dan kolom `publishedAt` dikenali sebagai konten. Waktu terbit diisi otomatis saat pertama terbit, dan waktu di masa depan membuat data tampil sebagai **Terjadwal**. `previewUrl: (row) => ...` menambah tombol **Pratinjau**.
- **Slug otomatis:** kolom `slug` yang dikosongkan dibuat dari judul (`Kopi Susu` menjadi `kopi-susu`, lalu `kopi-susu-2` bila sudah dipakai).
- **SEO:** kolom yang diawali `meta`, `seo`, atau `og` (mis. `metaTitle`, `metaDescription`, `ogImage`) dikelompokkan di bagian **Mesin pencari (SEO)** dengan saran panjang teks.
- **Dua bahasa:** kolom `<field>En` atau `<field>_en` (mis. `titleEn`) tampil bersebelahan dengan kolom aslinya.
- **Pustaka media** (`/admin/_media`): unggah, lihat, salin URL, dan hapus file di `public/uploads`.
- **Halaman pengaturan** (`/admin/_settings`): nama situs, kontak, jam buka, dan isian lain yang Anda tentukan. Aplikasi membacanya dengan `await admin.settings()`.

```ts
export const admin = defineAdmin({
  resources,
  settings: {
    fields: [
      { name: "siteName", label: "Nama situs", default: "Toko Kopi" },
      { name: "contactEmail", label: "Email kontak", type: "email" },
      { name: "openingHours", label: "Jam buka", type: "textarea" },
    ],
  },
});
```

## Alur kerja

```ts
export default defineResource({
  ...generated,
  table: posts,
  db,
  // Status hanya berubah lewat tombol; "Setujui" hanya untuk editor dan admin.
  workflow: {
    field: "status",
    transitions: [
      { from: "draft", to: "review", label: "Ajukan" },
      { from: "review", to: "published", label: "Setujui", roles: ["editor", "admin"] },
      { from: ["review", "published"], to: "draft", label: "Kembalikan ke draf" },
    ],
  },
  // Tombol di halaman data dan di aksi massal.
  actions: [
    { name: "invoice", label: "Kirim ulang invoice", job: "send-invoice" },
    { name: "feature", label: "Jadikan unggulan", run: async (rows) => { /* ... */ }, confirm: "Jadikan unggulan?" },
  ],
});
```

- **Transisi dan persetujuan:** tombol pindah status hanya muncul untuk role yang boleh, dan setiap pindah status dicatat.
- **Aksi khusus:** `run` untuk kode sendiri (boleh mengembalikan pesan), atau `job` untuk memasukkan [job](jobs.html) ke antrean dengan data `{ resource, ids }`.
- **Catatan internal:** kolom catatan di halaman data, hanya terlihat di panel admin.
- **Cetak dan PDF:** tombol **Cetak / PDF** membuka halaman rapi untuk dicetak atau disimpan sebagai PDF dari browser.

## Otomasi

"Bila data dibuat atau berubah, kirim email, panggil webhook, atau jalankan job." Otomasi berjalan setelah data tersimpan, dan kegagalannya dicatat di log aplikasi tanpa membatalkan penyimpanan. Minta saja ke Zusantara AI, mis. *"kirim email ke admin saat pesanan dibayar"*.

```ts
automations: [
  {
    on: "update",
    when: (row, change) => row.status === "paid" && "status" in change.changes,
    email: { to: "admin@toko.id", subject: "Pesanan {id} dibayar", text: "Total {total} dari {customerName}." },
  },
  { on: ["create", "update"], webhook: "https://hooks.example.com/pesanan" },
  { on: "delete", job: "hapus-berkas" },
],
```

## Pencarian global

Kotak cari di atas panel (**Ctrl+K** atau **⌘K**) mencari di semua tabel yang boleh Anda lihat, dengan lima hasil teratas per tabel.

## Ubah schema dari panel

Saat pengembangan, admin bisa membuka `/admin/_schema` untuk membuat tabel atau menambah kolom lewat formulir. Pratinjau menampilkan kode yang akan ditambahkan ke `schema.ts` dan perintah yang dijalankan; setelah disetujui, Zusantara mengubah schema, membuat dan menjalankan migrasi, lalu memperbarui panel admin. Halaman ini tidak ada di produksi. Perintah yang sama tersedia di CLI dan dipakai Zusantara AI:

```bash
npx zusantara make:table products name:text:required price:integer:default=0 status:enum(draft,published):default=draft
npx zusantara make:column products stock:integer:default=0
npx zusantara make:table products name:text --dry-run   # lihat kodenya saja
```

Setiap kolom ditulis `nama:tipe[:required][:unique][:default=nilai]`. Tipe: `text`, `longtext`, `integer`, `number`, `boolean`, `date`, `datetime`, `json`, `enum(a,b)`, dan `relation(tabel)`.

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
