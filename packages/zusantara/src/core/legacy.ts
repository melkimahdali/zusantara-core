import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Pindah dari nama lama "Zentara" (sebelum 0.12.10). Sejak 0.13.1 nama lama tidak lagi dibaca saat
 * berjalan: `zusantara migrate:zusantara` memindahkan proyek sekali jalan, dan CLI memberi petunjuk
 * bila masih menemukan jejak nama lama.
 */

/** File config dengan nama lama. */
const LEGACY_CONFIG_FILES = ["zentara.config.mjs", "zentara.config.js"];

/** Proyek masih memakai nama lama (config, folder data, dependensi, atau variabel env ZENTARA_*). */
export function hasLegacyTraces(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (LEGACY_CONFIG_FILES.some((f) => fs.existsSync(path.join(cwd, f))) || fs.existsSync(path.join(cwd, ".zentara"))) return true;
  if (Object.keys(env).some((k) => k.startsWith("ZENTARA_"))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    return ["dependencies", "devDependencies"].some((f) => pkg[f]?.zentara !== undefined);
  } catch {
    return false;
  }
}

function moveDir(from: string, to: string): boolean {
  try {
    if (fs.existsSync(to) || !fs.statSync(from).isDirectory()) return false;
    fs.renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/** Tambahkan `.zusantara/` ke .gitignore proyek yang masih mengabaikan `.zentara`. */
function updateGitignore(cwd: string): void {
  const file = path.join(cwd, ".gitignore");
  try {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    if (!lines.some((l) => /^\/?\.zentara\/?$/.test(l)) || lines.some((l) => /^\/?\.zusantara\/?$/.test(l))) return;
    fs.writeFileSync(file, `${text}${text.endsWith("\n") ? "" : "\n"}.zusantara/\n`);
  } catch {
    // Tanpa .gitignore: tidak ada yang perlu diubah.
  }
}

/**
 * Pindahkan data lokal bernama lama: `.zentara/` di proyek dan `~/.zentara` (bila ZUSANTARA_HOME tidak diatur).
 * Mengembalikan daftar folder yang dipindah, untuk pemberitahuan di CLI.
 */
function migrateLegacyDirs(cwd: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const moved: string[] = [];
  if (moveDir(path.join(cwd, ".zentara"), path.join(cwd, ".zusantara"))) {
    updateGitignore(cwd);
    moved.push(".zentara/ → .zusantara/");
  }
  if (!env.ZUSANTARA_HOME && moveDir(path.join(home, ".zentara"), path.join(home, ".zusantara"))) moved.push("~/.zentara → ~/.zusantara");
  return moved;
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".zusantara", "coverage"]);

function* codeFiles(dir: string, depth = 0): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && depth < 12) yield* codeFiles(file, depth + 1);
    } else if (CODE_EXT.test(e.name)) {
      yield file;
    }
  }
}

function rewrite(file: string, change: (text: string) => string, changed: string[], cwd: string): void {
  try {
    const text = fs.readFileSync(file, "utf8");
    const next = change(text);
    if (next !== text) {
      fs.writeFileSync(file, next);
      changed.push(path.relative(cwd, file).split(path.sep).join("/"));
    }
  } catch {
    // File tidak bisa dibaca: lewati.
  }
}

/**
 * `zusantara migrate:zusantara`: pindahkan proyek yang dibuat dengan Zentara ke nama baru. Import "zentara/..."
 * menjadi "zusantara/...", dependensi dan script di package.json, zentara.config.* → zusantara.config.*,
 * ZENTARA_* di .env, dan folder .zentara/. Mengembalikan daftar file yang diubah.
 */
export function migrateProject(cwd: string, version: string): string[] {
  const changed: string[] = [];
  rewrite(
    path.join(cwd, "package.json"),
    (text) => {
      const pkg = JSON.parse(text) as Record<string, unknown>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const deps = pkg[field] as Record<string, string> | undefined;
        if (!deps || deps.zentara === undefined) continue;
        delete deps.zentara;
        deps.zusantara = `^${version}`;
        pkg[field] = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
      }
      const scripts = pkg.scripts as Record<string, string> | undefined;
      if (scripts) for (const [k, v] of Object.entries(scripts)) scripts[k] = v.replace(/\bzentara\b/g, "zusantara");
      const next = `${JSON.stringify(pkg, null, 2)}\n`;
      return JSON.stringify(JSON.parse(text)) === JSON.stringify(pkg) ? text : next;
    },
    changed,
    cwd,
  );
  const specifier = /(["'])zentara((?:\/[\w.-]+)*)\1/g;
  for (const file of codeFiles(cwd)) rewrite(file, (text) => text.replace(specifier, "$1zusantara$2$1"), changed, cwd);
  for (const name of [".env", ".env.example"]) rewrite(path.join(cwd, name), (text) => text.replace(/^(\s*(?:export\s+)?)ZENTARA_/gm, "$1ZUSANTARA_"), changed, cwd);
  for (const legacy of LEGACY_CONFIG_FILES) {
    const from = path.join(cwd, legacy);
    const to = path.join(cwd, legacy.replace("zentara", "zusantara"));
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.renameSync(from, to);
      changed.push(`${legacy} → ${path.basename(to)}`);
    }
  }
  changed.push(...migrateLegacyDirs(cwd));
  return changed;
}
