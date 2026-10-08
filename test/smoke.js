/**
 * Smoke test: jalankan MCP server lewat stdio dan uji semua tool + guardrail.
 * Jalankan: npm test
 *
 * Bahasa yang diuji otomatis mengikuti yang tersedia di device (sandbox_info);
 * PowerShell/Node/bash wajib ada di CI device ini, lainnya di-skip kalau tidak.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'src', 'server.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  stderr: 'ignore',
});
const client = new Client({ name: 'script-sandbox-smoke', version: '0' });
await client.connect(transport);

/** Panggil tool; payload JSON dibaca dari text (error pun berupa JSON). */
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '{}';
  return { isError: Boolean(res.isError), payload: JSON.parse(text) };
}

const expectCode = (res, code) =>
  assert.equal(res.payload.code, code, `kode error: ${res.payload.code} (diharapkan ${code}) — ${res.payload.error}`);

/* 1. tool terdaftar */
{
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'delete_script',
    'list_scripts',
    'read_log',
    'read_script',
    'run_code',
    'run_executable',
    'run_script',
    'sandbox_info',
    'write_script',
  ]);
  console.log('  PASS  9 tool terdaftar');
}

/* 2. sandbox_info */
let info;
{
  const res = await call('sandbox_info');
  info = res.payload;
  assert.ok(!res.isError);
  assert.ok(info.root.includes('script-sandbox'), 'root di folder script-sandbox');
  assert.ok(info.extensions.includes('.ps1') && info.extensions.includes('.js') && info.extensions.includes('.sh'));
  const langs = Object.fromEntries(info.languages.map((l) => [l.kind, l]));
  assert.ok(langs.powershell.available, 'PowerShell terdeteksi');
  assert.ok(langs.node.available, 'Node terdeteksi');
  assert.ok(langs.sh.available, 'bash terdeteksi');
  console.log('  PASS  sandbox_info ok');
  console.log('  info: bahasa =', info.languages.filter((l) => l.available).map((l) => l.kind).join(', '));
}

const has = (kind) => info.languages.find((l) => l.kind === kind)?.available;

/* 3. tulis + jalankan .ps1 */
{
  const w = await call('write_script', { name: 'smoke/hello.ps1', content: 'Write-Output "hello-ps"\n', overwrite: true });
  assert.ok(!w.isError && w.payload.created);
  const r = await call('run_script', { script: 'smoke/hello.ps1' });
  assert.ok(!r.isError, 'run ps1 tidak error');
  assert.equal(r.payload.exit_code, 0);
  assert.ok(r.payload.stdout.includes('hello-ps'));
  assert.equal(r.payload.interpreter_kind, 'powershell');
  assert.ok(r.payload.cwd.includes('work'), 'cwd di dalam sandbox');
  console.log('  PASS  run .ps1 exit 0');
}

/* 4. tolak overwrite tanpa flag; baca; daftar; hapus */
{
  const dup = await call('write_script', { name: 'smoke/hello.ps1', content: 'x' });
  expectCode(dup, 'ALREADY_EXISTS');

  const r = await call('read_script', { name: 'smoke/hello.ps1' });
  assert.ok(r.payload.content.includes('hello-ps'));

  const list = await call('list_scripts');
  assert.ok(list.payload.scripts.some((s) => s.name === 'smoke/hello.ps1'));

  const del = await call('delete_script', { name: 'smoke/hello.ps1' });
  assert.ok(del.payload.deleted);
  console.log('  PASS  overwrite/list/read/delete');
}

/* 5. penjaga path */
{
  expectCode(await call('read_script', { name: '../../../escape.ps1' }), 'PATH_ESCAPE');
  expectCode(await call('read_script', { name: 'C:/Windows/win.ini' }), 'INVALID_PATH');
  expectCode(await call('write_script', { name: 'x.txt', content: 'x' }), 'INVALID_SCRIPT');
  console.log('  PASS  tolak traversal/absolut/ekstensi asing');
}

/* 6. guardrail per bahasa + komentar tidak memblokir */
{
  const ps = await call('write_script', { name: 'smoke/bad.ps1', content: 'Format-Volume -DriveLetter C\n', overwrite: true });
  assert.ok(!ps.isError);
  expectCode(await call('run_script', { script: 'smoke/bad.ps1' }), 'DENIED');

  const sh = await call('write_script', { name: 'smoke/bad.sh', content: 'rm -rf / \n', overwrite: true });
  assert.ok(!sh.isError);
  expectCode(await call('run_script', { script: 'smoke/bad.sh' }), 'DENIED');

  // komentar berisi pola berbahaya TIDAK memblokir
  const safe = await call('write_script', {
    name: 'smoke/comment.sh',
    content: '# contoh: rm -rf / itu berbahaya\necho aman\n',
    overwrite: true,
  });
  assert.ok(!safe.isError);
  const run = await call('run_script', { script: 'smoke/comment.sh' });
  assert.equal(run.payload.exit_code, 0, 'komentar tidak memblokir');
  assert.ok(run.payload.stdout.includes('aman'));

  if (has('python')) {
    const py = await call('write_script', {
      name: 'smoke/bad.py',
      content: 'import shutil\nshutil.rmtree("/")\n',
      overwrite: true,
    });
    assert.ok(!py.isError);
    expectCode(await call('run_script', { script: 'smoke/bad.py' }), 'DENIED');
  }
  console.log('  PASS  guardrail memblokir, komentar aman');
}

/* 7. .js + env tambahan + exit code + stderr + log */
{
  const w = await call('write_script', {
    name: 'smoke/info.js',
    content: 'console.log("flag=" + (process.env.MY_FLAG || "none"));\nconsole.error("ini-stderr");\nprocess.exit(3);\n',
    overwrite: true,
  });
  assert.ok(!w.isError && w.payload.language === 'Node.js');
  const r = await call('run_script', { script: 'smoke/info.js', env: { MY_FLAG: 'yes' } });
  assert.equal(r.payload.exit_code, 3, 'exit code diteruskan');
  assert.ok(r.payload.stdout.includes('flag=yes'), 'env tambahan diteruskan');
  assert.ok(r.payload.stderr.includes('ini-stderr'), 'stderr tertangkap');

  const log = await call('read_log', { run_id: r.payload.run_id, which: 'stdout' });
  assert.ok(log.payload.content.includes('flag=yes'), 'log stdout penuh');
  console.log('  PASS  run .js: env/exit code/stderr/log');
}

/* 8. .sh + normalisasi CRLF */
{
  const w = await call('write_script', {
    name: 'smoke/lines.sh',
    content: 'echo "hello-sh"\r\n',
    overwrite: true,
  });
  assert.ok(!w.isError);
  assert.equal(w.payload.normalized_crlf, true, 'CRLF dinormalisasi');
  const r = await call('run_script', { script: 'smoke/lines.sh' });
  assert.equal(r.payload.exit_code, 0);
  assert.ok(r.payload.stdout.includes('hello-sh'));
  console.log('  PASS  run .sh (LF ternormalisasi)');
}

/* 9. bahasa lain sesuai ketersediaan device */
{
  const probe = { python: 'print("ok-py")', ruby: 'puts "ok-rb"', perl: 'print "ok-pl\\n";', php: 'echo "ok-php\\n";' };
  for (const [kind, code] of Object.entries(probe)) {
    if (!has(kind)) continue;
    const ext = { python: 'py', ruby: 'rb', perl: 'pl', php: 'php' }[kind];
    await call('write_script', { name: `smoke/x.${ext}`, content: `${code}\n`, overwrite: true });
    const r = await call('run_script', { script: `smoke/x.${ext}` });
    assert.equal(r.payload.exit_code, 0, `run ${kind} exit 0: ${r.payload.stderr}`);
    assert.ok(r.payload.stdout.includes(`ok-`), `stdout ${kind}`);
    console.log(`  PASS  run .${ext} (${kind})`);
  }
}

/* 10. run_code inline + tidak meninggalkan file */
{
  const r = await call('run_code', { code: 'console.log(40 + 2);', language: 'js' });
  assert.ok(!r.isError, `run_code js: ${JSON.stringify(r.payload)}`);
  assert.ok(r.payload.stdout.trim().endsWith('42'));
  assert.equal(r.payload.kind, 'inline');

  const list = await call('list_scripts');
  assert.ok(!list.payload.scripts.some((s) => s.name.startsWith('__inline/')), 'tidak ada file inline tersisa');

  const bad = await call('run_code', { code: 'x', language: 'cobol' });
  expectCode(bad, 'INVALID_LANGUAGE');
  console.log('  PASS  run_code inline (js)');
}

/* 11. timeout */
{
  const r = await call('run_code', {
    code: 'setInterval(() => {}, 1000);',
    language: 'js',
    timeout_ms: 1500,
  });
  assert.equal(r.payload.timed_out, true, 'timeout terpenuhi');
  console.log('  PASS  timeout mematikan proses');
}

/* 12. run_executable + guardrail args */
{
  const r = await call('run_executable', { executable: 'node', args: ['--version'] });
  assert.ok(!r.isError, `run_executable node: ${JSON.stringify(r.payload)}`);
  assert.equal(r.payload.exit_code, 0);
  assert.ok(r.payload.stdout.includes('v'), 'node --version jalan');
  assert.equal(r.payload.kind, 'executable');

  expectCode(await call('run_executable', { executable: 'node', args: ['-e', 'rm -rf /'] }), 'DENIED');
  expectCode(await call('run_executable', { executable: 'tidak-ada-xyz' }), 'NOT_FOUND');
  console.log('  PASS  run_executable + guardrail args');
}

await client.close();
console.log('\nsmoke test selesai');
