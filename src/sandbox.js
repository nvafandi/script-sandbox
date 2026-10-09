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
    throw new SandboxError('Invalid path.', 'INVALID_PATH');
  }
}

/** Ensure `target` stays inside `base` (anti path traversal / symlink escape). */
function resolveInside(base, target, label = 'path') {
  assertNoNul(target);
  const baseResolved = path.resolve(base);
  const resolved = path.resolve(baseResolved, target);
  const rel = path.relative(baseResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SandboxError(`${label} is outside the sandbox: ${target}`, 'PATH_ESCAPE');
  }
  return resolved;
}

/** If the target already exists, ensure its realpath stays inside base. */
async function assertRealpathInside(base, target, label = 'path') {
  let real;
  try {
    real = await fsp.realpath(target);
  } catch {
    return target; // not there yet; no symlink to check
  }
  return resolveInside(await fsp.realpath(base), real, label);
}

/** Cross-platform absolute path detection (POSIX, Windows drive, UNC). */
const ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/** Resolve a script name relative to the scripts/ folder. */
export async function resolveScriptPath(name) {
  assertNoNul(name);
  if (path.isAbsolute(name) || ABSOLUTE_RE.test(name)) {
    throw new SandboxError(
      'Use a path relative to the sandbox scripts/ folder.',
      'INVALID_PATH',
    );
  }
  const ext = extOf(name);
  if (!config.extensions.includes(ext)) {
    throw new SandboxError(
      `Unsupported extension: ${ext || '(no extension)'}. ` +
        `Only ${config.extensions.join(', ')} can be used.`,
      'INVALID_SCRIPT',
    );
  }
  const target = resolveInside(config.dirs.scripts, name, 'script');
  return assertRealpathInside(config.dirs.scripts, target, 'script');
}

/** True if the file name ends with one of the allowed extensions. */
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
      `Script size ${bytes} bytes exceeds the ${config.maxScriptBytes}-byte limit.`,
      'TOO_LARGE',
    );
  }
  const target = await resolveScriptPath(name);
  const existed = fs.existsSync(target);
  if (existed && !overwrite) {
    throw new SandboxError(
      `Script already exists: ${name}. Use overwrite=true to replace it.`,
      'ALREADY_EXISTS',
    );
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  let body = content.replace(/^\uFEFF/, '');
  // bash fails on a trailing \r (`\r: command not found`), so .sh/.bash is
  // normalized to LF. Reported back so contents are not changed silently.
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
 * Scan lines against that language's guardrails. Comments are stripped first
 * per language (#, //, --, REM, ') so dangerous examples in comments do not
 * block scripts that are actually safe.
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

/** Scan free text (executable args) against ALL active guardrails. */
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
 * Build interpreter arguments per the registry entry:
 * - powershell : <pre> -File <script> <args...>
 * - cmd        : /c <script> <args...>
 * - java       : java <script.java> <args...> (source-file mode, JEP 330)
 * - vbs/sh/py/... : <pre> <script> <args...>
 * Git Bash (cygwin) accepts Windows paths as long as they use forward slashes.
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
    text: `${buf.subarray(0, maxBytes).toString('utf8')}\n...[truncated @ ${maxBytes} bytes]`,
    truncated: true,
    bytes: buf.length,
  };
}

function validateExtraEnv(extra = {}) {
  const entries = Object.entries(extra);
  if (entries.length > config.maxEnvVars) {
    throw new SandboxError(
      `At most ${config.maxEnvVars} extra env vars per run.`,
      'INVALID_ENV',
    );
  }
  const clean = {};
  for (const [key, value] of entries) {
    if (!ENV_NAME_RE.test(key)) {
      throw new SandboxError(`Invalid env var name: ${key}`, 'INVALID_ENV');
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new SandboxError(`Invalid env var value: ${key}`, 'INVALID_ENV');
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
  // Point the temp folder into the sandbox so it does not pollute the user's folder.
  env.TEMP = runDir;
  env.TMP = runDir;
  env.SCRIPT_SANDBOX = '1';
  env.SCRIPT_SANDBOX_ROOT = config.dirs.root;
  env.SCRIPT_SANDBOX_RUN_ID = runId;
  // Shrink the footprint of interpreters found on PATH.
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

/** Ensure the interpreter for this extension is available, or reject with a clear message. */
function requireInterpreter(scriptPath) {
  const entry = shellFor(scriptPath);
  if (!entry) return null; // already checked by resolveScriptPath
  if (entry.missing) {
    throw new SandboxError(
      `Interpreter for ${extOf(scriptPath)} (${entry.label}) not found on PATH. ` +
        `Candidates: ${entry.candidates.join(', ')}. Install it first, or point via env ` +
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
      `Script blocked by guardrails: ${hits.map((h) => `line ${h.line} (${h.reason})`).join(', ')}. ` +
        'Set SCRIPT_SANDBOX_DENY=0 to disable.',
      'DENIED',
    );
  }

  // The tool schema mentions the `timeout_ms` field, so accept that name (and the
  // camelCase alias) — otherwise the caller's value would be silently ignored.
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

/** Extension alias -> canonical, used by run_code to pick the language. */
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
    `Unknown language: ${language}. Available languages: ` +
      config.interpreters.map((i) => `${i.kind} (${i.exts.join('/')})`).join(', '),
    'INVALID_LANGUAGE',
  );
}

/** Run inline code: write it to a temporary file in scripts/__inline/ then execute it. */
export async function runCode({ code, language = 'ps1', args = [], timeoutMs, timeout_ms, env = {}, label }) {
  assertNoNul(code);
  const ext = extForLanguage(language);
  if (!config.extensions.includes(ext)) {
    throw new SandboxError(
      `Language ${language} is disabled on this device (extension ${ext}).`,
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
    // writeScript puts the file in scripts/__inline/, so remove it from there too.
    await fsp.rm(path.join(config.dirs.scripts, '__inline', `inline-${runId}${ext}`), { force: true }).catch(() => {});
  }
}

/**
 * Run any executable (build output, CLI tools, compiled binaries).
 * - a bare name is looked up on PATH; an absolute path is used as-is
 * - same sandbox as runs: per-run cwd, minimal env, timeout, logs
 * - args are scanned against guardrails before running
 * NOTE: native binaries CANNOT be constrained by this soft sandbox —
 * only run what you trust.
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
      `Executable not found: ${executable}`,
      'NOT_FOUND',
    );
  }

  const argsText = args.map(String).join(' ');
  const hits = scanArgsDenied(argsText);
  if (hits.length > 0) {
    throw new SandboxError(
      `Arguments blocked by guardrails: ${hits.map((h) => h.reason).join(', ')}. ` +
        'Set SCRIPT_SANDBOX_DENY=0 to disable.',
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

/** Find an executable on PATH (PATHEXT-aware on Windows). */
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
        /* unreadable folder, keep going */
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
      // On Linux spawn becomes the process-group leader so killTree can sweep
      // all descendants with a single signal to -pid.
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

/** Kill the whole process tree: taskkill on Windows, process-group signal on Linux. */
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
  // detached:true in spawn makes the child a group leader, so -pid = the whole group.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* process already dead */
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
 * Run the interpreter briefly to see if it really works: check the version,
 * then run a no-op. `available` is true only if resolved + the no-op runs
 * (when noopArgs is defined).
 */
function probeInterpreter(entry) {
  if (entry.missing) return Promise.resolve({ available: false, version: null, error: 'interpreter not found' });

  const run = (args) =>
    new Promise((done) => {
      const child = spawn(entry.shell, args, {
        cwd: config.dirs.root,
        env: { ...pickProcessEnv(), TEMP: config.dirs.root, TMP: config.dirs.root },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let errOut = '';
      child.stdout.on('data', (c) => (out += c.toString()));
      child.stderr.on('data', (c) => (errOut += c.toString()));
      child.on('error', (err) => done({ ok: false, output: '', error: err.message }));
      child.on('close', (code) => {
        if (code === 0) return done({ ok: true, output: out, error: null });
        // Include the first error line so the cause of `available:false`
        // reads clearly (e.g. "Error: Could not find or load main class"),
        // not just "exit 1".
        const detail = `${errOut}\n${out}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        done({
          ok: false,
          output: out,
          error: detail ? `exit ${code}: ${detail.slice(0, 200)}` : `exit ${code}`,
        });
      });
    });

  return (async () => {
    let available = true;
    let error = null;
    if (entry.probe?.noopFile) {
      // Languages that need a build step (e.g. .java -> source-file mode) are
      // verified with a real sample file, not just `--version`.
      const dir = await fsp.mkdtemp(path.join(config.dirs.root, 'probe-'));
      const file = path.join(dir, entry.probe.noopFile.name);
      try {
        await fsp.writeFile(file, entry.probe.noopFile.code, 'utf8');
        const noop = await run([
          ...entry.pre,
          ...(entry.flag ? [entry.flag] : []),
          file,
        ]);
        available = noop.ok;
        error = noop.error;
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    } else if (entry.probe?.noopArgs) {
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
  if (!RUN_ID_RE.test(runId)) throw new SandboxError('Invalid run_id.', 'INVALID_PATH');
  const file = path.join(config.dirs.logs, runId, `${which}.log`);
  await assertRealpathInside(config.dirs.logs, file, 'log');
  return { run_id: runId, which, content: await fsp.readFile(file, 'utf8') };
};
