import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import config, {
  commentPrefixesFor,
  denyPatternsFor,
  extOf,
  shellFor,
} from './config.js';

const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ------------------------------------------------------------------ layout */

export async function ensureLayout() {
  for (const dir of Object.values(config.dirs)) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

/* ------------------------------------------------------------- path guards */

export class SandboxError extends Error {
  constructor(message, code = 'SANDBOX_ERROR') {
    super(message);
    this.code = code;
    this.name = 'SandboxError';
  }
}

function assertNoNul(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new SandboxError('Path tidak valid.', 'INVALID_PATH');
  }
}

/** Pastikan `target` berada di dalam `base` (anti path traversal / symlink escape). */
function resolveInside(base, target, label = 'path') {
  assertNoNul(target);
  const baseResolved = path.resolve(base);
  const resolved = path.resolve(baseResolved, target);
  const rel = path.relative(baseResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SandboxError(`${label} berada di luar sandbox: ${target}`, 'PATH_ESCAPE');
  }
  return resolved;
}

/** Kalau target sudah ada, pastikan realpath-nya tetap di dalam base. */
async function assertRealpathInside(base, target, label = 'path') {
  let real;
  try {
    real = await fsp.realpath(target);
  } catch {
    return target; // belum ada; tidak ada symlink untuk diperiksa
  }
  return resolveInside(await fsp.realpath(base), real, label);
}

/** Deteksi path absolut lintas-platform (POSIX, drive Windows, UNC). */
const ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/** Resolusi nama script relatif terhadap folder scripts/. */
export async function resolveScriptPath(name) {
  assertNoNul(name);
  if (path.isAbsolute(name) || ABSOLUTE_RE.test(name)) {
    throw new SandboxError(
      'Gunakan path relatif terhadap folder scripts/ sandbox.',
      'INVALID_PATH',
    );
  }
  const ext = extOf(name);
  if (!config.extensions.includes(ext)) {
    throw new SandboxError(
      `Ekstensi tidak didukung: ${ext || '(tanpa ekstensi)'}. ` +
        `Hanya ${config.extensions.join(', ')} yang bisa dipakai.`,
      'INVALID_SCRIPT',
    );
  }
  const target = resolveInside(config.dirs.scripts, name, 'script');
  return assertRealpathInside(config.dirs.scripts, target, 'script');
}

/** True kalau nama file berakhiran salah satu ekstensi yang diizinkan. */
function isScriptFile(name) {
  return config.extensions.includes(extOf(name));
}

/* ------------------------------------------------------------ script files */

export async function listScripts() {
  await ensureLayout();
  const out = [];
  async function walk(dir, prefix = '') {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (isScriptFile(entry.name)) {
        const stat = await fsp.stat(full);
        out.push({
          name: rel,
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
        });
      }
    }
  }
  await walk(config.dirs.scripts);
  return out.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

export async function writeScript({ name, content, overwrite = false }) {
  await ensureLayout();
  assertNoNul(content);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > config.maxScriptBytes) {
    throw new SandboxError(
      `Ukuran script ${bytes} byte melebihi batas ${config.maxScriptBytes} byte.`,
      'TOO_LARGE',
    );
  }
  const target = await resolveScriptPath(name);
  const existed = fs.existsSync(target);
  if (existed && !overwrite) {
    throw new SandboxError(
      `Script sudah ada: ${name}. Gunakan overwrite=true untuk menimpa.`,
      'ALREADY_EXISTS',
    );
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  let body = content.replace(/^\uFEFF/, '');
  // bash gagal kalau ada \r di akhir baris (`\r: command not found`), jadi .sh/.bash
  // dinormalisasi ke LF. Dilaporkan balik supaya tidak diam-diam mengubah isi.
  let normalizedCrlf = false;
  if ((extOf(target) === '.sh' || extOf(target) === '.bash') && config.normalizeShLineEndings && /\r/.test(body)) {
    body = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    normalizedCrlf = true;
  }
  await fsp.writeFile(target, body, 'utf8');
  const entry = shellFor(target);
  return {
    name: path.relative(config.dirs.scripts, target).split(path.sep).join('/'),
    size_bytes: bytes,
    created: !existed,
    language: entry ? entry.label : null,
    interpreter: entry?.shell ?? null,
    interpreter_missing: entry?.missing ?? true,
    normalized_crlf: normalizedCrlf,
  };
}

export async function readScript(name) {
  const target = await resolveScriptPath(name);
  const stat = await fsp.stat(target);
  return {
    name: path.relative(config.dirs.scripts, target).split(path.sep).join('/'),
    size_bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
    content: await fsp.readFile(target, 'utf8'),
  };
}

export async function deleteScript(name) {
  const target = await resolveScriptPath(name);
  await fsp.unlink(target);
  return {
    name: path.relative(config.dirs.scripts, target).split(path.sep).join('/'),
    deleted: true,
  };
}

/* ------------------------------------------------------------- guardrails */

/**
 * Scan baris terhadap guardrail bahasa tsb. Komentar dibuang dulu per bahasa
 * (#, //, --, REM, ') supaya contoh berbahaya di komentar tidak memblokir
 * script yang sebenarnya aman.
 */
export function scanDenied(content, kind = 'sh') {
  const patterns = denyPatternsFor(kind);
  const prefixes = commentPrefixesFor(kind);
  const hits = [];
  const lines = String(content).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const stripped = line.trimStart();
    const isComment = prefixes.some(
      (prefix) => stripped.startsWith(prefix) || stripped.toLowerCase().startsWith(prefix.toLowerCase()),
    );
    const code = isComment ? '' : line;
    for (const { re, reason } of patterns) {
      if (re.test(code)) {
        hits.push({ line: index + 1, reason, text: line.trim().slice(0, 160) });
        break;
      }
    }
  }
  return hits;
}

/** Scan teks bebas (args executable) terhadap SEMUA guardrail yang aktif. */
function scanArgsDenied(text) {
  const hits = [];
  for (const [kind, patterns] of Object.entries(config.denySets)) {
    if (!config.denyEnabled || config.denyOff.has(kind)) continue;
    for (const { re, reason } of patterns) {
      if (re.test(text) && !hits.some((h) => h.reason === reason)) {
        hits.push({ reason });
      }
    }
  }
  return hits;
}

/* ------------------------------------------------------------ concurrency */

let active = 0;
const waiters = [];

async function acquire() {
  if (active < config.maxConcurrent) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}

function release() {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

/* ------------------------------------------------------------------- utils */

function clampTimeout(ms) {
  const value = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : config.defaultTimeoutMs;
  return Math.min(value, config.maxTimeoutMs);
}

/**
 * Susun argumen interpreter sesuai entri registry:
 * - powershell : <pre> -File <script> <args...>
 * - cmd        : /c <script> <args...>
 * - vbs/sh/py/... : <pre> <script> <args...>
 * Git Bash (cygwin) menerima path Windows asal ditulis dengan forward slash.
 */
function buildCommandArgs(entry, scriptPath, args) {
  const extra = args.map(String);
  const script =
    entry.kind === 'sh' && config.isWindows ? scriptPath.replace(/\\/g, '/') : scriptPath;
  return [...entry.pre, ...(entry.flag ? [entry.flag] : []), script, ...extra];
}

function truncate(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false, bytes: buf.length };
  return {
    text: `${buf.subarray(0, maxBytes).toString('utf8')}\n...[dipotong @ ${maxBytes} byte]`,
    truncated: true,
    bytes: buf.length,
  };
}

function validateExtraEnv(extra = {}) {
  const entries = Object.entries(extra);
  if (entries.length > config.maxEnvVars) {
    throw new SandboxError(
      `Maksimal ${config.maxEnvVars} env var tambahan per run.`,
      'INVALID_ENV',
    );
  }
  const clean = {};
  for (const [key, value] of entries) {
    if (!ENV_NAME_RE.test(key)) {
      throw new SandboxError(`Nama env var tidak valid: ${key}`, 'INVALID_ENV');
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new SandboxError(`Nilai env var tidak valid: ${key}`, 'INVALID_ENV');
    }
    clean[key] = value;
  }
  return clean;
}

function buildEnv(runId, runDir, extra) {
  const env = {};
  for (const key of config.envAllowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Folder temp diarahkan ke dalam sandbox supaya tidak mengotori folder user.
  env.TEMP = runDir;
  env.TMP = runDir;
  env.SCRIPT_SANDBOX = '1';
  env.SCRIPT_SANDBOX_ROOT = config.dirs.root;
  env.SCRIPT_SANDBOX_RUN_ID = runId;
  // Kecilkan jejak interpreter yang ada di PATH.
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.POWERSHELL_TELEMETRY_OPTOUT = '1';
  env.POWERSHELL_UPDATECHECK = 'Off';
  if (env.PSModulePath) {
    env.PSModulePath = `${env.PSModulePath}${path.delimiter}${path.join(runDir, 'modules')}`;
  }
  return { ...env, ...extra };
}

async function pruneOld(dir, keep) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const runs = entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  let removed = 0;
  for (const name of runs.slice(keep)) {
    await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/* -------------------------------------------------------------- run engine */

/** Pastikan interpreter untuk ekstensi ini tersedia, atau tolak dengan jelas. */
function requireInterpreter(scriptPath) {
  const entry = shellFor(scriptPath);
  if (!entry) return null; // sudah dicek resolveScriptPath
  if (entry.missing) {
    throw new SandboxError(
      `Interpreter untuk ${extOf(scriptPath)} (${entry.label}) tidak ditemukan di PATH. ` +
        `Kandidat: ${entry.candidates.join(', ')}. Install dulu, atau arahkan via env ` +
        `SCRIPT_SANDBOX_SHELL_${entry.kind.toUpperCase()}=<path>.`,
      'INCOMPATIBLE',
    );
  }
  return entry;
}

export async function runScript({
  script,
  args = [],
  timeoutMs,
  timeout_ms,
  env = {},
  label,
  kind = 'file',
}) {
  await ensureLayout();

  const scriptPath = await resolveScriptPath(script);
  const entry = requireInterpreter(scriptPath);
  const extraEnv = validateExtraEnv(env);
  const stat = await fsp.stat(scriptPath);

  const hits = scanDenied(await fsp.readFile(scriptPath, 'utf8'), entry.kind);
  if (hits.length > 0) {
    throw new SandboxError(
      `Script diblokir guardrail: ${hits.map((h) => `baris ${h.line} (${h.reason})`).join(', ')}. ` +
        'Set SCRIPT_SANDBOX_DENY=0 untuk menonaktifkan.',
      'DENIED',
    );
  }

  // Schema tool menyebut field `timeout_ms`, jadi terima nama itu (dan alias
  // camelCase) — kalau tidak, nilai yang dikirim pemanggil diam-diam diabaikan.
  const limit = clampTimeout(timeout_ms ?? timeoutMs);
  const runId = `${stamp()}-${randomBytes(3).toString('hex')}`;
  const runDir = path.join(config.dirs.work, runId);
  const logDir = path.join(config.dirs.logs, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.mkdir(path.join(runDir, 'modules'), { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });

  const childEnv = buildEnv(runId, runDir, extraEnv);
  const commandArgs = buildCommandArgs(entry, scriptPath, args);
  const startedAt = new Date();

  await acquire();
  let result;
  try {
    result = await execute({
      shell: entry.shell,
      shellArgs: commandArgs,
      childEnv,
      runDir,
      logDir,
      limit,
      startedAt,
      meta: {
        run_id: runId,
        kind,
        label: label || null,
        script: path.relative(config.dirs.scripts, scriptPath).split(path.sep).join('/'),
        script_path: scriptPath,
        script_size_bytes: stat.size,
        language: entry.label,
        interpreter: entry.shell,
        interpreter_kind: entry.kind,
        args: args.map(String),
        timeout_ms: limit,
        extra_env_keys: Object.keys(extraEnv),
      },
    });
  } finally {
    release();
  }

  await Promise.all([
    pruneOld(config.dirs.work, config.keepRuns),
    pruneOld(config.dirs.logs, config.keepRuns),
  ]);

  return result;
}

/** Alias ekstensi -> kanonik, dipakai run_code untuk memilih bahasa. */
function extForLanguage(language) {
  const raw = String(language || '').toLowerCase().trim();
  const key = raw.startsWith('.') ? raw.slice(1) : raw;
  for (const entry of config.interpreters) {
    if (entry.kind === key || entry.exts.includes(`.${key}`) || entry.exts.includes(key)) {
      return entry.exts[0];
    }
  }
  const alias = { javascript: 'js', node: 'js', shell: 'sh', bash: 'sh', powershell: 'ps1', batch: 'bat', rb: 'rb' };
  if (alias[key]) return `.${alias[key]}`;
  throw new SandboxError(
    `Bahasa tidak dikenal: ${language}. Bahasa yang tersedia: ` +
      config.interpreters.map((i) => `${i.kind} (${i.exts.join('/')})`).join(', '),
    'INVALID_LANGUAGE',
  );
}

/** Jalankan kode inline: ditulis ke file sementara di scripts/__inline/ lalu dieksekusi. */
export async function runCode({ code, language = 'ps1', args = [], timeoutMs, timeout_ms, env = {}, label }) {
  assertNoNul(code);
  const ext = extForLanguage(language);
  if (!config.extensions.includes(ext)) {
    throw new SandboxError(
      `Bahasa ${language} dinonaktifkan di device ini (ekstensi ${ext}).`,
      'INCOMPATIBLE',
    );
  }
  const runId = `${stamp()}-${randomBytes(3).toString('hex')}`;
  await ensureLayout();
  const relName = `__inline/inline-${runId}${ext}`;
  await writeScript({ name: relName, content: code, overwrite: true });
  try {
    return await runScript({
      script: relName,
      args,
      timeoutMs: timeout_ms ?? timeoutMs,
      env,
      label: label || 'inline',
      kind: 'inline',
    });
  } finally {
    // writeScript menaruh file di scripts/__inline/, jadi hapus dari sana juga.
    await fsp.rm(path.join(config.dirs.scripts, '__inline', `inline-${runId}${ext}`), { force: true }).catch(() => {});
  }
}

/**
 * Jalankan executable apa pun (hasil build, tool CLI, biner hasil kompilasi).
 * - nama tanpa path dicari di PATH; path absolut dipakai apa adanya
 * - tetap memakai sandbox yang sama: cwd per-run, env minimal, timeout, log
 * - args di-scan guardrail sebelum jalan
 * CATATAN: biner native TIDAK bisa dibatasi oleh sandbox lembut ini —
 * jalankan hanya yang kamu percaya.
 */
export async function runExecutable({ executable, args = [], timeoutMs, timeout_ms, env = {}, label }) {
  await ensureLayout();
  assertNoNul(executable);
  const extraEnv = validateExtraEnv(env);

  const absolute = path.isAbsolute(executable) || ABSOLUTE_RE.test(executable);
  const resolved = absolute
    ? fs.existsSync(executable)
      ? executable
      : null
    : findExecutableOnPath(executable);
  if (!resolved) {
    throw new SandboxError(
      `Executable tidak ditemukan: ${executable}`,
      'NOT_FOUND',
    );
  }

  const argsText = args.map(String).join(' ');
  const hits = scanArgsDenied(argsText);
  if (hits.length > 0) {
    throw new SandboxError(
      `Argumen diblokir guardrail: ${hits.map((h) => h.reason).join(', ')}. ` +
        'Set SCRIPT_SANDBOX_DENY=0 untuk menonaktifkan.',
      'DENIED',
    );
  }

  const limit = clampTimeout(timeout_ms ?? timeoutMs);
  const runId = `${stamp()}-${randomBytes(3).toString('hex')}`;
  const runDir = path.join(config.dirs.work, runId);
  const logDir = path.join(config.dirs.logs, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });

  const childEnv = buildEnv(runId, runDir, extraEnv);
  const startedAt = new Date();

  await acquire();
  let result;
  try {
    result = await execute({
      shell: resolved,
      shellArgs: args.map(String),
      childEnv,
      runDir,
      logDir,
      limit,
      startedAt,
      meta: {
        run_id: runId,
        kind: 'executable',
        label: label || null,
        script: null,
        script_path: null,
        script_size_bytes: null,
        language: null,
        interpreter: resolved,
        interpreter_kind: 'executable',
        args: args.map(String),
        timeout_ms: limit,
        extra_env_keys: Object.keys(extraEnv),
      },
    });
  } finally {
    release();
  }

  await Promise.all([
    pruneOld(config.dirs.work, config.keepRuns),
    pruneOld(config.dirs.logs, config.keepRuns),
  ]);

  return result;
}

/** Cari executable di PATH (PATHEXT-aware di Windows). */
function findExecutableOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = config.isWindows
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').toLowerCase().split(';')]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* folder tak terbaca, lanjut */
      }
    }
  }
  return null;
}

function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function execute({ shell, shellArgs, childEnv, runDir, logDir, limit, startedAt, meta }) {
  return new Promise((resolve) => {
    const stdoutFile = path.join(logDir, 'stdout.log');
    const stderrFile = path.join(logDir, 'stderr.log');
    const outStream = fs.createWriteStream(stdoutFile, { encoding: 'utf8' });
    const errStream = fs.createWriteStream(stderrFile, { encoding: 'utf8' });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;

    const child = spawn(shell, shellArgs, {
      cwd: runDir,
      env: childEnv,
      windowsHide: true,
      // Di Linux spawn jadi leader process group supaya killTree bisa menyapu
      // seluruh anak dengan satu sinyal ke -pid.
      detached: !config.isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      if (config.isWindows) child.kill('SIGKILL');
    }, limit);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < config.maxOutputBytes * 4) stdout += chunk;
      outStream.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < config.maxOutputBytes * 4) stderr += chunk;
      errStream.write(chunk);
    });
    child.on('error', (err) => {
      spawnError = err;
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      outStream.end();
      errStream.end();

      const finishedAt = new Date();
      const out = truncate(stdout, config.maxOutputBytes);
      const err = truncate(stderr, config.maxOutputBytes);

      const summary = {
        ok: !timedOut && !spawnError && code === 0,
        ...meta,
        exit_code: code,
        signal: signal || null,
        timed_out: timedOut,
        spawn_error: spawnError ? spawnError.message : null,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt - startedAt,
        stdout: out.text,
        stderr: err.text,
        stdout_truncated: out.truncated,
        stderr_truncated: err.truncated,
        stdout_bytes: out.bytes,
        stderr_bytes: err.bytes,
        cwd: runDir,
        log_dir: logDir,
        stdout_log: stdoutFile,
        stderr_log: stderrFile,
      };

      fsp
        .writeFile(path.join(logDir, 'result.json'), JSON.stringify(summary, null, 2), 'utf8')
        .catch(() => {});
      resolve(summary);
    });
  });
}

/** Matikan seluruh pohon proses: taskkill di Windows, sinyal process group di Linux. */
function killTree(pid) {
  if (!pid) return;
  if (config.isWindows) {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => {});
    } catch {
      /* best effort */
    }
    return;
  }
  // detached:true di spawn membuat child jadi leader group, jadi -pid = seluruh grup.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* proses sudah mati */
      }
    }
  }
}

/* ------------------------------------------------------------------- info */

export async function sandboxInfo() {
  await ensureLayout();
  const interpretersInfo = {};
  await acquire();
  try {
    for (const entry of config.interpreters) {
      interpretersInfo[entry.kind] = { ...entry, ...(await probeInterpreter(entry)) };
    }
  } finally {
    release();
  }

  const [workCount, logCount, scriptCount] = await Promise.all([
    countRunDirs(config.dirs.work),
    countRunDirs(config.dirs.logs),
    countScripts(config.dirs.scripts),
  ]);

  return {
    runtime: {
      platform: process.platform,
      node_version: process.version,
    },
    root: config.dirs.root,
    scripts_dir: config.dirs.scripts,
    work_dir: config.dirs.work,
    logs_dir: config.dirs.logs,
    extensions: config.extensions,
    interpreters: interpretersInfo,
    languages: config.interpreters.map((i) => ({
      kind: i.kind,
      label: i.label,
      exts: i.exts,
      available: !i.missing,
      interpreter: i.shell,
    })),
    limits: {
      default_timeout_ms: config.defaultTimeoutMs,
      max_timeout_ms: config.maxTimeoutMs,
      max_output_bytes: config.maxOutputBytes,
      max_concurrent: config.maxConcurrent,
      max_script_bytes: config.maxScriptBytes,
      keep_runs: config.keepRuns,
    },
    guardrails: {
      deny_enabled: config.denyEnabled,
      deny_off: [...config.denyOff],
      deny_rules: Object.fromEntries(
        Object.entries(config.denySets).map(([kind, patterns]) => [
          kind,
          denyPatternsFor(kind).map((d) => d.reason),
        ]),
      ),
    },
    env_allowlist: config.envAllowlist,
    counts: { scripts: scriptCount, work_dirs: workCount, log_dirs: logCount },
  };
}

/**
 * Jalankan interpreter sebentar untuk tahu apakah benar-benar bisa dipakai:
 * cek versi, lalu eksekusi no-op. `available` hanya true kalau resolved +
 * no-op jalan (kalau noopArgs didefinisikan).
 */
function probeInterpreter(entry) {
  if (entry.missing) return Promise.resolve({ available: false, version: null, error: 'interpreter tidak ditemukan' });

  const run = (args) =>
    new Promise((done) => {
      const child = spawn(entry.shell, args, {
        cwd: config.dirs.root,
        env: { ...pickProcessEnv(), TEMP: config.dirs.root, TMP: config.dirs.root },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => (out += c.toString()));
      child.on('error', (err) => done({ ok: false, output: '', error: err.message }));
      child.on('close', (code) => done({ ok: code === 0, output: out, error: code === 0 ? null : `exit ${code}` }));
    });

  return (async () => {
    let available = true;
    let error = null;
    if (entry.probe?.noopArgs) {
      const noop = await run([...entry.pre, ...entry.probe.noopArgs]);
      available = noop.ok;
      error = noop.error;
    }
    let version = null;
    if (entry.probe?.versionArgs) {
      const v = await run([...entry.pre, ...entry.probe.versionArgs]);
      version = v.ok ? v.output.split('\n')[0].trim() : null;
    }
    return { available, version, error };
  })();
}

function pickProcessEnv() {
  const env = {};
  for (const key of config.envAllowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function countRunDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name)).length;
  } catch {
    return 0;
  }
}

async function countScripts(dir) {
  let total = 0;
  const walk = async (current) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(current, entry.name));
      else if (isScriptFile(entry.name)) total += 1;
    }
  };
  try {
    await walk(dir);
  } catch {
    /* ignore */
  }
  return total;
}

export const readLog = async (runId, which = 'stdout') => {
  assertNoNul(runId);
  if (!RUN_ID_RE.test(runId)) throw new SandboxError('run_id tidak valid.', 'INVALID_PATH');
  const file = path.join(config.dirs.logs, runId, `${which}.log`);
  await assertRealpathInside(config.dirs.logs, file, 'log');
  return { run_id: runId, which, content: await fsp.readFile(file, 'utf8') };
};
