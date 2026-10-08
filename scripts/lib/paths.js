/**
 * Helper portabel untuk script setup powershell-sandbox-mcp.
 *
 * Prinsipnya sama dengan servernya: TIDAK ada path device yang ditulis tetap.
 * Semua lokasi di-resolve dari environment runtime (HOME, LOCALAPPDATA, PATH,
 * os.tmpdir, ...) supaya skrip yang sama jalan di Windows/macOS/Linux dan di
 * folder project mana pun.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'script-sandbox';

/** Nama package di registry npm (berbeda dari nama server!). */
export const PACKAGE_NAME = 'script-sandbox';

/** Folder root package dari file yang memanggil (skrip di scripts/, lib di scripts/lib). */
export function packageRoot(fromFileUrl) {
  return path.resolve(path.dirname(fileURLToPath(fromFileUrl)), '..');
}

/** Folder data khusus user, menyesuaikan platform device. */
export function userDataDir() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

/** Folder config khusus user (XDG_CONFIG_HOME di Linux, ~/.config di lain). */
export function userConfigDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** Default root sandbox: os.tmpdir()/opencode/ps-sandbox (sama dengan src/config.js). */
export function defaultSandboxRoot() {
  return path.join(os.tmpdir(), 'opencode', 'script-sandbox');
}

/**
 * Lokasi config OpenCode:
 * env `OPENCODE_CONFIG` (custom config file, sesuai dokumentasi OpenCode)
 * > lokasi global bawaan `~/.config/opencode/opencode.json` yang berlaku sama
 * di Windows/macOS/Linux.
 */
export function defaultOpencodeConfigPath() {
  const fromEnv = process.env.OPENCODE_CONFIG;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
}

/** Path pakai separator depan, gaya config MCP yang umum. */
export const toSlashes = (p) => String(p).replace(/\\/g, '/');

/**
 * Expand placeholder path dari berbagai client:
 *   %APPDATA%/...  (Windows, gaya docs Claude/Cline)
 *   $HOME/...      (Unix)
 *   ~/...          (semua platform)
 * Variabel yang tidak terisi dipertahankan apa adanya supaya terlihat jelas.
 */
export function expandPath(input) {
  const home = os.homedir();
  return String(input)
    .replace(/%([^%]+)%/g, (match, name) => process.env[name] || match)
    .replace(/^\$([A-Za-z_][A-Za-z0-9_]*)/, (match, name) => process.env[name] || match)
    .replace(/^~(?=$|[\\/])/, home);
}

/**
 * Cari executable di PATH (lintas platform). Windows pakai PATHEXT
 * (.exe/.cmd/...) supaya `bash` tanpa ekstensi tetap ditemukan.
 */
export function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  const names =
    process.platform === 'win32' ? [cmd, ...exts.map((e) => `${cmd}${e.toLowerCase()}`)] : [cmd];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* folder tak terbaca, lanjut */
      }
    }
  }
  return null;
}

/**
 * `npm` di Windows berupa npm.cmd, dan Node menolak spawn `.cmd` tanpa shell
 * (EINVAL). Karena itu npm dipanggil lewat npm-cli.js dengan node.exe —
 * tanpa shell, tanpa masalah quoting. `npm_execpath` tersedia saat skrip
 * dijalankan lewat `npm run`; fallback-nya instalasi npm bawaan node.
 */
export function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  return candidates.find((p) => p.endsWith('.js') && fs.existsSync(p)) || null;
}

/** Quote untuk cmd.exe, dipakai hanya pada fallback shell. */
const quoteForCmd = (arg) =>
  /[\s"&|<>^()%!]/.test(arg) ? `"${String(arg).replace(/"/g, '""')}"` : arg;

/** Jalankan npm lewat node + npm-cli.js (lihat resolveNpmCli). */
export function runNpm(args, { cwd } = {}) {
  const npmCli = resolveNpmCli();
  const res = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawnSync(['npm', ...args.map(quoteForCmd)].join(' '), {
        cwd,
        encoding: 'utf8',
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

  if (res.error) throw res.error;
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  if (res.status !== 0) {
    throw new Error(
      `npm ${args.join(' ')} gagal (exit ${res.status})\n${(stdout + stderr).trim()}`,
    );
  }
  return { stdout, stderr };
}

/** Ambil nilai dari objek lewat dot-path ("mcp.servers"), null kalau tidak ada. */
export function getDotPath(obj, dotPath) {
  return dotPath
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/** Set nilai di objek lewat dot-path, membuat objek perantara yang belum ada. */
export function setDotPath(obj, dotPath, value) {
  const keys = dotPath.split('.').filter(Boolean);
  let cursor = obj;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] == null || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * Cari file server.js yang terpasang, urutannya:
 * 1. --server <path> (diproses pemanggil)
 * 2. instalasi npm khusus MCP (userDataDir()/mcp-servers/powershell-sandbox)
 * 3. package tempat skrip ini berada (repo / hasil npm install package)
 * 4. instalasi npm global (node yang sama)
 */
export function resolveServerPath(explicit, packageDir) {
  const candidates = [
    explicit,
    path.join(userDataDir(), 'mcp-servers', SERVER_NAME, 'node_modules', PACKAGE_NAME, 'src', 'server.js'),
    path.join(packageDir, 'src', 'server.js'),
    path.join(
      path.dirname(process.execPath),
      'node_modules',
      PACKAGE_NAME,
      'src',
      'server.js',
    ),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}
