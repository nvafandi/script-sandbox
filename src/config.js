import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * script-sandbox configuration.
 *
 * Design highlight: execution is not written per language in the engine —
 * everything is declared in REGISTRY (extension -> interpreter -> argument
 * style -> guardrail). Adding a new language = adding an entry, not another
 * logic branch. Interpreters are resolved from the device PATH at startup.
 */

/** Env allowlist: only these variables are forwarded to the child process. */
const ENV_ALLOWLIST = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'PATH',
  'USERPROFILE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PSModulePath',
  'LANG',
];

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** Comma-separated list of values, lowercased and trimmed. */
function listEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return [];
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const IS_WINDOWS = process.platform === 'win32';

/** Sandbox root: always in the OS temp folder of the device (portable). */
const root = path.resolve(
  process.env.SCRIPT_SANDBOX_ROOT || path.join(os.tmpdir(), 'opencode', 'script-sandbox'),
);

/**
 * Find the first executable on PATH. On Windows candidates are checked with
 * PATHEXT (.exe/.cmd/...) so `python` is also found without an extension.
 */
function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* unreadable folder, keep going */
      }
    }
  }
  return null;
}

/**
 * POSIX shell for .sh/.bash.
 * On Windows the stock WindowsApps `bash.exe` is just a WSL interop launcher
 * that mangles Windows paths, so Git Bash (cygwin) is preferred:
 * 1. PATH, as long as it is not WindowsApps and the folder contains "Git"
 * 2. common install locations (Git may be installed outside PATH)
 * 3. any PATH entry other than WindowsApps
 * 4. 'bash' — let spawn search PATH
 */
function defaultShShell() {
  if (!IS_WINDOWS) return 'bash';
  const onPath = findOnPath(['bash.exe', 'bash']) || '';
  const usable = (p) => Boolean(p) && !/WindowsApps/i.test(p);
  if (usable(onPath) && /Git[\\/]/i.test(onPath)) return onPath;

  const candidates = [
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
  ];
  const known = candidates.find((candidate) => fs.existsSync(candidate));
  if (known) return known;
  if (usable(onPath)) return onPath;
  return 'bash';
}

/**
 * `java` fallback outside PATH (Windows). Many JDK installs (manual zips
 * from Temurin/Adoptium, Oracle, Corretto, Zulu, ...) never add their folder
 * to PATH even though `java` is still usable. Scan common vendor locations
 * and pick the highest version. (Non-Windows: PATH is enough.)
 */
function defaultJavaBin() {
  if (!IS_WINDOWS) return null;
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Amazon Corretto',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\OpenJDK',
    'C:\\Program Files (x86)\\Java',
  ];
  const score = (name) => {
    const match = name.match(/\d+/);
    return match ? Number.parseInt(match[0], 10) : 0;
  };
  let best = null;
  let bestScore = -1;
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // folder missing / unreadable
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bin = path.join(root, entry.name, 'bin', 'java.exe');
      if (!fs.existsSync(bin)) continue;
      const value = score(entry.name);
      if (value > bestScore) {
        bestScore = value;
        best = bin;
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------- guardrails */

/**
 * Lightweight guardrails (NOT a security boundary), grouped per OS/language
 * family to avoid cross-language false positives. Disable with
 * SCRIPT_SANDBOX_DENY=0, or per kind with SCRIPT_SANDBOX_DENY_OFF=sh,python.
 */
const PS_DENY = [
  { re: /\bFormat-Volume\b/i, reason: 'Format-Volume' },
  { re: /\bClear-Disk\b/i, reason: 'Clear-Disk' },
  { re: /\bInitialize-Disk\b/i, reason: 'Initialize-Disk' },
  { re: /\bRemove-Partition\b/i, reason: 'Remove-Partition' },
  {
    re: /\bRemove-Item\b[^\n]*-[^\n]*\b-[rR]ecurse\b[^\n]*\b([A-Za-z]:\\|C:\\|D:\\|E:\\)\s*$/i,
    reason: 'Remove-Item -Recurse on drive root',
  },
  { re: /\brd\s+\/[sq]\b/i, reason: 'rd /s' },
  { re: /\bformat\s+[a-z]:/i, reason: 'format drive' },
  { re: /\bRemove-CimInstance\b/i, reason: 'Remove-CimInstance' },
  { re: /\bStop-Computer\b/i, reason: 'Stop-Computer' },
  { re: /\bRestart-Computer\b/i, reason: 'Restart-Computer' },
  { re: /\bSet-ExecutionPolicy\b/i, reason: 'Set-ExecutionPolicy' },
  { re: /\bDisable-WindowsOptionalFeature\b/i, reason: 'Disable-WindowsOptionalFeature' },
  { re: /\breg(\.exe)?\s+delete\b/i, reason: 'reg delete' },
  { re: /\bcipher\s+[a-z]:\s*\/w/i, reason: 'cipher /w' },
];

const WIN_DENY = [
  { re: /\b(rd|rmdir)\s+\/[sq]\b/i, reason: 'rd /s' },
  { re: /\bdel\s+\/[sq]\b/i, reason: 'del /s /q' },
  { re: /\bformat\s+[a-z]:/i, reason: 'format drive' },
  { re: /\breg(\.exe)?\s+delete\b/i, reason: 'reg delete' },
  { re: /\b(shutdown|restart)\s*\/[sr]/i, reason: 'shutdown' },
  { re: /\bcipher\s+[a-z]:\s*\/w/i, reason: 'cipher /w' },
  { re: /\bbcdedit\b/i, reason: 'bcdedit' },
];

/**
 * Machine-power patterns, kept as named consts: UNIX_FS_DENY below filters by
 * reference (not by the human-readable reason), so rewording a reason can
 * never silently change which guardrails are shared.
 */
const MACHINE_POWER_RE = /\b(shutdown|reboot|halt|poweroff)\b/i;
const MACHINE_POWER_INIT_RE = /\binit\s+[06]\b/;

const UNIX_DENY = [
  { re: /\brm\b[^\n]*\s-[a-z]*[rf][a-z]*[^\n]*\s\/(?:\s|$)/, reason: 'rm -rf /' },
  { re: /\brm\b[^\n]*\s--no-preserve-root\b/i, reason: 'rm --no-preserve-root' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: 'mkfs' },
  { re: /\bwipefs\b/i, reason: 'wipefs' },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, reason: 'dd to device' },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)/i, reason: 'write to block device' },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'fork bomb' },
  { re: /\bchmod\b[^\n]*\s-[a-z]*r[a-z]*[^\n]*\s\/(?:\s|$)/i, reason: 'recursive chmod on root' },
  { re: MACHINE_POWER_RE, reason: 'shut down machine' },
  { re: MACHINE_POWER_INIT_RE, reason: 'init 0/6' },
  { re: /\bshred\b[^\n]*\s\/dev\//i, reason: 'shred device' },
];

const PY_DENY = [
  { re: /\bshutil\.rmtree\(\s*['"]\/['"]/i, reason: 'shutil.rmtree root' },
  { re: /\bos\.system\(\s*['"][^\n]*(mkfs|dd\s+[^\n]*of=\/dev\/)/i, reason: 'destructive command via os.system' },
  { re: /open\(\s*['"]\/dev\/(sd|nvme|hd)/i, reason: 'direct write to block device' },
];

const NODE_DENY = [
  { re: /\brm(Sync)?\(\s*['"]\/['"][^\n]*recursive/i, reason: 'recursive fs rm of root' },
  { re: /\bexec(Sync)?\(\s*['"][^\n]*(mkfs|dd\s+[^\n]*of=\/dev\/)/i, reason: 'destructive command via child_process' },
];

/**
 * UNIX patterns shared by common VM-based languages (Java, ...): only the
 * ones that damage the filesystem. The `shutdown|reboot|halt` and `init 0/6`
 * patterns are intentionally excluded — those words are common as identifiers
 * in code (e.g. `executor.shutdown()`) and would block scripts that are
 * actually safe.
 */
const UNIX_FS_DENY = UNIX_DENY.filter(
  (d) => d.re !== MACHINE_POWER_RE && d.re !== MACHINE_POWER_INIT_RE,
);

const JAVA_DENY = [
  {
    re: /\.\s*exec\s*\([^;\n]*(\brm\b|mkfs|wipefs|\bdd\b[^\n]*of=\/dev\/)/i,
    reason: 'destructive command via Runtime.exec',
  },
  {
    re: /new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*ProcessBuilder\s*\([^)]*(\brm\b|mkfs|wipefs|\bdd\b[^\n]*of=\/dev\/)/i,
    reason: 'destructive command via ProcessBuilder',
  },
  {
    // qualified name (new java.io.File("/")) as well as bare (new File("/"))
    re: /new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*File\s*\(\s*"\/"\s*\)\s*\.\s*delete/i,
    reason: 'delete root via File.delete',
  },
  {
    re: /Files\.walk(?:File)?\s*\(\s*(?:Paths?\.get|Path\.of)\s*\(\s*"\/"\s*\)/i,
    reason: 'recursive from root via Files.walk',
  },
];

/** Result of scanning common Windows locations for `java` (once at startup). */
const JAVA_FALLBACK_BIN = defaultJavaBin();

/**
 * Interpreter registry.
 * - exts      : handled extensions (lowercase)
 * - candidates: ordered { bin, pre, flag } — bin is looked up on PATH; pre =
 *               arguments before the script; flag = script marker ('-File'),
 *               null = direct
 * - comment   : comment prefix (stripped before the guardrail scan)
 * - probe     : { versionArgs, noopArgs | noopFile } for verification in
 *               sandbox_info; noopFile = write a sample file then run it via
 *               the interpreter (for languages needing a build step, e.g. .java)
 *
 * Adding a language = add an entry here. Interpreters are resolved from the
 * device PATH; if missing, run rejects with a clear message.
 */
const REGISTRY = [
  {
    kind: 'powershell',
    label: 'PowerShell',
    exts: ['.ps1'],
    winOnly: true,
    candidates: [
      {
        bin: 'powershell.exe',
        pre: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'],
        flag: '-File',
      },
      { bin: 'pwsh', pre: ['-NoProfile'], flag: '-File' },
    ],
    comment: ['#'],
    deny: 'powershell',
    probe: {
      versionArgs: ['-Command', '$PSVersionTable.PSVersion.ToString()'],
      noopArgs: ['-Command', 'exit 0'],
    },
  },
  {
    kind: 'sh',
    label: 'bash',
    exts: ['.sh', '.bash'],
    candidates: [{ bin: defaultShShell(), pre: [], flag: null }],
    comment: ['#'],
    deny: 'sh',
    probe: { versionArgs: ['--version'], noopArgs: ['-c', 'exit 0'] },
  },
  {
    kind: 'python',
    label: 'Python',
    exts: ['.py'],
    candidates: [
      { bin: 'python3', pre: [], flag: null },
      { bin: 'python', pre: [], flag: null },
    ],
    comment: ['#'],
    deny: 'python',
    probe: { versionArgs: ['--version'], noopArgs: ['-c', 'pass'] },
  },
  {
    kind: 'node',
    label: 'Node.js',
    exts: ['.js', '.mjs', '.cjs'],
    candidates: [{ bin: 'node', pre: [], flag: null }],
    comment: ['//'],
    deny: 'node',
    probe: { versionArgs: ['--version'], noopArgs: ['-e', ''] },
  },
  {
    kind: 'ruby',
    label: 'Ruby',
    exts: ['.rb'],
    candidates: [{ bin: 'ruby', pre: [], flag: null }],
    comment: ['#'],
    deny: 'unix',
    probe: { versionArgs: ['--version'], noopArgs: ['-e', 'true'] },
  },
  {
    kind: 'perl',
    label: 'Perl',
    exts: ['.pl'],
    candidates: [{ bin: 'perl', pre: [], flag: null }],
    comment: ['#'],
    deny: 'unix',
    probe: { versionArgs: ['-e', 'print $^V'], noopArgs: ['-e', '1'] },
  },
  {
    kind: 'lua',
    label: 'Lua',
    exts: ['.lua'],
    candidates: [
      { bin: 'lua', pre: [], flag: null },
      { bin: 'lua54', pre: [], flag: null },
      { bin: 'luajit', pre: [], flag: null },
    ],
    comment: ['--'],
    deny: 'unix',
    probe: { versionArgs: ['-v'], noopArgs: null },
  },
  {
    kind: 'php',
    label: 'PHP',
    exts: ['.php'],
    candidates: [{ bin: 'php', pre: [], flag: null }],
    comment: ['#', '//'],
    deny: 'unix',
    probe: { versionArgs: ['--version'], noopArgs: ['-r', ';'] },
  },
  {
    kind: 'r',
    label: 'R',
    exts: ['.r'],
    candidates: [{ bin: 'Rscript', pre: [], flag: null }],
    comment: ['#'],
    deny: 'unix',
    probe: { versionArgs: ['--version'], noopArgs: ['-e', 'quit()'] },
  },
  {
    kind: 'java',
    label: 'Java',
    exts: ['.java'],
    candidates: [
      { bin: 'java', pre: [], flag: null },
      // if `java` is not on PATH, fall back to an install in common Windows locations
      ...(JAVA_FALLBACK_BIN ? [{ bin: JAVA_FALLBACK_BIN, pre: [], flag: null }] : []),
    ],
    comment: ['//'],
    deny: 'java',
    // `java file.java` (source-file mode, JEP 330 / JDK 11+) compiles in
    // memory then runs the first class in the file. So the noop probe is a
    // real .java file: `java -version` still runs on a JRE without javac /
    // on Java 8, while a .java file cannot be executed there.
    probe: {
      versionArgs: ['--version'],
      noopFile: {
        name: 'Probe.java',
        code: 'public class Probe { public static void main(String[] args) { } }\n',
      },
    },
  },
  {
    kind: 'cmd',
    label: 'CMD (batch)',
    exts: ['.bat', '.cmd'],
    winOnly: true,
    candidates: [{ bin: 'cmd.exe', pre: ['/c'], flag: null }],
    comment: ['rem', "'"],
    deny: 'cmd',
    probe: { versionArgs: ['/c', 'ver'], noopArgs: ['/c', 'exit 0'] },
  },
  {
    kind: 'vbs',
    label: 'VBScript',
    exts: ['.vbs'],
    winOnly: true,
    candidates: [{ bin: 'cscript.exe', pre: ['//B', '//Nologo'], flag: null }],
    comment: ["'", 'rem'],
    deny: 'cmd',
    probe: { versionArgs: null, noopArgs: null },
  },
];

/** Resolver for a single registry entry: env override > first candidate on PATH. */
function resolveInterpreter(def) {
  const override = process.env[`SCRIPT_SANDBOX_SHELL_${def.kind.toUpperCase()}`];
  const candidates = override
    ? [{ bin: override, pre: def.candidates[0].pre, flag: def.candidates[0].flag }]
    : def.candidates;

  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate.bin);
    const found = absolute
      ? fs.existsSync(candidate.bin)
        ? candidate.bin
        : null
      : findOnPath(IS_WINDOWS ? [candidate.bin, `${candidate.bin}.exe`] : [candidate.bin]);
    if (found) {
      return {
        kind: def.kind,
        label: def.label,
        exts: def.exts,
        shell: found,
        pre: candidate.pre,
        flag: candidate.flag,
        comment: def.comment,
        deny: def.deny,
        probe: def.probe,
        candidates: candidates.map((c) => c.bin),
        missing: false,
      };
    }
  }
  return {
    kind: def.kind,
    label: def.label,
    exts: def.exts,
    shell: null,
    pre: null,
    flag: null,
    comment: def.comment,
    deny: def.deny,
    probe: def.probe,
    candidates: candidates.map((c) => c.bin),
    missing: true,
  };
}

/** Resolve all interpreters relevant to this platform. */
const interpreters = REGISTRY.filter((def) => !def.winOnly || IS_WINDOWS).map(
  resolveInterpreter,
);

/** Map extension -> interpreter (default exts plus user overrides). */
const shells = {};
for (const entry of interpreters) {
  for (const ext of entry.exts) shells[ext] = entry;
}

/**
 * Extensions allowed to be written/executed.
 * Override: SCRIPT_SANDBOX_EXTENSIONS=".py,.js" (only restricts, never adds —
 * a language without an interpreter still cannot run).
 */
const overrideExts = listEnv('SCRIPT_SANDBOX_EXTENSIONS');
const extensions =
  overrideExts.length > 0 ? overrideExts.filter((ext) => shells[ext]) : Object.keys(shells);

const denyOff = new Set(listEnv('SCRIPT_SANDBOX_DENY_OFF'));
const denyEnabled = boolEnv('SCRIPT_SANDBOX_DENY', true);
const DENY_SETS = { powershell: PS_DENY, cmd: WIN_DENY, sh: UNIX_DENY, unix: UNIX_DENY, python: [...UNIX_DENY, ...PY_DENY], node: [...UNIX_DENY, ...NODE_DENY], java: [...UNIX_FS_DENY, ...JAVA_DENY] };

export const config = {
  root,
  isWindows: IS_WINDOWS,
  dirs: {
    root,
    scripts: path.join(root, 'scripts'),
    work: path.join(root, 'work'),
    logs: path.join(root, 'logs'),
  },
  interpreters,
  extensions,
  shells,
  /** Normalize CRLF -> LF when writing .sh/.bash (bash fails on \r). */
  normalizeShLineEndings: boolEnv('SCRIPT_SANDBOX_SH_NORMALIZE_EOL', true),
  defaultTimeoutMs: intEnv('SCRIPT_SANDBOX_DEFAULT_TIMEOUT_MS', 120_000),
  maxTimeoutMs: intEnv('SCRIPT_SANDBOX_MAX_TIMEOUT_MS', 600_000),
  /** Byte cap for output returned to the caller (the rest is truncated + kept in full in the log). */
  maxOutputBytes: intEnv('SCRIPT_SANDBOX_MAX_OUTPUT_BYTES', 200_000),
  maxConcurrent: intEnv('SCRIPT_SANDBOX_MAX_CONCURRENT', 2),
  /** Number of recent runs kept on disk. */
  keepRuns: intEnv('SCRIPT_SANDBOX_KEEP_RUNS', 50),
  maxScriptBytes: intEnv('SCRIPT_SANDBOX_MAX_SCRIPT_BYTES', 1_000_000),
  maxEnvVars: 20,
  envAllowlist: ENV_ALLOWLIST,
  denyEnabled,
  denyOff,
  denySets: DENY_SETS,
};

export default config;

/** Extension (lowercase, dot-prefixed) of a script file name. */
export function extOf(name) {
  return path.extname(String(name)).toLowerCase();
}

/** Interpreter for a file name, or null if its extension is unsupported. */
export function shellFor(name) {
  return config.shells[extOf(name)] || null;
}

/** Guardrail list for the script's language. */
export function denyPatternsFor(kind) {
  if (!config.denyEnabled || config.denyOff.has(kind)) return [];
  return config.denySets[kind] || [];
}

/** Comment prefixes for the language (stripped before the guardrail scan). */
export function commentPrefixesFor(kind) {
  const entry = config.interpreters.find((i) => i.kind === kind);
  return entry ? entry.comment : ['#'];
}
