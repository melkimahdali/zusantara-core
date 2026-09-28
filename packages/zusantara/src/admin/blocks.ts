import { createHash } from "node:crypto";

/**
 * Blok bertanda di file buatan generator. Hanya isi blok yang boleh ditulis ulang oleh generator;
 * sidik (sha256) isi blok disimpan di baris pembuka, jadi perubahan manual di dalam blok terdeteksi
 * dan tidak ditimpa diam-diam.
 *
 *   // zusantara:generated:begin admin-resource sha256=0123456789ab
 *   ...isi buatan generator...
 *   // zusantara:generated:end admin-resource
 */

const BEGIN = (id: string) => new RegExp(`^([ \\t]*)// zusantara:generated:begin ${id}(?: sha256=([0-9a-f]+))?[ \\t]*\\r?$`, "m");
const END = (id: string) => new RegExp(`^[ \\t]*// zusantara:generated:end ${id}[ \\t]*\\r?$`, "m");

function normalize(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

export function blockHash(body: string): string {
  return createHash("sha256").update(normalize(body)).digest("hex").slice(0, 12);
}

export function renderBlock(id: string, body: string): string {
  const clean = normalize(body);
  return `// zusantara:generated:begin ${id} sha256=${blockHash(clean)}\n${clean}\n// zusantara:generated:end ${id}`;
}

export interface FoundBlock {
  start: number;
  end: number;
  body: string;
  hash?: string;
  /** Isi blok sudah diubah sejak dibuat (sidiknya tidak cocok). */
  edited: boolean;
}

export function findBlock(text: string, id: string): FoundBlock | undefined {
  const begin = BEGIN(id).exec(text);
  if (!begin) return undefined;
  const after = begin.index + begin[0].length;
  const endMatch = END(id).exec(text.slice(after));
  if (!endMatch) return undefined;
  const body = text.slice(after, after + endMatch.index);
  const hash = begin[2];
  return { start: begin.index, end: after + endMatch.index + endMatch[0].length, body, hash, edited: hash !== undefined && hash !== blockHash(body) };
}

export type BlockResult = { status: "updated" | "unchanged"; text: string } | { status: "edited" | "missing"; text?: undefined };

/** Ganti isi blok `id` dengan `body`. Tidak mengubah apa pun bila isi blok sudah diubah manual (kecuali `force`). */
export function replaceBlock(text: string, id: string, body: string, force = false): BlockResult {
  const found = findBlock(text, id);
  if (!found) return { status: "missing" };
  if (found.edited && !force) return { status: "edited" };
  const next = text.slice(0, found.start) + renderBlock(id, body) + text.slice(found.end);
  return { status: next === text ? "unchanged" : "updated", text: next };
}
