import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Konfigurasi script-sandbox.
 *
 * Keunggulan desain: eksekusi tidak ditulis per bahasa di engine — semuanya
 * dideklarasikan di REGISTRY (ekstensi -> interpreter -> gaya argumen ->
 * guardrail). Menambah bahasa baru = menambah entri, bukan menambah cabang
 * logika. Interpreter di-resolve dari PATH device saat start (portabel).
 */

/** Env allowlist: hanya variabel ini yang diteruskan ke child process. */
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

/** Daftar nilai dipisah koma, lowercase, tanpa spasi. */
function listEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return [];
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const IS_WINDOWS = process.platform === 'win32';

/** Root sandbox: selalu di folder temp OS device (portabel). */
const root = path.resolve(
  process.env.SCRIPT_SANDBOX_ROOT || path.join(os.tmpdir(), 'opencode', 'script-sandbox'),
);

/**
 * Cari executable pertama di PATH. Windows dicek pakai PATHEXT
 * (.exe/.cmd/...) supaya bisa juga menemukan `python` tanpa ekstensi.
 */
function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
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
 * Shell POSIX untuk .sh/.bash.
 * Di Windows, `bash.exe` bawaan WindowsApps cuma launcher interop WSL yang
 * merusak path Windows, jadi Git Bash (cygwin) yang diprioritaskan:
 * 1. PATH, asal bukan WindowsApps dan foldernya mengandung "Git"
 * 2. lokasi install umum (Git bisa terpasang di luar PATH)
 * 3. PATH mana pun selain WindowsApps
 * 4. 'bash' — biarkan spawn yang mencari di PATH
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

/* ------------------------------------------------------------- guardrails */

/**
 * Guardrail ringan (BUKAN security boundary) dikelompokkan per keluarga OS/
 * bahasa supaya tidak ada false positive lintas bahasa. Nonaktifkan dengan
 * SCRIPT_SANDBOX_DENY=0, atau per kind dengan SCRIPT_SANDBOX_DENY_OFF=sh,python.
 */
const PS_DENY = [
  { re: /\bFormat-Volume\b/i, reason: 'Format-Volume' },
  { re: /\bClear-Disk\b/i, reason: 'Clear-Disk' },
  { re: /\bInitialize-Disk\b/i, reason: 'Initialize-Disk' },
  { re: /\bRemove-Partition\b/i, reason: 'Remove-Partition' },
  {
    re: /\bRemove-Item\b[^\n]*-[^\n]*\b-[rR]ecurse\b[^\n]*\b([A-Za-z]:\\|C:\\|D:\\|E:\\)\s*$/i,
    reason: 'Remove-Item -Recurse pada drive root',
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

const UNIX_DENY = [
  { re: /\brm\b[^\n]*\s-[a-z]*[rf][a-z]*[^\n]*\s\/(?:\s|$)/, reason: 'rm -rf /' },
  { re: /\brm\b[^\n]*\s--no-preserve-root\b/i, reason: 'rm --no-preserve-root' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: 'mkfs' },
  { re: /\bwipefs\b/i, reason: 'wipefs' },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, reason: 'dd ke device' },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)/i, reason: 'tulis ke device blok' },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'fork bomb' },
  { re: /\bchmod\b[^\n]*\s-[a-z]*r[a-z]*[^\n]*\s\/(?:\s|$)/i, reason: 'chmod rekursif pada root' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'matikan mesin' },
  { re: /\binit\s+[06]\b/, reason: 'init 0/6' },
  { re: /\bshred\b[^\n]*\s\/dev\//i, reason: 'shred device' },
];

const PY_DENY = [
  { re: /\bshutil\.rmtree\(\s*['"]\/['"]/i, reason: 'shutil.rmtree root' },
  { re: /\bos\.system\(\s*['"][^\n]*(mkfs|dd\s+[^\n]*of=\/dev\/)/i, reason: 'perintah destruktif via os.system' },
  { re: /open\(\s*['"]\/dev\/(sd|nvme|hd)/i, reason: 'tulis langsung ke device blok' },
];

const NODE_DENY = [
  { re: /\brm(Sync)?\(\s*['"]\/['"][^\n]*recursive/i, reason: 'fs rm root rekursif' },
  { re: /\bexec(Sync)?\(\s*['"][^\n]*(mkfs|dd\s+[^\n]*of=\/dev\/)/i, reason: 'perintah destruktif via child_process' },
];

/**
 * Registry interpreter.
 * - exts      : ekstensi yang ditangani (lowercase)
 * - candidates: urutan { bin, pre, flag } — bin dicari di PATH; pre = argumen
 *               sebelum script; flag = penanda script ('-File'), null = langsung
 * - comment   : prefiks komentar (dibuang sebelum scan guardrail)
 * - probe     : { versionArgs, noopArgs } untuk verifikasi di sandbox_info
 *
 * Menambah bahasa = tambah entri di sini. Interpreter di-resolve dari PATH
 * device; kalau tidak ada, run akan menolak dengan pesan yang jelas.
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

/** Resolver satu entri registry: override env > kandidat pertama di PATH. */
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

/** Resolve semua interpreter yang relevan untuk platform ini. */
const interpreters = REGISTRY.filter((def) => !def.winOnly || IS_WINDOWS).map(
  resolveInterpreter,
);

/** Map ekstensi -> interpreter (ext default ditambah override user). */
const shells = {};
for (const entry of interpreters) {
  for (const ext of entry.exts) shells[ext] = entry;
}

/**
 * Ekstensi yang boleh ditulis/dijalankan.
 * Override: SCRIPT_SANDBOX_EXTENSIONS=".py,.js" (hanya membatasi, bukan
 * menambah — bahasa tanpa interpreter tetap tidak akan bisa jalan).
 */
const overrideExts = listEnv('SCRIPT_SANDBOX_EXTENSIONS');
const extensions =
  overrideExts.length > 0 ? overrideExts.filter((ext) => shells[ext]) : Object.keys(shells);

const denyOff = new Set(listEnv('SCRIPT_SANDBOX_DENY_OFF'));
const denyEnabled = boolEnv('SCRIPT_SANDBOX_DENY', true);
const DENY_SETS = { powershell: PS_DENY, cmd: WIN_DENY, sh: UNIX_DENY, unix: UNIX_DENY, python: [...UNIX_DENY, ...PY_DENY], node: [...UNIX_DENY, ...NODE_DENY] };

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
  /** Normalisasi CRLF -> LF saat menulis .sh/.bash (bash gagal kalau ada \r). */
  normalizeShLineEndings: boolEnv('SCRIPT_SANDBOX_SH_NORMALIZE_EOL', true),
  defaultTimeoutMs: intEnv('SCRIPT_SANDBOX_DEFAULT_TIMEOUT_MS', 120_000),
  maxTimeoutMs: intEnv('SCRIPT_SANDBOX_MAX_TIMEOUT_MS', 600_000),
  /** Batas byte output yang dikembalikan ke pemanggil (sisanya dipotong + disimpan penuh di log). */
  maxOutputBytes: intEnv('SCRIPT_SANDBOX_MAX_OUTPUT_BYTES', 200_000),
  maxConcurrent: intEnv('SCRIPT_SANDBOX_MAX_CONCURRENT', 2),
  /** Jumlah run terbaru yang tetap disimpan di disk. */
  keepRuns: intEnv('SCRIPT_SANDBOX_KEEP_RUNS', 50),
  maxScriptBytes: intEnv('SCRIPT_SANDBOX_MAX_SCRIPT_BYTES', 1_000_000),
  maxEnvVars: 20,
  envAllowlist: ENV_ALLOWLIST,
  denyEnabled,
  denyOff,
  denySets: DENY_SETS,
};

export default config;

/** Ekstensi (lowercase, berekstensi titik) dari nama file script. */
export function extOf(name) {
  return path.extname(String(name)).toLowerCase();
}

/** Interpreter untuk sebuah nama file, atau null kalau ekstensinya tidak didukung. */
export function shellFor(name) {
  return config.shells[extOf(name)] || null;
}

/** Daftar guardrail sesuai bahasa script. */
export function denyPatternsFor(kind) {
  if (!config.denyEnabled || config.denyOff.has(kind)) return [];
  return config.denySets[kind] || [];
}

/** Prefiks komentar sesuai bahasa (dibuang sebelum scan guardrail). */
export function commentPrefixesFor(kind) {
  const entry = config.interpreters.find((i) => i.kind === kind);
  return entry ? entry.comment : ['#'];
}
