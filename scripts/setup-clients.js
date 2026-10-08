#!/usr/bin/env node
/**
 * Daftarkan MCP script-sandbox ke banyak client sekaligus.
 *
 * Client MCP mana pun (Claude Desktop/Code, Cline, GitHub Copilot di VS Code,
 * Gemini CLI, Cursor, OpenCode, ...) memakai transport stdio yang sama, jadi
 * yang dibedakan hanya: lokasi file config + bentuk entry-nya. Itu persis
 * yang dibuat tabel CLIENTS di bawah — data-driven, bukan logika per client.
 *
 * Pakai:
 *   node scripts/setup-clients.js                       # tulis ke semua client terdeteksi
 *   node scripts/setup-clients.js --list                # lihat client + path config device ini
 *   node scripts/setup-clients.js --clients claude-desktop,cursor
 *   node scripts/setup-clients.js --print gemini        # blok siap tempel (tanpa menulis)
 *   node scripts/setup-clients.js --dry-run --all       # pratinjau semua, tanpa menulis
 *   node scripts/setup-clients.js --clients cline --file "D:/path/cline_mcp_settings.json"
 *
 * Aturan keamanan menulis:
 * - Hanya menulis JSON polos. File berisi komentar (JSONC) TIDAK disentuh;
 *   bloknya dicetak untuk ditempel manual.
 * - Backup dibuat sekali: `<config>.bak.mcp` (rerun tidak menimpa backup).
 * - Client yang tidak terdeteksi (file & foldernya tidak ada) dilewati, kecuali
 *   diminta eksplisit lewat --clients/--all.
 * - Idempoten: kalau entry sudah sama persis, tidak ada apa-apa yang ditulis.
 *
 * PATH: semua lokasi di-resolve dari environment device (APPDATA, HOME,
 * XDG_CONFIG_HOME, ...) — tidak ada path device yang ditulis tetap.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SERVER_NAME,
  defaultOpencodeConfigPath,
  defaultSandboxRoot,
  expandPath,
  getDotPath,
  packageRoot,
  resolveServerPath,
  setDotPath,
  toSlashes,
  userConfigDir,
  userDataDir,
} from './lib/paths.js';

const ROOT = packageRoot(import.meta.url);
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);

function fail(message) {
  console.error(`\n[s setup-clients] GAGAL: ${message}`);
  process.exit(1);
}

function optValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) fail(`nilai untuk ${name} kosong`);
  return value;
}

/* ------------------------------------------------------------------ */
/* Tabel client                                                        */
/*                                                                     */
/* `paths`  : kandidat lokasi config per platform (template yang akan  */
/*            di-expand: %VAR%, ~/, $VAR). Yang pertama ada yang      */
/*            dipakai.                                                 */
/* `key`    : dot-path key di dalam file (mis. "mcp.servers").        */
/* `shape`  : bentuk entry: standard | vscode | opencode.              */
/* `create` : "dir"  = boleh membuat file baru asal foldernya sudah ada        */
/*            "mkdir"= boleh membuat folder + file (mis. .vscode project)     */
/*            "never" = hanya mengubah file yang sudah ada                     */
/* ------------------------------------------------------------------ */

const CLIENTS = [
  {
    id: 'opencode',
    name: 'OpenCode',
    key: 'mcp.servers',
    shape: 'opencode',
    create: 'dir',
    paths: [() => defaultOpencodeConfigPath()],
    note: 'Sudah ditulis oleh `npm run setup:npm`; di sini hanya untuk sinkron.',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop (Anthropic)',
    key: 'mcpServers',
    shape: 'standard',
    create: 'dir',
    paths: [
      '%APPDATA%/Claude/claude_desktop_config.json',
      '~/Library/Application Support/Claude/claude_desktop_config.json',
      '~/.config/Claude/claude_desktop_config.json',
    ],
    note: 'Restart aplikasi desktop sepenuhnya (quit, bukan tutup jendela) setelah mengubah config.',
  },
  {
    id: 'claude-code',
    name: 'Claude Code (CLI)',
    key: 'mcpServers',
    shape: 'standard',
    create: 'dir',
    paths: ['~/.claude.json'],
    note: 'Alternatif CLI-nya: claude mcp add --transport stdio script-sandbox -- <node> <server.js>',
  },
  {
    id: 'cline',
    name: 'Cline (VS Code extension)',
    key: 'mcpServers',
    shape: 'standard',
    create: 'never',
    paths: [
      '%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
      '~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
      '~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
    ],
    note: 'File ini dibuat Cline saat pertama dibuka; kalau belum ada, daftarkan lewat UI Cline (MCP Servers).',
  },
  {
    id: 'roo',
    name: 'Roo Code (VS Code extension)',
    key: 'mcpServers',
    shape: 'standard',
    create: 'never',
    paths: [
      '%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
      '~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
      '~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
    ],
    note: 'Format sama dengan Cline (fork).',
  },
  {
    id: 'vscode',
    name: 'VS Code — user settings (GitHub Copilot / ekstensi MCP)',
    key: 'mcp.servers',
    shape: 'vscode',
    create: 'never',
    paths: [
      '%APPDATA%/Code/User/settings.json',
      '~/Library/Application Support/Code/User/settings.json',
      '~/.config/Code/User/settings.json',
    ],
    note: 'settings.json biasanya berisi JSONC (komentar) — kalau dilewati, pakai --print lalu tempel.',
  },
  {
    id: 'vscode-workspace',
    name: 'VS Code — workspace (.vscode/mcp.json)',
    key: 'servers',
    shape: 'vscode',
    create: 'mkdir',
    optIn: true,
    paths: [() => path.join(process.cwd(), '.vscode', 'mcp.json')],
    note: 'Scope project (Copilot Chat di repo ini). Opt-in: pilih eksplisit via --clients vscode-workspace.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    key: 'mcpServers',
    shape: 'standard',
    create: 'dir',
    paths: ['~/.gemini/settings.json'],
    note: 'Format: settings.json -> mcpServers. Verifikasi nama key di versi CLI kamu (--print).',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    key: 'mcpServers',
    shape: 'standard',
    create: 'dir',
    paths: ['~/.cursor/mcp.json'],
    note: 'Cursor juga punya UI MCP di Settings → MCP; file ini yang dibacanya.',
  },
  {
    id: 'windsurf',
    name: 'Windsurf (Codeium)',
    key: 'mcpServers',
    shape: 'standard',
    create: 'never',
    paths: ['~/.codeium/windsurf/mcp_config.json'],
    note: 'Path bisa berbeda antar versi Windsurf — cek dengan --list, lalu pakai --file kalau perlu.',
  },
];

const SHAPES = {
  /** Gaya paling umum: command + args + env. */
  standard: ({ nodePath, serverPath, env }) => ({
    command: nodePath,
    args: [serverPath],
    env,
  }),
  /** VS Code (mcp.json / settings.json): butuh type stdio. */
  vscode: ({ nodePath, serverPath, env }) => ({
    type: 'stdio',
    command: nodePath,
    args: [serverPath],
    env,
  }),
  /** OpenCode: command berupa array + `environment` (bukan `env`). */
  opencode: ({ nodePath, serverPath, env }) => ({
    type: 'local',
    command: [nodePath, serverPath],
    environment: env,
    timeout: { startup: 60000 },
  }),
};

function buildEntry(client, ctx) {
  const shape = SHAPES[client.shape];
  if (!shape) fail(`shape "${client.shape}" tidak dikenal untuk client ${client.id}`);
  return shape(ctx);
}

/**
 * Folder yang dianggap "bukan milik satu client": HOME, folder config/data
 * user, dan cwd. Membuat file baru persis di root ini (mis. ~/.claude.json
 * untuk CLI yang belum terpasang) dianggap tidak aman — dilewati saja.
 */
const GENERIC_ROOTS = [os.homedir(), userConfigDir(), userDataDir(), process.cwd()].map((p) =>
  path.resolve(p).toLowerCase(),
);

/** Expand template path + pilih kandidat yang dipakai di device ini. */
function resolveClientFile(client) {
  const candidates = client.paths
    .map((p) => (typeof p === 'function' ? p() : expandPath(p)))
    .map((p) => path.resolve(p));

  const existing = candidates.find((p) => fs.existsSync(p));
  if (existing) return { file: existing, detected: true };

  const withDir = candidates.find((p) => fs.existsSync(path.dirname(p)));
  if (withDir) {
    // folder root generik (HOME, %APPDATA%, dst.) selalu ada di semua device;
    // jangan dihitung "client terpasang" — file confignya sendiri yang harus ada.
    const parent = path.resolve(path.dirname(withDir)).toLowerCase();
    if (client.create !== 'mkdir' && GENERIC_ROOTS.includes(parent)) {
      return { file: null, detected: false };
    }
    return { file: withDir, detected: false };
  }

  // client yang boleh membuat folder sendiri (mis. .vscode di project) tetap ditawarkan
  if (client.create === 'mkdir') return { file: candidates[0], detected: false };

  return { file: null, detected: false };
}

function detectStatus(client) {
  const { file, detected } = resolveClientFile(client);
  if (!file) return { status: 'belum terpasang', file: null };
  if (detected) return { status: 'terdeteksi', file };
  return { status: 'foldernya ada (file belum)', file };
}

/** Stringify dengan key terurut: perbandingan idempoten tidak bergantung urutan key. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Deep-equal sederhana untuk mendeteksi "tidak ada perubahan". */
const sameEntry = (a, b) => stableStringify(a) === stableStringify(b);

/**
 * Entry baru menimpa field yang kami kelola (command/args/env) tapi field yang
 * hanya dimiliki user dipertahankan — mis. `disabled` di OpenCode atau
 * `autoApprove` di Cline tidak boleh hilang hanya karena server diperbarui.
 */
const mergeEntry = (prev, next) => ({
  ...(prev && typeof prev === 'object' ? prev : {}),
  ...next,
});

function updateClient(client, ctx, { dryRun }) {
  // --file eksplisit dipakai apa adanya: user sudah mengetik path-nya, tidak
  // perlu lagi deteksi; folder induknya boleh dibuat saat menulis.
  const { file, detected } = client.forcedFile
    ? { file: client.forcedFile, detected: fs.existsSync(client.forcedFile) }
    : resolveClientFile(client);

  if (!file) {
    return { state: 'dilewati (belum terpasang)', file: null, changed: false };
  }
  if (!detected && client.create === 'never') {
    return { state: `dilewati (file belum ada; daftarkan via UI client)`, file, changed: false };
  }

  const entry = buildEntry(client, ctx);

  // File belum ada → boleh dibuat, KECUALI lokasinya folder generik (HOME,
  // %APPDATA%, dst.) yang selalu ada walau client belum terpasang.
  if (!fs.existsSync(file)) {
    const parent = path.dirname(file);
    if (
      client.create !== 'mkdir' &&
      !client.forcedFile &&
      GENERIC_ROOTS.includes(path.resolve(parent).toLowerCase())
    ) {
      return { state: 'dilewati (file belum ada; daftarkan via UI client)', file, changed: false };
    }
    if (dryRun) return { state: 'akan dibuat', file, changed: true };
    fs.mkdirSync(parent, { recursive: true });
    const fresh = setDotPath({}, `${client.key}.${SERVER_NAME}`, entry);
    fs.writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`, 'utf8');
    return { state: 'dibuat baru', file, changed: true };
  }

  const raw = fs.readFileSync(file, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    return {
      state: 'dilewati (bukan JSON polos — tempel manual)',
      file,
      changed: false,
      needsManual: true,
      entry,
      reason: err.message,
    };
  }

  const prev = getDotPath(cfg, `${client.key}.${SERVER_NAME}`);
  const merged = mergeEntry(prev, entry);
  if (prev && sameEntry(prev, merged)) {
    return { state: 'sudah sama', file, changed: false };
  }

  if (dryRun) {
    return { state: prev ? 'akan diperbarui' : 'akan ditambahkan', file, changed: true };
  }

  const backup = `${file}.bak.mcp`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);

  setDotPath(cfg, `${client.key}.${SERVER_NAME}`, merged);
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return { state: prev ? 'diperbarui' : 'ditambahkan', file, changed: true, backup };
}

/* ------------------------------ CLI ------------------------------ */

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(
    [
      'Penggunaan: node scripts/setup-clients.js [opsioni]',
      '',
      '  --list                 daftar client + status deteksi + path config di device ini',
      '  --clients a,b,c        client yang mau ditulis (default: semua yang terdeteksi)',
      '  --all                  semua client (kecuali yang opt-in: vscode-workspace)',
      `  --print <id|all>       tampilkan blok config siap tempel, tanpa menulis`,
      '  --dry-run              tampilkan aksi tanpa mengubah file apa pun',
      `  --server <path>        path src/server.js (default: hasil resolve instalasi)`,
      `  --sandbox-root <dir>   nilai SCRIPT_SANDBOX_ROOT (default: ${toSlashes(defaultSandboxRoot())})`,
      `  --name <nama>          nama entry di client (default: ${SERVER_NAME})`,
      '  --file <path>          paksa path config (hanya bersama satu --clients)',
      '  --help                 tampilkan bantuan ini',
      '',
      'Client yang didukung: ' + CLIENTS.map((c) => c.id).join(', '),
    ].join('\n'),
  );
  process.exit(0);
}

const NAME = optValue('--name', SERVER_NAME);
const SANDBOX_ROOT = path.resolve(optValue('--sandbox-root', defaultSandboxRoot()));
const NODE_PATH = toSlashes(process.execPath);

const serverPath = resolveServerPath(optValue('--server', null), ROOT);
if (!serverPath) {
  fail(
    'server.js belum terpasang di mana pun.\n' +
      'Jalankan dulu `npm run setup:npm` (atau install package dari registry npm), ' +
      'atau tunjuk manual dengan --server <path>/src/server.js',
  );
}

const CTX = {
  nodePath: NODE_PATH,
  serverPath: toSlashes(serverPath),
  env: { SCRIPT_SANDBOX_ROOT: toSlashes(SANDBOX_ROOT) },
};

function selectClients() {
  // client opt-in (mis. scope project) tidak pernah ikut --all/deteksi otomatis
  if (hasFlag('--all')) return CLIENTS.filter((c) => !c.optIn);
  const raw = optValue('--clients', null);
  if (!raw) {
    return CLIENTS.filter(
      (c) => !c.optIn && detectStatus(c).status !== 'belum terpasang',
    );
  }
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !CLIENTS.some((c) => c.id === id));
  if (unknown.length) {
    fail(`client tidak dikenal: ${unknown.join(', ')}\nclient didukung: ${CLIENTS.map((c) => c.id).join(', ')}`);
  }
  return CLIENTS.filter((c) => ids.includes(c.id));
}

function printMode(target) {
  const list = target === 'all' ? CLIENTS : CLIENTS.filter((c) => c.id === target);
  if (!list.length) fail(`client tidak dikenal: ${target}`);
  for (const client of list) {
    const { file } = detectStatus(client);
    console.log(`\n=== ${client.name}  (id: ${client.id}, key: ${client.key}.${NAME}) ===`);
    console.log(`config: ${file || '(belum terpasang di device ini)'}`);
    console.log(`catatan: ${client.note}`);
    const block = setDotPath({}, `${client.key}.${NAME}`, buildEntry(client, CTX));
    console.log(JSON.stringify(block, null, 2));
  }
}

function main() {
  if (hasFlag('--list')) {
    console.log('client yang didukung + status di device ini:\n');
    for (const client of CLIENTS) {
      const { status, file } = detectStatus(client);
      console.log(`  ${client.id.padEnd(18)} ${status.padEnd(26)} ${file || '-'}`);
    }
    console.log(`\nserver : ${CTX.serverPath}`);
    console.log(`node   : ${CTX.nodePath}`);
    console.log(`sandbox: ${CTX.env.SCRIPT_SANDBOX_ROOT}`);
    return;
  }

  const printId = argv.includes('--print') ? optValue('--print', null) : null;
  if (printId) {
    printMode(printId);
    return;
  }

  if (argv.includes('--file') && (optValue('--clients', '') || '').includes(',')) {
    fail('--file hanya berlaku untuk satu client (--clients <id>)');
  }

  const dryRun = hasFlag('--dry-run');
  const forcedFile = argv.includes('--file') ? path.resolve(optValue('--file', '')) : null;
  const targets = selectClients();

  console.log(
    `setup-clients: ${PKG.name}@${PKG.version}\n` +
      `  server : ${CTX.serverPath}\n` +
      `  node   : ${CTX.nodePath}\n` +
      `  sandbox: ${CTX.env.SCRIPT_SANDBOX_ROOT}\n` +
      `  mode   : ${dryRun ? 'dry-run (tidak menulis)' : 'menulis'}\n`,
  );

  if (!targets.length) {
    console.log('Tidak ada client terpasang di device ini.');
    console.log('Lihat daftarnya: node scripts/setup-clients.js --list');
    console.log('Atau tulis eksplisit : node scripts/setup-clients.js --clients claude-desktop,cursor');
    console.log('Atau tempel manual   : node scripts/setup-clients.js --print <id>');
    return;
  }

  let changed = 0;
  for (const client of targets) {
    const opts = forcedFile ? { ...client, forcedFile, create: 'dir' } : client;
    const result = updateClient(opts, CTX, { dryRun });
    if (result.changed) changed += 1;
    console.log(`  ${client.id.padEnd(18)} ${result.state.padEnd(38)} ${result.file || ''}`);
    if (result.needsManual) {
      console.log(`    ! ${result.reason} — salin blok ini:`);
      const manual = setDotPath({}, `${client.key}.${NAME}`, result.entry);
      console.log(`${JSON.stringify(manual, null, 2).replace(/\n/g, '\n    ')}\n`);
    }
  }

  console.log(`\nSelesai: ${targets.length} client diproses, ${changed} berubah.`);
  if (!dryRun && changed > 0) {
    console.log('Restart client yang terpengaruh agar config dibaca ulang.');
  }
  console.log('Verifikasi per client: cek panel MCP-nya menampilkan "script-sandbox" dengan 8 tool.');
}

try {
  main();
} catch (err) {
  console.error(`\n[s setup-clients] GAGAL: ${err?.stack || String(err)}`);
  process.exitCode = 1;
}
