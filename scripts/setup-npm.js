#!/usr/bin/env node
/**
 * Setup pemakaian MCP script-sandbox lewat npm (mode native).
 *
 * Alur:
 *   1. `npm pack`              -> script-sandbox-mcp-<ver>.tgz
 *   2. salin tgz ke target + tulis package.json dengan
 *      "dependencies": { "script-sandbox-mcp": "file:./<tgz>" }
 *   3. `npm install`           -> <target>/node_modules/script-sandbox-mcp
 *   4. (opsional) tulis blok mcp.servers["script-sandbox"] di opencode.json
 *
 * Pakai:
 *   npm run setup:npm                          # install + update opencode.json
 *   npm run setup:npm -- --enable              # sekalian menyalakan server-nya
 *   npm run setup:npm -- --no-opencode         # jangan sentuh opencode.json
 *   npm run setup:npm -- --target "D:/mcp/ps"  # ganti folder instalasi
 *   npm run setup:npm -- --from-registry       # install dari registry npm (butuh internet)
 *   npm run setup:npm -- --from-registry --spec "^1.2.0"   # pilih versi
 *
 * Device tanpa folder project (package sudah ada di registry npm):
 *   npm install script-sandbox-mcp --no-save
 *   node node_modules/script-sandbox-mcp/scripts/setup-npm.js --from-registry --enable
 *
 * Kenapa tarball, bukan menunjuk folder project langsung?
 * - instalasi terisolasi dari folder kerja: update = jalankan ulang script ini
 * - file project yang sedang diedit tidak ikut mempengaruhi server yang jalan
 * - shim `.cmd`/`.ps1` npm di Windows tidak dipakai; config menunjuk
 *   `src/server.js` lewat `node.exe`, jadi spawn di OpenCode tetap stabil
 *
 * PORTABILITAS — tidak ada path device yang ditulis tetap:
 * - folder instalasi : userDataDir() per platform (Windows %LOCALAPPDATA%,
 *                      macOS ~/Library/Application Support, Linux $XDG_DATA_HOME)
 * - path node        : process.execPath (node yang sedang menjalankan script ini)
 * - opencode.json    : --opencode > env OPENCODE_CONFIG > ~/.config/opencode/opencode.json
 * - SCRIPT_SANDBOX_ROOT  : os.tmpdir()/opencode/ps-sandbox (sama dengan default config.js)
 * Jadi cukup `npm run setup:npm` di device mana pun (folder project boleh di
 * lokasi mana pun), semua path ikut menyesuaikan.
 *
 * Catatan: script ini hanya memindahkan `command` + `environment` + `timeout`
 * dan mempertahankan flag `disabled` yang sudah ada (kecuali `--enable`),
 * jadi tidak ada perubahan perilaku yang tidak diminta.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultOpencodeConfigPath,
  defaultSandboxRoot,
  runNpm,
  toSlashes,
  userDataDir,
} from './lib/paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);

function fail(message) {
  console.error(`\n[s setup-npm] GAGAL: ${message}`);
  process.exit(1);
}

function step(index, total, message) {
  console.log(`[${index}/${total}] ${message}`);
}

function optValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) fail(`nilai untuk ${name} kosong`);
  return value;
}

const hasFlag = (name) => argv.includes(name);

/** Instalasi dari registry npm, bukan tarball hasil `npm pack` lokal. */
const REGISTRY_MODE = hasFlag('--from-registry');
/** Spec versi untuk mode registry (default: ^versi package.json ini). */
const PKG_SPEC = optValue('--spec', `^${PKG.version}`);
if (argv.includes('--spec') && !REGISTRY_MODE) {
  fail('--spec hanya dipakai bersama --from-registry');
}

const DEFAULT_TARGET = () => path.join(userDataDir(), 'mcp-servers', 'script-sandbox');
const DEFAULT_SANDBOX_ROOT = () => defaultSandboxRoot();

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(
    [
      'Penggunaan: node scripts/setup-npm.js [opsioni]',
      '',
      '  --target <dir>        folder instalasi',
      `                        default: ${DEFAULT_TARGET()}`,
      '  --opencode <path>     path opencode.json',
      `                        default: env OPENCODE_CONFIG atau ${defaultOpencodeConfigPath()}`,
      '  --sandbox-root <dir>  nilai SCRIPT_SANDBOX_ROOT untuk config OpenCode',
      `                        default: ${DEFAULT_SANDBOX_ROOT()}`,
      '  --from-registry       install dari registry npm (butuh internet), bukan tarball lokal',
      `  --spec <semver>       versi untuk --from-registry (default: ^${PKG.version})`,
      '  --no-opencode         jangan mengubah opencode.json',
      '  --enable              set disabled=false pada blok server',
      '  --help                tampilkan bantuan ini',
    ].join('\n'),
  );
  process.exit(0);
}

const TARGET = path.resolve(optValue('--target', DEFAULT_TARGET()));
const CONFIG = path.resolve(optValue('--opencode', defaultOpencodeConfigPath()));
const SANDBOX_ROOT = path.resolve(optValue('--sandbox-root', DEFAULT_SANDBOX_ROOT()));

/** `npm pack --json` bisa dikelilingi warning; ambil bagian JSON-nya saja. */
function parsePackJson(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    const start = stdout.indexOf('[');
    const end = stdout.lastIndexOf(']');
    if (start !== -1 && end > start) return JSON.parse(stdout.slice(start, end + 1));
    throw new Error(`output npm pack tidak bisa diparse:\n${stdout}`);
  }
}

/** Blok config yang ditulis (dipakai juga untuk petunjuk paste manual). */
function configBlock(serverPath) {
  return {
    entry: {
      type: 'local',
      command: [toSlashes(process.execPath), toSlashes(serverPath)],
      environment: { SCRIPT_SANDBOX_ROOT: toSlashes(SANDBOX_ROOT) },
      timeout: { startup: 60000 },
    },
  };
}

function renderBlock({ entry }, prev) {
  const out = { ...entry };
  if (hasFlag('--enable')) out.disabled = false;
  else if (prev && 'disabled' in prev) out.disabled = prev.disabled;
  return out;
}

function updateOpenCodeConfig(serverPath) {
  const wanted = configBlock(serverPath);

  if (!fs.existsSync(CONFIG)) {
    console.warn(`  ! ${CONFIG} tidak ada — config dilewati, daftarkan manual:`);
    console.warn(blockJson(wanted, null));
    return 'dilewati (file tidak ada)';
  }

  const raw = fs.readFileSync(CONFIG, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    // Jangan menimpa config yang tidak bisa diparse (mungkin JSONC/komentar).
    console.warn(`  ! ${CONFIG} bukan JSON polos (${err.message}) — config tidak diubah.`);
    console.warn('  ! Salin blok ini ke config secara manual:');
    console.warn(blockJson(wanted, null));
    return 'dilewati (bukan JSON polos)';
  }

  const backup = `${CONFIG}.bak.npm`;
  if (fs.existsSync(backup)) {
    // Backup pertama = config sebelum setup; jangan ditimpa oleh rerun.
    console.log(`  backup : ${backup} (lama dipertahankan)`);
  } else {
    fs.copyFileSync(CONFIG, backup);
    console.log(`  backup : ${backup}`);
  }

  cfg.mcp ??= {};
  cfg.mcp.servers ??= {};
  const prev = cfg.mcp.servers['script-sandbox'];
  const entry = renderBlock(wanted, prev);
  cfg.mcp.servers['script-sandbox'] = entry;
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

  const state = entry.disabled === true ? 'masih disabled' : 'aktif';
  return `diupdate (${state})`;
}

/** Serialisasi blok server + container "mcp.servers" siap tempel. */
function blockJson(wanted, prev) {
  const entry = renderBlock(wanted, prev);
  return JSON.stringify({ mcp: { servers: { 'script-sandbox': entry } } }, null, 2);
}

let packDir = null;

function main() {
  const source = REGISTRY_MODE
    ? `registry npm: ${PKG.name}@${PKG_SPEC}`
    : `tarball lokal v${PKG.version}`;
  console.log(
    `setup-npm: ${PKG.name}@${PKG.version} (${source}) -> ${TARGET}\n` +
      `  config : ${hasFlag('--no-opencode') ? '(dilewati --no-opencode)' : CONFIG}\n` +
      `  root   : ${SANDBOX_ROOT}\n`,
  );

  let depSpec;
  let tgzPath = null;
  let tgzName = null;

  if (REGISTRY_MODE) {
    step(1, 4, `cek ${PKG.name}@${PKG_SPEC} di registry ...`);
    depSpec = PKG_SPEC;
    let stdout;
    try {
      ({ stdout } = runNpm(['view', `${PKG.name}@${PKG_SPEC}`, 'version'], { cwd: ROOT }));
    } catch (err) {
      throw new Error(
        `${PKG.name}@${PKG_SPEC} tidak ditemukan di registry ` +
          `(belum dipublikasikan, typo, atau offline).\n${err.message}`,
      );
    }
    const versions = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    console.log(`  -> versi cocok: ${versions.join(', ')}`);
  } else {
    step(1, 4, 'npm pack ...');
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sandbox-pack-'));
    const { stdout } = runNpm(['pack', '--json', '--pack-destination', packDir], { cwd: ROOT });
    tgzName = parsePackJson(stdout)[0].filename;
    tgzPath = path.join(packDir, tgzName);
    depSpec = `file:./${tgzName}`;
    console.log(`  -> ${tgzName} (${fs.statSync(tgzPath).size} bytes)`);
  }

  step(2, 4, 'menyiapkan folder instalasi ...');
  fs.mkdirSync(TARGET, { recursive: true });
  // Bersihkan tgz versi lama supaya folder target tidak menumpuk.
  for (const file of fs.readdirSync(TARGET)) {
    if (/^script-sandbox-mcp-.*\.tgz$/.test(file)) {
      fs.rmSync(path.join(TARGET, file), { force: true });
    }
  }
  if (tgzPath) fs.copyFileSync(tgzPath, path.join(TARGET, tgzName));
  fs.writeFileSync(
    path.join(TARGET, 'package.json'),
    `${JSON.stringify(
      {
        name: 'mcp-servers-script-sandbox',
        private: true,
        description: `Instalasi npm (${REGISTRY_MODE ? 'registry' : 'tarball'}) untuk MCP script-sandbox — mode native.`,
        dependencies: { [PKG.name]: depSpec },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`  -> ${TARGET}`);

  step(3, 4, 'npm install ...');
  // npm TIDAK me-refresh isi node_modules selama nama/versi tarball sama —
  // tree yang terpasang dianggap masih cocok dengan lockfile (diuji: isi lama
  // tetap dipakai). Jadi package + lockfile dibuang dulu supaya perubahan src/
  // benar-benar masuk; dependency lain (sdk, zod) tetap ada di node_modules.
  fs.rmSync(path.join(TARGET, 'node_modules', PKG.name), { recursive: true, force: true });
  fs.rmSync(path.join(TARGET, 'package-lock.json'), { force: true });
  runNpm(['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: TARGET });
  const serverPath = path.join(TARGET, 'node_modules', PKG.name, 'src', 'server.js');
  if (!fs.existsSync(serverPath)) throw new Error(`server tidak ditemukan di ${serverPath}`);
  console.log(`  -> ${serverPath}`);

  step(4, 4, 'opencode.json ...');
  const configState = hasFlag('--no-opencode')
    ? 'dilewati (--no-opencode)'
    : updateOpenCodeConfig(serverPath);

  const checkScript = path.join(ROOT, 'test', 'config-check.mjs');
  const setupScript = path.join(ROOT, 'scripts', 'setup-npm.js');
  const enableHint = REGISTRY_MODE
    ? `node "${toSlashes(setupScript)}" --from-registry --enable`
    : 'npm run setup:npm -- --enable';

  const lines = [
    '',
    'Selesai.',
    `  sumber : ${source}`,
    `  server : ${toSlashes(process.execPath)} ${toSlashes(serverPath)}`,
    `  sandbox: ${toSlashes(SANDBOX_ROOT)} (SCRIPT_SANDBOX_ROOT)`,
    `  config : ${configState}`,
    '',
    'Verifikasi handshake + 1 run:',
    `  node "${toSlashes(checkScript)}" "${toSlashes(CONFIG)}"`,
    '',
  ];
  if (hasFlag('--enable')) {
    lines.push('Server aktif (disabled=false). Restart OpenCode kalau sedang jalan.');
  } else {
    lines.push(
      'Status disabled dipertahankan seperti konfigurasi sebelumnya.',
      `Nyalakan dengan:  ${enableHint}`,
    );
  }
  console.log(lines.join('\n'));
}

try {
  main();
} catch (err) {
  console.error(`\n[s setup-npm] GAGAL: ${err?.stack || String(err)}`);
  process.exitCode = 1;
} finally {
  if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
}

