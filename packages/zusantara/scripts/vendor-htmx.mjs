#!/usr/bin/env node
// Salin htmx (https://htmx.org, lisensi 0BSD) ke src/ui/htmx.gen.ts, supaya framework menyajikannya di
// /_zusantara/htmx.js tanpa CDN dan tanpa dependency npm tambahan.
//
//   node scripts/vendor-htmx.mjs <folder paket htmx.org>   mis. hasil `npm pack htmx.org@2.0.11` yang diekstrak
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
if (!dir) {
  console.error("Pakai: node scripts/vendor-htmx.mjs <folder paket htmx.org>");
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const js = fs.readFileSync(path.join(dir, "dist", "htmx.min.js"), "utf8").trim();
const license = fs.readFileSync(path.join(dir, "LICENSE"), "utf8").trim();
const out = [
  `// Dibangkitkan oleh scripts/vendor-htmx.mjs dari htmx.org@${pkg.version}. Jangan diedit manual.`,
  `// htmx (c) Big Sky Software, lisensi Zero-Clause BSD (lihat HTMX_LICENSE).`,
  "",
  `export const HTMX_VERSION = ${JSON.stringify(pkg.version)};`,
  "",
  `export const HTMX_LICENSE = ${JSON.stringify(license)};`,
  "",
  `/** htmx.min.js. */`,
  `export const HTMX_JS = ${JSON.stringify(js)};`,
  "",
].join("\n");
fs.writeFileSync(path.join(ROOT, "src", "ui", "htmx.gen.ts"), out);
console.log(`src/ui/htmx.gen.ts: htmx ${pkg.version}, ${js.length} byte`);
