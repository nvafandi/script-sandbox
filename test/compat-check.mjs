/**
 * Compatibility check for other MCP clients / AI providers.
 *
 * The server is client-agnostic (plain stdio JSON-RPC + text content blocks),
 * but "compatible" should be proven, not assumed:
 *
 *   1. --print config blocks for every supported client parse and point at
 *      files that really exist (node + server.js + sandbox env)
 *   2. a RAW stdio session with NO SDK client (what minimal integrations
 *      write): initialize on an old AND a current protocol version, ping,
 *      tools/list, tools/call with and without arguments, error payloads
 *   3. stdout carries JSON-RPC only (every line parses — logging to stdout
 *      would break every client), and results are plain text content blocks
 *      (no structuredContent / image / resource blocks older clients choke on)
 *   4. tool schemas are strict-JSON-Schema friendly (type object, required
 *      subset of properties, string descriptions, draft-07 marker if any)
 *   5. the filesystem tools keep the official Filesystem MCP server API —
 *      same names, same required arguments (only write_file.overwrite is extra)
 *   6. tool annotations (readOnlyHint/idempotentHint/destructiveHint/
 *      openWorldHint) follow the official server's documented mapping, so
 *      clients that auto-approve read-only tools behave the same way
 *
 * Run: node test/compat-check.mjs  (part of `npm test`)
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const serverEntry = path.join(ROOT, 'src', 'server.js');
const clientsScript = path.join(ROOT, 'scripts', 'setup-clients.js');
const SERVER_NAME = 'script-sandbox';

/* 1. paste-ready config block of every supported client ------------------ */

const SHAPE_BY_ID = {
  opencode: 'opencode',
  'claude-desktop': 'standard',
  'claude-code': 'standard',
  cline: 'standard',
  roo: 'standard',
  vscode: 'vscode',
  'vscode-workspace': 'vscode',
  gemini: 'standard',
  cursor: 'standard',
  windsurf: 'standard',
};

/** Extract the first JSON object from --print output (headers come first). */
function firstJson(out) {
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
}

/** Find the server entry anywhere in the block (key differs per client). */
function findEntry(node) {
  if (!node || typeof node !== 'object') return null;
  if (node[SERVER_NAME] && typeof node[SERVER_NAME] === 'object') return node[SERVER_NAME];
  for (const value of Object.values(node)) {
    const found = findEntry(value);
    if (found) return found;
  }
  return null;
}

function validateEntry(entry, shape, id) {
  let nodePath;
  let serverPath;
  if (shape === 'opencode') {
    assert.equal(entry.type, 'local', `${id}: type local`);
    assert.ok(Array.isArray(entry.command) && entry.command.length === 2, `${id}: command = [node, server]`);
    assert.equal(typeof entry.environment?.SCRIPT_SANDBOX_ROOT, 'string', `${id}: environment.SCRIPT_SANDBOX_ROOT`);
    assert.equal(typeof entry.timeout?.startup, 'number', `${id}: timeout.startup`);
    [nodePath, serverPath] = entry.command;
  } else {
    assert.equal(typeof entry.command, 'string', `${id}: command is a string`);
    assert.ok(Array.isArray(entry.args) && entry.args.length >= 1, `${id}: args point at server.js`);
    assert.equal(typeof entry.env?.SCRIPT_SANDBOX_ROOT, 'string', `${id}: env.SCRIPT_SANDBOX_ROOT`);
    if (shape === 'vscode') assert.equal(entry.type, 'stdio', `${id}: type stdio`);
    nodePath = entry.command;
    [serverPath] = entry.args;
  }
  assert.ok(fs.existsSync(nodePath), `${id}: node exists (${nodePath})`);
  assert.ok(fs.existsSync(serverPath), `${id}: server.js exists (${serverPath})`);
  assert.ok(serverPath.endsWith('src/server.js'), `${id}: args target server.js`);
}

for (const [id, shape] of Object.entries(SHAPE_BY_ID)) {
  const res = spawnSync(process.execPath, [clientsScript, '--print', id], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(res.status, 0, `--print ${id} exited ${res.status}: ${res.stderr}`);
  const block = firstJson(`${res.stdout}${res.stderr}`);
  const entry = findEntry(block);
  assert.ok(entry, `${id}: block contains a "${SERVER_NAME}" entry`);
  validateEntry(entry, shape, id);
}
console.log(`  PASS  config blocks for ${Object.keys(SHAPE_BY_ID).length} clients`);

/* 2-3. raw stdio session, no SDK client ---------------------------------- */

function createSession(label, protocolVersion) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const noise = []; // stdout lines that are NOT JSON-RPC -> protocol violation

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        noise.push(line);
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) {
          waiter.reject(
            new Error(`${label}: ${waiter.method} -> ${JSON.stringify(message.error)}\nstderr: ${stderr}`),
          );
        } else {
          waiter.resolve(message.result);
        }
      }
    }
  });

  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${label}: timeout waiting for ${method}\nstderr: ${stderr}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params = {}) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

  async function handshake() {
    const init = await request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'script-sandbox-compat', version: '0' },
    });
    notify('notifications/initialized');
    return init;
  }

  async function close() {
    const exited = new Promise((resolve) => child.on('close', resolve));
    child.stdin.end();
    const forceKill = new Promise((resolve) =>
      setTimeout(() => {
        child.kill();
        resolve();
      }, 3000),
    );
    await Promise.race([exited, forceKill]);
    return { noise, stderr };
  }

  return { request, notify, handshake, close, noise };
}

const noArgTools = (tools) =>
  tools.filter((tool) => !(tool.inputSchema.required || []).length).map((tool) => tool.name);

/** Every tools/call result must be plain text content blocks (plus optional isError). */
function assertTextOnly(result, label) {
  assert.ok(Array.isArray(result.content) && result.content.length > 0, `${label}: content array`);
  for (const item of result.content) {
    assert.equal(item.type, 'text', `${label}: only text content blocks (got ${item.type})`);
    assert.equal(typeof item.text, 'string', `${label}: text is a string`);
  }
  assert.ok(!('structuredContent' in result), `${label}: no structuredContent (older clients ignore it, but keep it uniform)`);
}

/* session A: an OLD client (protocol 2024-11-05) */
let tools;
{
  const session = createSession('2024-11-05', '2024-11-05');
  const init = await session.handshake();
  assert.equal(init.protocolVersion, '2024-11-05', 'old protocol version negotiated (echoed back)');
  assert.equal(init.serverInfo?.name, SERVER_NAME, 'serverInfo.name');
  assert.ok(init.capabilities?.tools, 'tools capability advertised');
  assert.equal(typeof init.instructions, 'string', 'instructions is a string');

  await session.request('ping');

  const listed = await session.request('tools/list');
  assert.equal(listed.tools.length, 22, `tools/list returns 22 tools (got ${listed.tools.length})`);
  tools = listed.tools;

  const called = await session.request('tools/call', {
    name: 'list_allowed_directories',
    arguments: {},
  });
  assert.ok(!called.isError, 'no-arg tools/call succeeds');
  assertTextOnly(called, 'list_allowed_directories');
  const payload = JSON.parse(called.content[0].text);
  assert.ok(Array.isArray(payload.directories) && payload.directories.length >= 1, 'directories listed');

  const { noise } = await session.close();
  assert.deepEqual(noise, [], 'stdout carries JSON-RPC only (nothing logged to stdout)');
  console.log('  PASS  raw stdio session on protocol 2024-11-05 (old clients)');
}

/* session B: a CURRENT client (protocol 2025-03-26), write/read roundtrip */
{
  const session = createSession('2025-03-26', '2025-03-26');
  const init = await session.handshake();
  assert.equal(init.protocolVersion, '2025-03-26', 'current protocol version negotiated');

  const written = await session.request('tools/call', {
    name: 'write_file',
    arguments: { path: 'compat/hello.txt', content: 'compat-check\n', overwrite: true },
  });
  assert.ok(!written.isError, `write_file: ${written.content?.[0]?.text}`);
  assertTextOnly(written, 'write_file');

  const read = await session.request('tools/call', {
    name: 'read_text_file',
    arguments: { path: 'compat/hello.txt' },
  });
  assertTextOnly(read, 'read_text_file');
  assert.ok(JSON.parse(read.content[0].text).content.includes('compat-check'), 'roundtrip content');

  // errors stay JSON-RPC success + isError + JSON payload with a code
  const escape = await session.request('tools/call', {
    name: 'read_text_file',
    arguments: { path: '../../escape.txt' },
  });
  assert.equal(escape.isError, true, 'outside allowed dirs -> isError');
  assertTextOnly(escape, 'escape error');
  assert.equal(JSON.parse(escape.content[0].text).code, 'PATH_ESCAPE', 'error code present');

  const { noise } = await session.close();
  assert.deepEqual(noise, [], 'stdout carries JSON-RPC only');
  console.log('  PASS  raw stdio session on protocol 2025-03-26 (write/read/error)');
}

/* 4. strict JSON Schema friendliness ------------------------------------- */

for (const tool of tools) {
  const name = tool.name;
  assert.match(name, /^[a-z0-9_]+$/, `${name}: tool name is lowercase snake_case`);
  assert.ok(
    typeof tool.description === 'string' && tool.description.length > 10,
    `${name}: non-empty description (providers show it to the model)`,
  );
  const schema = tool.inputSchema;
  assert.equal(typeof schema, 'object', `${name}: inputSchema is an object`);
  if (schema.$schema) {
    assert.match(schema.$schema, /draft-07/, `${name}: $schema is draft-07 when present`);
  }
  if (schema.properties) {
    assert.equal(schema.type, 'object', `${name}: type object when properties exist`);
    for (const [key, property] of Object.entries(schema.properties)) {
      if ('description' in property) {
        assert.equal(typeof property.description, 'string', `${name}.${key}: description is a string`);
      }
      if ('type' in property) {
        assert.ok(
          ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(property.type),
          `${name}.${key}: plain JSON Schema type`,
        );
      }
    }
    for (const key of schema.required || []) {
      assert.ok(key in schema.properties, `${name}: required "${key}" is declared in properties`);
    }
  }
}
// tools that need no arguments must not declare required ones (some clients
// build a "no arguments" call from this)
for (const name of ['sandbox_info', 'list_scripts', 'list_allowed_directories']) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `${name} registered`);
  assert.ok(!(tool.inputSchema.required || []).length, `${name} takes no required arguments`);
}
console.log('  PASS  tool schemas are strict JSON Schema (draft-07 friendly)');

/* 5. API parity with the official Filesystem MCP server ------------------- */
/* https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem
 * Same tool names + same argument names, so an agent that knows the official
 * server can switch without re-learning anything. Only documented deviation:
 * write_file gained `overwrite` (this project refuses silent replacements). */

const OFFICIAL_FS_TOOLS = {
  read_text_file: { required: ['path'], optional: ['head', 'tail'] },
  read_media_file: { required: ['path'], optional: [] },
  read_multiple_files: { required: ['paths'], optional: [] },
  write_file: { required: ['path', 'content'], optional: [], extra: ['overwrite'] },
  edit_file: { required: ['path', 'edits'], optional: ['dryRun'] },
  create_directory: { required: ['path'], optional: [] },
  list_directory: { required: ['path'], optional: [] },
  list_directory_with_sizes: { required: ['path'], optional: ['sortBy'] },
  move_file: { required: ['source', 'destination'], optional: [] },
  search_files: { required: ['path', 'pattern'], optional: ['excludePatterns'] },
  directory_tree: { required: ['path'], optional: ['excludePatterns'] },
  get_file_info: { required: ['path'], optional: [] },
  list_allowed_directories: { required: [], optional: [] },
};

for (const [name, spec] of Object.entries(OFFICIAL_FS_TOOLS)) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `official tool present: ${name}`);
  const properties = tool.inputSchema.properties || {};
  assert.deepEqual(
    [...(tool.inputSchema.required || [])].sort(),
    [...spec.required].sort(),
    `${name}: same required arguments as the official server`,
  );
  const expected = [...new Set([...spec.required, ...spec.optional, ...(spec.extra || [])])].sort();
  assert.deepEqual(
    Object.keys(properties).sort(),
    expected,
    `${name}: same argument names as the official server`,
  );
}
assert.equal(
  noArgTools(tools).filter((n) => n in OFFICIAL_FS_TOOLS).length,
  1,
  'only list_allowed_directories takes no arguments among the official tools',
);
console.log('  PASS  filesystem API matches the official Filesystem MCP server');

/* 6. tool annotations (hints) — official mapping ------------------------- */
/* The tools came from the 2024-11-05 session above, proving old clients see
 * them too (extra JSON fields are simply ignored by lenient parsers). */

const READ_ONLY_FS_TOOLS = [
  'read_text_file',
  'read_media_file',
  'read_multiple_files',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'search_files',
  'get_file_info',
  'list_allowed_directories',
];
for (const name of READ_ONLY_FS_TOOLS) {
  const tool = tools.find((t) => t.name === name);
  assert.equal(tool.annotations?.readOnlyHint, true, `${name}: readOnlyHint true (official mapping)`);
  assert.equal(tool.annotations?.openWorldHint, false, `${name}: openWorldHint false`);
}
const WRITE_TOOL_HINTS = {
  create_directory: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
  write_file: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
  edit_file: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  move_file: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
};
for (const [name, hints] of Object.entries(WRITE_TOOL_HINTS)) {
  const tool = tools.find((t) => t.name === name);
  for (const [key, value] of Object.entries(hints)) {
    assert.equal(tool.annotations?.[key], value, `${name}: ${key}=${value} (official mapping)`);
  }
}
// every tool carries annotations with boolean hints...
for (const tool of tools) {
  assert.ok(tool.annotations, `${tool.name}: annotations present`);
  for (const [key, value] of Object.entries(tool.annotations)) {
    assert.equal(typeof value, 'boolean', `${tool.name}: annotations.${key} is boolean`);
  }
}
// ...and the run_* tools are honest about native code: open world, never read-only
for (const name of ['run_script', 'run_code', 'run_executable']) {
  const tool = tools.find((t) => t.name === name);
  assert.equal(tool.annotations.openWorldHint, true, `${name}: open world (native code may reach the network)`);
  assert.equal(tool.annotations.readOnlyHint, false, `${name}: never read-only`);
}
console.log('  PASS  tool annotations follow the official server mapping');

console.log('compat-check: OK');
