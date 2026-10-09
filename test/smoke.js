/**
 * Smoke test: run the MCP server over stdio and test all tools + guardrails.
 * Run: npm test
 *
 * Languages under test follow those available on the device (sandbox_info);
 * PowerShell/Node/bash must exist on this device's CI; the rest are skipped if missing.
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

/** Call a tool; the JSON payload is read from text (errors are JSON too). */
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '{}';
  return { isError: Boolean(res.isError), payload: JSON.parse(text) };
}

const expectCode = (res, code) =>
  assert.equal(res.payload.code, code, `error code: ${res.payload.code} (expected ${code}) — ${res.payload.error}`);

/* 1. tools registered */
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
  console.log('  PASS  9 tools registered');
}

/* 2. sandbox_info */
let info;
{
  const res = await call('sandbox_info');
  info = res.payload;
  assert.ok(!res.isError);
  assert.ok(info.root.includes('script-sandbox'), 'root in the script-sandbox folder');
  assert.ok(info.extensions.includes('.ps1') && info.extensions.includes('.js') && info.extensions.includes('.sh'));
  const langs = Object.fromEntries(info.languages.map((l) => [l.kind, l]));
  assert.ok(langs.powershell.available, 'PowerShell detected');
  assert.ok(langs.node.available, 'Node detected');
  assert.ok(langs.sh.available, 'bash detected');
  console.log('  PASS  sandbox_info ok');
  console.log('  info: languages =', info.languages.filter((l) => l.available).map((l) => l.kind).join(', '));
}

const has = (kind) => info.languages.find((l) => l.kind === kind)?.available;
/** Actually usable: resolved from PATH + passed the sandbox_info probe. */
const canRun = (kind) => info.interpreters?.[kind]?.available ?? has(kind);

/* 3. write + run .ps1 */
{
  const w = await call('write_script', { name: 'smoke/hello.ps1', content: 'Write-Output "hello-ps"\n', overwrite: true });
  assert.ok(!w.isError && w.payload.created);
  const r = await call('run_script', { script: 'smoke/hello.ps1' });
  assert.ok(!r.isError, 'run ps1 without error');
  assert.equal(r.payload.exit_code, 0);
  assert.ok(r.payload.stdout.includes('hello-ps'));
  assert.equal(r.payload.interpreter_kind, 'powershell');
  assert.ok(r.payload.cwd.includes('work'), 'cwd inside the sandbox');
  console.log('  PASS  run .ps1 exit 0');
}

/* 4. reject overwrite without flag; read; list; delete */
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

/* 5. path guards */
{
  expectCode(await call('read_script', { name: '../../../escape.ps1' }), 'PATH_ESCAPE');
  expectCode(await call('read_script', { name: 'C:/Windows/win.ini' }), 'INVALID_PATH');
  expectCode(await call('write_script', { name: 'x.txt', content: 'x' }), 'INVALID_SCRIPT');
  console.log('  PASS  reject traversal/absolute/foreign extension');
}

/* 6. per-language guardrail + comments do not block */
{
  const ps = await call('write_script', { name: 'smoke/bad.ps1', content: 'Format-Volume -DriveLetter C\n', overwrite: true });
  assert.ok(!ps.isError);
  expectCode(await call('run_script', { script: 'smoke/bad.ps1' }), 'DENIED');

  const sh = await call('write_script', { name: 'smoke/bad.sh', content: 'rm -rf / \n', overwrite: true });
  assert.ok(!sh.isError);
  expectCode(await call('run_script', { script: 'smoke/bad.sh' }), 'DENIED');

  // comments containing dangerous patterns do NOT block
  const safe = await call('write_script', {
    name: 'smoke/comment.sh',
    content: '# example: rm -rf / is dangerous\necho safe\n',
    overwrite: true,
  });
  assert.ok(!safe.isError);
  const run = await call('run_script', { script: 'smoke/comment.sh' });
  assert.equal(run.payload.exit_code, 0, 'comment does not block');
  assert.ok(run.payload.stdout.includes('safe'));

  if (has('python')) {
    const py = await call('write_script', {
      name: 'smoke/bad.py',
      content: 'import shutil\nshutil.rmtree("/")\n',
      overwrite: true,
    });
    assert.ok(!py.isError);
    expectCode(await call('run_script', { script: 'smoke/bad.py' }), 'DENIED');
  }

  if (has('java')) {
    const jv = await call('write_script', {
      name: 'smoke/bad.java',
      content: 'class Bad { public static void main(String[] a) { try { Runtime.getRuntime().exec("rm -rf /"); } catch (Exception e) {} } }\n',
      overwrite: true,
    });
    assert.ok(!jv.isError);
    expectCode(await call('run_script', { script: 'smoke/bad.java' }), 'DENIED');
  }

  // Safe Java code must not hit the guardrail (e.g. without the shutdown keyword)
  if (canRun('java')) {
    const safeJv = await call('write_script', {
      name: 'smoke/ok.java',
      content: 'class Ok { public static void main(String[] a) { System.out.println("java-safe"); } }\n',
      overwrite: true,
    });
    assert.ok(!safeJv.isError);
    const jvRun = await call('run_script', { script: 'smoke/ok.java' });
    assert.equal(jvRun.payload.exit_code, 0, `safe java runs: ${jvRun.payload.stderr}`);
    assert.ok(jvRun.payload.stdout.includes('java-safe'));
  }
  console.log('  PASS  guardrail blocks, safe comments');
}

/* 7. .js + extra env + exit code + stderr + log */
{
  const w = await call('write_script', {
    name: 'smoke/info.js',
    content: 'console.log("flag=" + (process.env.MY_FLAG || "none"));\nconsole.error("this-stderr");\nprocess.exit(3);\n',
    overwrite: true,
  });
  assert.ok(!w.isError && w.payload.language === 'Node.js');
  const r = await call('run_script', { script: 'smoke/info.js', env: { MY_FLAG: 'yes' } });
  assert.equal(r.payload.exit_code, 3, 'exit code forwarded');
  assert.ok(r.payload.stdout.includes('flag=yes'), 'extra env forwarded');
  assert.ok(r.payload.stderr.includes('this-stderr'), 'stderr captured');

  const log = await call('read_log', { run_id: r.payload.run_id, which: 'stdout' });
  assert.ok(log.payload.content.includes('flag=yes'), 'full stdout log');
  console.log('  PASS  run .js: env/exit code/stderr/log');
}

/* 8. .sh + CRLF normalization */
{
  const w = await call('write_script', {
    name: 'smoke/lines.sh',
    content: 'echo "hello-sh"\r\n',
    overwrite: true,
  });
  assert.ok(!w.isError);
  assert.equal(w.payload.normalized_crlf, true, 'CRLF normalized');
  const r = await call('run_script', { script: 'smoke/lines.sh' });
  assert.equal(r.payload.exit_code, 0);
  assert.ok(r.payload.stdout.includes('hello-sh'));
  console.log('  PASS  run .sh (LF normalized)');
}

/* 9. other languages per device availability */
{
  const probe = {
    python: 'print("ok-py")',
    ruby: 'puts "ok-rb"',
    perl: 'print "ok-pl\\n";',
    php: 'echo "ok-php\\n";',
    java: 'class Probe { public static void main(String[] args) { System.out.println("ok-ja"); } }',
  };
  for (const [kind, code] of Object.entries(probe)) {
    if (!canRun(kind)) continue;
    const ext = { python: 'py', ruby: 'rb', perl: 'pl', php: 'php', java: 'java' }[kind];
    await call('write_script', { name: `smoke/x.${ext}`, content: `${code}\n`, overwrite: true });
    const r = await call('run_script', { script: `smoke/x.${ext}` });
    assert.equal(r.payload.exit_code, 0, `run ${kind} exit 0: ${r.payload.stderr}`);
    assert.ok(r.payload.stdout.includes(`ok-`), `stdout ${kind}`);
    console.log(`  PASS  run .${ext} (${kind})`);
  }
}

/* 10. run_code inline + leaves no files behind */
{
  const r = await call('run_code', { code: 'console.log(40 + 2);', language: 'js' });
  assert.ok(!r.isError, `run_code js: ${JSON.stringify(r.payload)}`);
  assert.ok(r.payload.stdout.trim().endsWith('42'));
  assert.equal(r.payload.kind, 'inline');

  // Java inline: file name is generated automatically, so the first class is not `public`
  if (canRun('java')) {
    const j = await call('run_code', {
      code: 'class Inline { public static void main(String[] a) { System.out.println(6 * 7); } }',
      language: 'java',
    });
    assert.ok(!j.isError, `run_code java: ${JSON.stringify(j.payload)}`);
    assert.equal(j.payload.exit_code, 0, `java inline failed: ${j.payload.stderr}`);
    assert.ok(j.payload.stdout.includes('42'), `inline java stdout: ${j.payload.stdout}`);
    assert.equal(j.payload.interpreter_kind, 'java');
    console.log('  PASS  run_code inline (java)');
  }

  const list = await call('list_scripts');
  assert.ok(!list.payload.scripts.some((s) => s.name.startsWith('__inline/')), 'no leftover inline files');

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
  assert.equal(r.payload.timed_out, true, 'timeout met');
  console.log('  PASS  timeout kills process');
}

/* 12. run_executable + guardrail args */
{
  const r = await call('run_executable', { executable: 'node', args: ['--version'] });
  assert.ok(!r.isError, `run_executable node: ${JSON.stringify(r.payload)}`);
  assert.equal(r.payload.exit_code, 0);
  assert.ok(r.payload.stdout.includes('v'), 'node --version runs');
  assert.equal(r.payload.kind, 'executable');

  expectCode(await call('run_executable', { executable: 'node', args: ['-e', 'rm -rf /'] }), 'DENIED');
  expectCode(await call('run_executable', { executable: 'nonexistent-xyz' }), 'NOT_FOUND');
  console.log('  PASS  run_executable + guardrail args');
}

await client.close();
console.log('\nsmoke test finished');
