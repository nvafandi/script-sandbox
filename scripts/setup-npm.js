#!/usr/bin/env node
/**
 * Set up MCP script-sandbox usage via npm (native mode).
 *
 * Flow:
 *   1. `npm pack`              -> script-sandbox-mcp-<ver>.tgz
 *   2. copy the tgz to the target + write package.json with
 *      "dependencies": { "script-sandbox-mcp": "file:./<tgz>" }
 *   3. `npm install`           -> <target>/node_modules/script-sandbox-mcp
 *   4. (optional) write the mcp.servers["script-sandbox"] block to opencode.json
 *
 * Usage:
 *   npm run setup:npm                          # install + update opencode.json
 *   npm run setup:npm -- --enable              # also switch the server on
 *   npm run setup:npm -- --no-opencode         # leave opencode.json alone
 *   npm run setup:npm -- --target "D:/mcp/ps"  # change the install folder
 *   npm run setup:npm -- --from-registry       # install from the npm registry (needs internet)
 *   npm run setup:npm -- --from-registry --spec "^1.2.0"   # pick a version
 *
 * Device without a project folder (package already on the npm registry):
 *   npm install script-sandbox-mcp --no-save
 *   node node_modules/script-sandbox-mcp/scripts/setup-npm.js --from-registry --enable
 *
 * Why a tarball instead of pointing straight at the project folder?
 * - the install is isolated from the working folder: update = re-run this script
 * - project files you are currently editing do not affect the running server
 * - the npm `.cmd`/`.ps1` shims on Windows are not used; the config points at
 *   `src/server.js` via `node.exe`, so spawning in OpenCode stays stable
 *
 * PORTABILITY — no device path is hard-coded:
 * - install folder : userDataDir() per platform (Windows %LOCALAPPDATA%,
 *                    macOS ~/Library/Application Support, Linux $XDG_DATA_HOME)
 * - node path      : process.execPath (the node running this script)
 * - opencode.json  : --opencode > env OPENCODE_CONFIG > ~/.config/opencode/opencode.json
 * - SCRIPT_SANDBOX_ROOT  : os.tmpdir()/opencode/ps-sandbox (same as config.js default)
 * So `npm run setup:npm` on any device is enough (the project folder may live
 * anywhere), all paths adapt accordingly.
 *
 * Note: this script only moves `command` + `environment` + `timeout`
 * and keeps an existing `disabled` flag (unless `--enable`),
 * so there is no unrequested behavior change.
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
  console.error(`\n[s setup-npm] FAILED: ${message}`);
  process.exit(1);
}

function step(index, total, message) {
  console.log(`[${index}/${total}] ${message}`);
}

function optValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) fail(`empty value for ${name}`);
  return value;
}

const hasFlag = (name) => argv.includes(name);

/** Install from the npm registry instead of the local `npm pack` tarball. */
const REGISTRY_MODE = hasFlag('--from-registry');
/** Version spec for registry mode (default: ^this package.json's version). */
const PKG_SPEC = optValue('--spec', `^${PKG.version}`);
if (argv.includes('--spec') && !REGISTRY_MODE) {
  fail('--spec is only used together with --from-registry');
}

const DEFAULT_TARGET = () => path.join(userDataDir(), 'mcp-servers', 'script-sandbox');
const DEFAULT_SANDBOX_ROOT = () => defaultSandboxRoot();

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(
    [
      'Usage: node scripts/setup-npm.js [options]',
      '',
      '  --target <dir>        install folder',
      `                        default: ${DEFAULT_TARGET()}`,
      '  --opencode <path>     path to opencode.json',
      `                        default: env OPENCODE_CONFIG or ${defaultOpencodeConfigPath()}`,
      '  --sandbox-root <dir>  value of SCRIPT_SANDBOX_ROOT for the OpenCode config',
      `                        default: ${DEFAULT_SANDBOX_ROOT()}`,
      '  --from-registry       install from the npm registry (needs internet), not a local tarball',
      `  --spec <semver>       version for --from-registry (default: ^${PKG.version})`,
      '  --no-opencode         do not modify opencode.json',
      '  --enable              set disabled=false on the server block',
      '  --help                show this help',
    ].join('\n'),
  );
  process.exit(0);
}

const TARGET = path.resolve(optValue('--target', DEFAULT_TARGET()));
const CONFIG = path.resolve(optValue('--opencode', defaultOpencodeConfigPath()));
const SANDBOX_ROOT = path.resolve(optValue('--sandbox-root', DEFAULT_SANDBOX_ROOT()));

/** `npm pack --json` may be wrapped in warnings; extract just the JSON part. */
function parsePackJson(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    const start = stdout.indexOf('[');
    const end = stdout.lastIndexOf(']');
    if (start !== -1 && end > start) return JSON.parse(stdout.slice(start, end + 1));
    throw new Error(`npm pack output could not be parsed:\n${stdout}`);
  }
}

/** Config block that gets written (also used for the manual paste hint). */
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
    console.warn(`  ! ${CONFIG} does not exist — config skipped, register it manually:`);
    console.warn(blockJson(wanted, null));
    return 'skipped (file missing)';
  }

  const raw = fs.readFileSync(CONFIG, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    // Never overwrite a config that cannot be parsed (it may be JSONC/comments).
    console.warn(`  ! ${CONFIG} is not plain JSON (${err.message}) — config left unchanged.`);
    console.warn('  ! Copy this block into the config manually:');
    console.warn(blockJson(wanted, null));
    return 'skipped (not plain JSON)';
  }

  const backup = `${CONFIG}.bak.npm`;
  if (fs.existsSync(backup)) {
    // First backup = config before setup; keep it across re-runs.
    console.log(`  backup : ${backup} (existing kept)`);
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

  const state = entry.disabled === true ? 'still disabled' : 'active';
  return `updated (${state})`;
}

/** Serialize the server block + its "mcp.servers" container, ready to paste. */
function blockJson(wanted, prev) {
  const entry = renderBlock(wanted, prev);
  return JSON.stringify({ mcp: { servers: { 'script-sandbox': entry } } }, null, 2);
}

let packDir = null;

function main() {
  const source = REGISTRY_MODE
    ? `npm registry: ${PKG.name}@${PKG_SPEC}`
    : `local tarball v${PKG.version}`;
  console.log(
    `setup-npm: ${PKG.name}@${PKG.version} (${source}) -> ${TARGET}\n` +
      `  config : ${hasFlag('--no-opencode') ? '(skipped --no-opencode)' : CONFIG}\n` +
      `  root   : ${SANDBOX_ROOT}\n`,
  );

  let depSpec;
  let tgzPath = null;
  let tgzName = null;

  if (REGISTRY_MODE) {
    step(1, 4, `checking ${PKG.name}@${PKG_SPEC} on the registry ...`);
    depSpec = PKG_SPEC;
    let stdout;
    try {
      ({ stdout } = runNpm(['view', `${PKG.name}@${PKG_SPEC}`, 'version'], { cwd: ROOT }));
    } catch (err) {
      throw new Error(
        `${PKG.name}@${PKG_SPEC} not found on the registry ` +
          `(not published yet, a typo, or offline).\n${err.message}`,
      );
    }
    const versions = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    console.log(`  -> matching versions: ${versions.join(', ')}`);
  } else {
    step(1, 4, 'npm pack ...');
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sandbox-pack-'));
    const { stdout } = runNpm(['pack', '--json', '--pack-destination', packDir], { cwd: ROOT });
    tgzName = parsePackJson(stdout)[0].filename;
    tgzPath = path.join(packDir, tgzName);
    depSpec = `file:./${tgzName}`;
    console.log(`  -> ${tgzName} (${fs.statSync(tgzPath).size} bytes)`);
  }

  step(2, 4, 'preparing the install folder ...');
  fs.mkdirSync(TARGET, { recursive: true });
  // Clean out old tgz versions so the target folder does not pile up.
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
        description: `npm install (${REGISTRY_MODE ? 'registry' : 'tarball'}) for the script-sandbox MCP — native mode.`,
        dependencies: { [PKG.name]: depSpec },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`  -> ${TARGET}`);

  step(3, 4, 'npm install ...');
  // npm does NOT refresh node_modules while the tarball name/version stays the same —
  // the installed tree is considered still in sync with the lockfile (tested: the old
  // contents are kept). So package + lockfile are removed first so src/ changes
  // actually land; other deps (sdk, zod) stay in node_modules.
  fs.rmSync(path.join(TARGET, 'node_modules', PKG.name), { recursive: true, force: true });
  fs.rmSync(path.join(TARGET, 'package-lock.json'), { force: true });
  runNpm(['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: TARGET });
  const serverPath = path.join(TARGET, 'node_modules', PKG.name, 'src', 'server.js');
  if (!fs.existsSync(serverPath)) throw new Error(`server not found at ${serverPath}`);
  console.log(`  -> ${serverPath}`);

  step(4, 4, 'opencode.json ...');
  const configState = hasFlag('--no-opencode')
    ? 'skipped (--no-opencode)'
    : updateOpenCodeConfig(serverPath);

  const checkScript = path.join(ROOT, 'test', 'config-check.mjs');
  const setupScript = path.join(ROOT, 'scripts', 'setup-npm.js');
  const enableHint = REGISTRY_MODE
    ? `node "${toSlashes(setupScript)}" --from-registry --enable`
    : 'npm run setup:npm -- --enable';

  const lines = [
    '',
    'Done.',
    `  source : ${source}`,
    `  server : ${toSlashes(process.execPath)} ${toSlashes(serverPath)}`,
    `  sandbox: ${toSlashes(SANDBOX_ROOT)} (SCRIPT_SANDBOX_ROOT)`,
    `  config : ${configState}`,
    '',
    'Verify handshake + 1 run:',
    `  node "${toSlashes(checkScript)}" "${toSlashes(CONFIG)}"`,
    '',
  ];
  if (hasFlag('--enable')) {
    lines.push('Server active (disabled=false). Restart OpenCode if it is running.');
  } else {
    lines.push(
      'The disabled status is kept as in the previous configuration.',
      `Enable it with:  ${enableHint}`,
    );
  }
  console.log(lines.join('\n'));
}

try {
  main();
} catch (err) {
  console.error(`\n[s setup-npm] FAILED: ${err?.stack || String(err)}`);
  process.exitCode = 1;
} finally {
  if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
}

