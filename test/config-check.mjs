/**
 * Cek konfigurasi script-sandbox.
 *
 * - Tanpa argumen : verifikasi config portabel, interpreter ter-resolve dari
 *                   PATH device, dan run langsung .js + .ps1 (tanpa layer MCP).
 * - Dengan arg    : path opencode.json -> spawn server dari entry config,
 *                   handshake MCP, lalu run kode inline via tool run_code.
 *
 * Jalankan: node test/config-check.mjs [opencode.json]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2];

if (configPath) {
  /* ------------------------------------------------- mode opencode (spawn) */
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const entry = cfg.mcp?.servers?.['script-sandbox'];
  if (!entry) {
    console.error(`entry "script-sandbox" tidak ada di ${configPath}`);
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
  console.log(`handshake ok dalam ${Date.now() - t0}ms, tools=${tools.length}`);
  assert.equal(tools.length, 9, 'harusnya 9 tool');

  const res = await client.callTool({
    name: 'run_code',
    arguments: { code: 'console.log("config-check-ok")', language: 'js' },
  });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.exit_code, 0, `run_code gagal: ${payload.stderr}`);
  assert.ok(payload.stdout.includes('config-check-ok'), 'stdout inline code');
  console.log('exit    :', payload.exit_code, '| durasi:', payload.duration_ms + 'ms');

  await client.close();
  console.log('\nOK');
  process.exit(0);
}

/* ------------------------------------------------------- mode lokal (import) */
const { default: config } = await import('../src/config.js');
const { runScript, sandboxInfo, writeScript } = await import('../src/sandbox.js');

// Portabilitas: root di folder temp OS device, nama mengikuti package.
assert.ok(config.dirs.root.startsWith(path.resolve(os.tmpdir())), 'root di folder temp OS');
assert.ok(config.dirs.root.includes('script-sandbox'), 'nama folder = script-sandbox');
assert.ok(config.extensions.length >= 4, 'minimal .ps1/.sh/.py/.js terdaftar');
assert.ok(config.shells['.ps1'] && config.shells['.js'] && config.shells['.py'], 'registry per ekstensi ada');

console.log('root     :', config.dirs.root);
console.log('ekstensi :', config.extensions.join(', '));

const info = await sandboxInfo();
console.log(
  'bahasa   :',
  info.languages.map((l) => `${l.kind}${l.available ? ` (${l.version || 'ok'})` : ' (tidak ada)'}`).join(', '),
);
const byKind = Object.fromEntries(info.languages.map((l) => [l.kind, l]));
assert.ok(byKind.powershell?.available, 'powershell tersedia di device ini');
assert.ok(byKind.node?.available, 'node tersedia di device ini');
assert.ok(byKind.sh?.available, 'bash tersedia di device ini');

// Run langsung tanpa layer MCP: .js dan .ps1 wajib jalan.
await writeScript({ name: '__configcheck/hello.js', content: 'console.log("js-ok")\n', overwrite: true });
const js = await runScript({ script: '__configcheck/hello.js' });
assert.equal(js.exit_code, 0, `js gagal: ${js.stderr}`);
assert.ok(js.stdout.includes('js-ok'));

await writeScript({ name: '__configcheck/hello.ps1', content: 'Write-Output "ps-ok"\n', overwrite: true });
const ps = await runScript({ script: '__configcheck/hello.ps1' });
assert.equal(ps.exit_code, 0, `ps1 gagal: ${ps.stderr}`);
assert.ok(ps.stdout.includes('ps-ok'));

console.log('run      : .js + .ps1 exit 0');
console.log('\nOK');
