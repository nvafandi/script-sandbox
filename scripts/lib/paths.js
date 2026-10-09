/**
 * Portable helpers for the powershell-sandbox-mcp setup scripts.
 *
 * Same principle as the server: NO device path is hard-coded.
 * Every location is resolved from the runtime environment (HOME, LOCALAPPDATA, PATH,
 * os.tmpdir, ...) so the same scripts run on Windows/macOS/Linux and from
 * any project folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'script-sandbox';

/** Package name on the npm registry (different from the server name!). */
export const PACKAGE_NAME = 'script-sandbox';

/** Package root folder of the calling file (scripts in scripts/, libs in scripts/lib). */
export function packageRoot(fromFileUrl) {
  return path.resolve(path.dirname(fileURLToPath(fromFileUrl)), '..');
}

/** Per-user data folder, adapting to the device platform. */
export function userDataDir() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

/** Per-user config folder (XDG_CONFIG_HOME on Linux, ~/.config elsewhere). */
export function userConfigDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** Default sandbox root: os.tmpdir()/opencode/ps-sandbox (same as src/config.js). */
export function defaultSandboxRoot() {
  return path.join(os.tmpdir(), 'opencode', 'script-sandbox');
}

/**
 * OpenCode config location:
 * env `OPENCODE_CONFIG` (custom config file, per the OpenCode docs)
 * > the built-in global `~/.config/opencode/opencode.json`, which applies the same
 * on Windows/macOS/Linux.
 */
export function defaultOpencodeConfigPath() {
  const fromEnv = process.env.OPENCODE_CONFIG;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
}

/** Path with forward slashes, the common MCP config style. */
export const toSlashes = (p) => String(p).replace(/\\/g, '/');

/**
 * Expand path placeholders used by various clients:
 *   %APPDATA%/...  (Windows, Claude/Cline docs style)
 *   $HOME/...      (Unix)
 *   ~/...          (all platforms)
 * Unset variables are left as-is so they stay visible.
 */
export function expandPath(input) {
  const home = os.homedir();
  return String(input)
    .replace(/%([^%]+)%/g, (match, name) => process.env[name] || match)
    .replace(/^\$([A-Za-z_][A-Za-z0-9_]*)/, (match, name) => process.env[name] || match)
    .replace(/^~(?=$|[\\/])/, home);
}

/**
 * Find an executable on PATH (cross-platform). Windows uses PATHEXT
 * (.exe/.cmd/...) so `bash` without an extension is still found.
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
        /* unreadable folder, continue */
      }
    }
  }
  return null;
}

/**
 * `npm` on Windows is npm.cmd, and Node refuses to spawn `.cmd` without a shell
 * (EINVAL). So npm is invoked via npm-cli.js with node.exe —
 * no shell, no quoting issues. `npm_execpath` is available when the script
 * runs via `npm run`; the fallback is node's bundled npm.
 */
export function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  return candidates.find((p) => p.endsWith('.js') && fs.existsSync(p)) || null;
}

/** Quote for cmd.exe, used only on the shell fallback. */
const quoteForCmd = (arg) =>
  /[\s"&|<>^()%!]/.test(arg) ? `"${String(arg).replace(/"/g, '""')}"` : arg;

/** Run npm via node + npm-cli.js (see resolveNpmCli). */
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
      `npm ${args.join(' ')} failed (exit ${res.status})\n${(stdout + stderr).trim()}`,
    );
  }
  return { stdout, stderr };
}

/** Get a value from an object via dot-path ("mcp.servers"), null if missing. */
export function getDotPath(obj, dotPath) {
  return dotPath
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/** Set a value in an object via dot-path, creating missing intermediate objects. */
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
 * Find an installed server.js, in this order:
 * 1. --server <path> (handled by the caller)
 * 2. dedicated MCP npm install (userDataDir()/mcp-servers/powershell-sandbox)
 * 3. the package these scripts live in (repo / npm install of the package)
 * 4. global npm install (same node)
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
