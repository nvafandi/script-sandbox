#!/usr/bin/env node
/**
 * Register the script-sandbox MCP with many clients at once.
 *
 * Any MCP client (Claude Desktop/Code, Cline, GitHub Copilot in VS Code,
 * Gemini CLI, Cursor, OpenCode, ...) uses the same stdio transport, so the
 * only differences are: the config file location + the shape of its entry.
 * That is exactly what the CLIENTS table below encodes — data-driven, not
 * per-client logic.
 *
 * Usage:
 *   node scripts/setup-clients.js                       # write to every detected client
 *   node scripts/setup-clients.js --list                # list clients + config paths on this device
 *   node scripts/setup-clients.js --clients claude-desktop,cursor
 *   node scripts/setup-clients.js --print gemini        # paste-ready block (no writes)
 *   node scripts/setup-clients.js --dry-run --all       # preview everything, no writes
 *   node scripts/setup-clients.js --clients cline --file "D:/path/cline_mcp_settings.json"
 *
 * Write safety rules:
 * - Only plain JSON is written. Files containing comments (JSONC) are NEVER touched;
 *   the block is printed for manual pasting.
 * - A backup is made once: `<config>.bak.mcp` (re-runs do not overwrite it).
 * - Undetected clients (file & folder both missing) are skipped, unless
 *   requested explicitly via --clients/--all.
 * - Idempotent: if the entry is already identical, nothing is written.
 *
 * PATH: every location is resolved from the device environment (APPDATA, HOME,
 * XDG_CONFIG_HOME, ...) — no device path is hard-coded.
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
  console.error(`\n[s setup-clients] FAILED: ${message}`);
  process.exit(1);
}

function optValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) fail(`empty value for ${name}`);
  return value;
}

/* ------------------------------------------------------------------ */
/* Client table                                                        */
/*                                                                     */
/* `paths`  : config file candidate locations per platform             */
/*            (templates: %VAR%, ~/, $VAR) — first existing           */
/*            one is used.                                             */
/* `key`    : dot-path key inside the file (e.g. "mcp.servers").      */
/* `shape`  : entry shape: standard | vscode | opencode.               */
/* `create` : "dir"  = may create a new file as long as the folder exists      */
/*            "mkdir"= may create folder + file (e.g. .vscode in a project)   */
/*            "never" = only modifies existing files                           */
/* ------------------------------------------------------------------ */

const CLIENTS = [
  {
    id: 'opencode',
    name: 'OpenCode',
    key: 'mcp.servers',
    shape: 'opencode',
    create: 'dir',
    paths: [() => defaultOpencodeConfigPath()],
    note: 'Already written by `npm run setup:npm`; here it only keeps things in sync.',
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
    note: 'Fully restart the desktop app (quit, do not just close the window) after changing the config.',
  },
  {
    id: 'claude-code',
    name: 'Claude Code (CLI)',
    key: 'mcpServers',
    shape: 'standard',
    create: 'dir',
    paths: ['~/.claude.json'],
    note: 'The CLI alternative: claude mcp add --transport stdio script-sandbox -- <node> <server.js>',
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
    note: 'Cline creates this file on first launch; if it is missing, register it via the Cline UI (MCP Servers).',
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
    note: 'Same format as Cline (a fork).',
  },
  {
    id: 'vscode',
    name: 'VS Code — user settings (GitHub Copilot / MCP extension)',
    key: 'mcp.servers',
    shape: 'vscode',
    create: 'never',
    paths: [
      '%APPDATA%/Code/User/settings.json',
      '~/Library/Application Support/Code/User/settings.json',
      '~/.config/Code/User/settings.json',
    ],
    note: 'settings.json usually contains JSONC (comments) — if it is skipped, use --print then paste.',
  },
  {
    id: 'vscode-workspace',
    name: 'VS Code — workspace (.vscode/mcp.json)',
    key: 'servers',
    shape: 'vscode',
    create: 'mkdir',
    optIn: true,
    paths: [() => path.join(process.cwd(), '.vscode', 'mcp.json')],
    note: 'Project scope (Copilot Chat in this repo). Opt-in: pick it explicitly via --clients vscode-workspace.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    key: 'mcpServers',
    shape: 'standard',
    create: 'dir',
    paths: ['~/.gemini/settings.json'],
    note: 'Format: settings.json -> mcpServers. Verify the key name in your CLI version (--print).',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    key: 'mcpServers',
    shape: 'standard',
    create: 'dir',
    paths: ['~/.cursor/mcp.json'],
    note: 'Cursor also has an MCP UI under Settings → MCP; this is the file it reads.',
  },
  {
    id: 'windsurf',
    name: 'Windsurf (Codeium)',
    key: 'mcpServers',
    shape: 'standard',
    create: 'never',
    paths: ['~/.codeium/windsurf/mcp_config.json'],
    note: 'The path may differ between Windsurf versions — check with --list, then use --file if needed.',
  },
];

const SHAPES = {
  /** Most common style: command + args + env. */
  standard: ({ nodePath, serverPath, env }) => ({
    command: nodePath,
    args: [serverPath],
    env,
  }),
  /** VS Code (mcp.json / settings.json): requires type stdio. */
  vscode: ({ nodePath, serverPath, env }) => ({
    type: 'stdio',
    command: nodePath,
    args: [serverPath],
    env,
  }),
  /** OpenCode: command is an array + `environment` (not `env`). */
  opencode: ({ nodePath, serverPath, env }) => ({
    type: 'local',
    command: [nodePath, serverPath],
    environment: env,
    timeout: { startup: 60000 },
  }),
};

function buildEntry(client, ctx) {
  const shape = SHAPES[client.shape];
  if (!shape) fail(`shape "${client.shape}" is unknown for client ${client.id}`);
  return shape(ctx);
}

/**
 * Folders considered "not owned by any single client": HOME, the user config/data
 * folders, and cwd. Creating a new file exactly at these roots (e.g. ~/.claude.json
 * for a CLI that is not installed yet) is considered unsafe — just skip it.
 */
const GENERIC_ROOTS = [os.homedir(), userConfigDir(), userDataDir(), process.cwd()].map((p) =>
  path.resolve(p).toLowerCase(),
);

/** Expand path templates + pick the candidate used on this device. */
function resolveClientFile(client) {
  const candidates = client.paths
    .map((p) => (typeof p === 'function' ? p() : expandPath(p)))
    .map((p) => path.resolve(p));

  const existing = candidates.find((p) => fs.existsSync(p));
  if (existing) return { file: existing, detected: true };

  const withDir = candidates.find((p) => fs.existsSync(path.dirname(p)));
  if (withDir) {
    // generic root folders (HOME, %APPDATA%, etc.) exist on every device;
    // they must not count as "client installed" — the client's own config file is what matters.
    const parent = path.resolve(path.dirname(withDir)).toLowerCase();
    if (client.create !== 'mkdir' && GENERIC_ROOTS.includes(parent)) {
      return { file: null, detected: false };
    }
    return { file: withDir, detected: false };
  }

  // clients allowed to create their own folder (e.g. .vscode in a project) are still offered
  if (client.create === 'mkdir') return { file: candidates[0], detected: false };

  return { file: null, detected: false };
}

function detectStatus(client) {
  const { file, detected } = resolveClientFile(client);
  if (!file) return { status: 'not installed', file: null };
  if (detected) return { status: 'detected', file };
  return { status: 'folder exists (no file)', file };
}

/** Stringify with sorted keys: the idempotent comparison does not depend on key order. */
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

/** Simple deep-equal to detect "nothing changed". */
const sameEntry = (a, b) => stableStringify(a) === stableStringify(b);

/**
 * A new entry overwrites the fields we manage (command/args/env), but fields that
 * only the user owns are kept — e.g. `disabled` in OpenCode or
 * `autoApprove` in Cline must not vanish just because the server was updated.
 */
const mergeEntry = (prev, next) => ({
  ...(prev && typeof prev === 'object' ? prev : {}),
  ...next,
});

function updateClient(client, ctx, { dryRun }) {
  // An explicit --file is used as-is: the user typed the path, so no
  // further detection is needed; its parent folder may be created on write.
  const { file, detected } = client.forcedFile
    ? { file: client.forcedFile, detected: fs.existsSync(client.forcedFile) }
    : resolveClientFile(client);

  if (!file) {
    return { state: 'skipped (not installed)', file: null, changed: false };
  }
  if (!detected && client.create === 'never') {
    return { state: `skipped (file missing; register via the client UI)`, file, changed: false };
  }

  const entry = buildEntry(client, ctx);

  // File does not exist → it may be created, UNLESS the location is a generic folder (HOME,
  // %APPDATA%, etc.) that always exists even when the client is not installed.
  if (!fs.existsSync(file)) {
    const parent = path.dirname(file);
    if (
      client.create !== 'mkdir' &&
      !client.forcedFile &&
      GENERIC_ROOTS.includes(path.resolve(parent).toLowerCase())
    ) {
      return { state: 'skipped (file missing; register via the client UI)', file, changed: false };
    }
    if (dryRun) return { state: 'will be created', file, changed: true };
    fs.mkdirSync(parent, { recursive: true });
    const fresh = setDotPath({}, `${client.key}.${SERVER_NAME}`, entry);
    fs.writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`, 'utf8');
    return { state: 'created', file, changed: true };
  }

  const raw = fs.readFileSync(file, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    return {
      state: 'skipped (not plain JSON — paste manually)',
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
    return { state: 'already identical', file, changed: false };
  }

  if (dryRun) {
    return { state: prev ? 'will be updated' : 'will be added', file, changed: true };
  }

  const backup = `${file}.bak.mcp`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);

  setDotPath(cfg, `${client.key}.${SERVER_NAME}`, merged);
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return { state: prev ? 'updated' : 'added', file, changed: true, backup };
}

/* ------------------------------ CLI ------------------------------ */

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(
    [
      'Usage: node scripts/setup-clients.js [options]',
      '',
      '  --list                 list clients + detection status + config paths on this device',
      '  --clients a,b,c        clients to write (default: all detected)',
      '  --all                  all clients (except opt-in ones: vscode-workspace)',
      `  --print <id|all>       show a paste-ready config block, without writing`,
      '  --dry-run              show actions without changing any file',
      `  --server <path>        path to src/server.js (default: resolved from the install)`,
      `  --sandbox-root <dir>   value of SCRIPT_SANDBOX_ROOT (default: ${toSlashes(defaultSandboxRoot())})`,
      `  --name <name>          entry name in the client (default: ${SERVER_NAME})`,
      '  --file <path>          force a config path (only with a single --clients)',
      '  --help                 show this help',
      '',
      'Supported clients: ' + CLIENTS.map((c) => c.id).join(', '),
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
    'server.js is not installed anywhere.\n' +
      'Run `npm run setup:npm` first (or install the package from the npm registry), ' +
      'or point to it manually with --server <path>/src/server.js',
  );
}

const CTX = {
  nodePath: NODE_PATH,
  serverPath: toSlashes(serverPath),
  env: { SCRIPT_SANDBOX_ROOT: toSlashes(SANDBOX_ROOT) },
};

function selectClients() {
  // opt-in clients (e.g. project scope) never join --all / automatic detection
  if (hasFlag('--all')) return CLIENTS.filter((c) => !c.optIn);
  const raw = optValue('--clients', null);
  if (!raw) {
    return CLIENTS.filter(
      (c) => !c.optIn && detectStatus(c).status !== 'not installed',
    );
  }
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !CLIENTS.some((c) => c.id === id));
  if (unknown.length) {
    fail(`unknown client: ${unknown.join(', ')}\nsupported clients: ${CLIENTS.map((c) => c.id).join(', ')}`);
  }
  return CLIENTS.filter((c) => ids.includes(c.id));
}

function printMode(target) {
  const list = target === 'all' ? CLIENTS : CLIENTS.filter((c) => c.id === target);
  if (!list.length) fail(`unknown client: ${target}`);
  for (const client of list) {
    const { file } = detectStatus(client);
    console.log(`\n=== ${client.name}  (id: ${client.id}, key: ${client.key}.${NAME}) ===`);
    console.log(`config: ${file || '(not installed on this device)'}`);
    console.log(`note: ${client.note}`);
    const block = setDotPath({}, `${client.key}.${NAME}`, buildEntry(client, CTX));
    console.log(JSON.stringify(block, null, 2));
  }
}

function main() {
  if (hasFlag('--list')) {
    console.log('supported clients + status on this device:\n');
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
    fail('--file only works with a single client (--clients <id>)');
  }

  const dryRun = hasFlag('--dry-run');
  const forcedFile = argv.includes('--file') ? path.resolve(optValue('--file', '')) : null;
  const targets = selectClients();

  console.log(
    `setup-clients: ${PKG.name}@${PKG.version}\n` +
      `  server : ${CTX.serverPath}\n` +
      `  node   : ${CTX.nodePath}\n` +
      `  sandbox: ${CTX.env.SCRIPT_SANDBOX_ROOT}\n` +
      `  mode   : ${dryRun ? 'dry-run (no writes)' : 'writing'}\n`,
  );

  if (!targets.length) {
    console.log('No clients installed on this device.');
    console.log('See the list       : node scripts/setup-clients.js --list');
    console.log('Or write explicitly: node scripts/setup-clients.js --clients claude-desktop,cursor');
    console.log('Or paste manually  : node scripts/setup-clients.js --print <id>');
    return;
  }

  let changed = 0;
  for (const client of targets) {
    const opts = forcedFile ? { ...client, forcedFile, create: 'dir' } : client;
    const result = updateClient(opts, CTX, { dryRun });
    if (result.changed) changed += 1;
    console.log(`  ${client.id.padEnd(18)} ${result.state.padEnd(38)} ${result.file || ''}`);
    if (result.needsManual) {
      console.log(`    ! ${result.reason} — copy this block:`);
      const manual = setDotPath({}, `${client.key}.${NAME}`, result.entry);
      console.log(`${JSON.stringify(manual, null, 2).replace(/\n/g, '\n    ')}\n`);
    }
  }

  console.log(`\nDone: ${targets.length} clients processed, ${changed} changed.`);
  if (!dryRun && changed > 0) {
    console.log('Restart the affected clients so the config is re-read.');
  }
  console.log('Verify per client: check that its MCP panel shows "script-sandbox" with 9 tools.');
}

try {
  main();
} catch (err) {
  console.error(`\n[s setup-clients] FAILED: ${err?.stack || String(err)}`);
  process.exitCode = 1;
}
