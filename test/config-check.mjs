/**
 * Check script-sandbox configuration.
 *
 * - No arguments  : verify portable config, interpreters resolved from
 *                   device PATH, and run .js + .ps1 directly (no MCP layer).
 * - With argument : path to opencode.json -> spawn the server from the config entry,
 *                   MCP handshake, then run inline code via the run_code tool.
 *
 * Run: node test/config-check.mjs [opencode.json]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2];

if (configPath) {
  /* ------------------------------------------------- opencode mode (spawn) */
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const entry = cfg.mcp?.servers?.['script-sandbox'];
  if (!entry) {
    console.error(`entry "script-sandbox" not found in ${configPath}`);
    process.exit(2);
  }
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const [command, ...args] = entry.command;
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...(entry.environment || {}) },
  });
  const client = new Client({ name: 'script-sandbox-config-check', version: '0' });

  console.log('config :', configPath);
  console.log('command:', command);
  console.log('args   :', args.join(' '));

  const t0 = Date.now();
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`handshake ok in ${Date.now() - t0}ms, tools=${tools.length}`);
  assert.equal(tools.length, 9, 'expected 9 tools');

  const res = await client.callTool({
    name: 'run_code',
    arguments: { code: 'console.log("config-check-ok")', language: 'js' },
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.exit_code, 0, `run_code failed: ${payload.stderr}`);
  assert.ok(payload.stdout.includes('config-check-ok'), 'stdout inline code');
  console.log('exit    :', payload.exit_code, '| duration:', payload.duration_ms + 'ms');

  await client.close();
  console.log('\nOK');
  process.exit(0);
}

/* ------------------------------------------------------- local mode (import) */
const { default: config } = await import('../src/config.js');
const { runScript, sandboxInfo, writeScript, scanDenied } = await import('../src/sandbox.js');

// Portability: root is in the device OS temp folder, name follows the package.
assert.ok(config.dirs.root.startsWith(path.resolve(os.tmpdir())), 'root in the OS temp folder');
assert.ok(config.dirs.root.includes('script-sandbox'), 'folder name = script-sandbox');
assert.ok(config.extensions.length >= 4, 'at least .ps1/.sh/.py/.js registered');
assert.ok(config.shells['.ps1'] && config.shells['.js'] && config.shells['.py'], 'per-extension registry present');

console.log('root     :', config.dirs.root);
console.log('extensions:', config.extensions.join(', '));

// Registry .java + its guardrail (static scan: no installed JDK needed).
assert.ok(config.shells['.java'], 'registry .java registered');
assert.ok(config.denySets.java.length > 0, 'java guardrail registered');
assert.ok(
  scanDenied('class A { void m() { try { Runtime.getRuntime().exec("rm -rf /"); } catch (Exception e) {} } }', 'java').length > 0,
  'Runtime.exec("rm -rf /") blocked by guardrail',
);
assert.ok(
  scanDenied('class A { void m() { new java.io.File("/").delete(); } }', 'java').length > 0,
  'File("/").delete() blocked by guardrail',
);
assert.equal(
  scanDenied('class A { void m() { executor.shutdown(); } }', 'java').length,
  0,
  'executor.shutdown() MUST NOT be blocked (false positive)',
);

const info = await sandboxInfo();
console.log(
  'languages:',
  info.languages.map((l) => `${l.kind}${l.available ? ` (${l.version || 'ok'})` : ' (missing)'}`).join(', '),
);
const byKind = Object.fromEntries(info.languages.map((l) => [l.kind, l]));
assert.ok(byKind.powershell?.available, 'powershell available on this device');
assert.ok(byKind.node?.available, 'node available on this device');
assert.ok(byKind.sh?.available, 'bash available on this device');

// Direct run without the MCP layer: .js and .ps1 must work.
await writeScript({ name: '__configcheck/hello.js', content: 'console.log("js-ok")\n', overwrite: true });
const js = await runScript({ script: '__configcheck/hello.js' });
assert.equal(js.exit_code, 0, `js failed: ${js.stderr}`);
assert.ok(js.stdout.includes('js-ok'));

await writeScript({ name: '__configcheck/hello.ps1', content: 'Write-Output "ps-ok"\n', overwrite: true });
const ps = await runScript({ script: '__configcheck/hello.ps1' });
assert.equal(ps.exit_code, 0, `ps1 failed: ${ps.stderr}`);
assert.ok(ps.stdout.includes('ps-ok'));

console.log('run      : .js + .ps1 exit 0');
console.log('\nOK');
