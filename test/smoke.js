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
    'create_directory',
    'delete_script',
    'directory_tree',
    'edit_file',
    'get_file_info',
    'list_allowed_directories',
    'list_directory',
    'list_directory_with_sizes',
    'list_scripts',
    'move_file',
    'read_log',
    'read_media_file',
    'read_multiple_files',
    'read_script',
    'read_text_file',
    'run_code',
    'run_executable',
    'run_script',
    'sandbox_info',
    'search_files',
    'write_file',
    'write_script',
  ]);
  console.log('  PASS  22 tools registered');
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

/* 7. .js + extra env + framework log redirect + exit code + stderr + log */
{
  const w = await call('write_script', {
    name: 'smoke/info.js',
    content:
      'console.log("flag=" + (process.env.MY_FLAG || "none"));\n' +
      'console.log("spring=" + (process.env.LOGGING_FILE_NAME || "none"));\n' +
      'console.log("quarkus=" + (process.env.QUARKUS_LOG_FILE_PATH || "none"));\n' +
      'console.error("this-stderr");\nprocess.exit(3);\n',
    overwrite: true,
  });
  assert.ok(!w.isError && w.payload.language === 'Node.js');
  const r = await call('run_script', { script: 'smoke/info.js', env: { MY_FLAG: 'yes' } });
  assert.equal(r.payload.exit_code, 3, 'exit code forwarded');
  assert.ok(r.payload.stdout.includes('flag=yes'), 'extra env forwarded');
  assert.ok(r.payload.stderr.includes('this-stderr'), 'stderr captured');

  // Framework file logs (Spring Boot / Quarkus) point into logs/<run_id>/ so a
  // mvn/gradle run never drops .log files into the project folder.
  assert.ok(
    r.payload.stdout.includes(`spring=${path.join(r.payload.log_dir, 'application.log')}`),
    'LOGGING_FILE_NAME redirected into the run log dir',
  );
  assert.ok(
    r.payload.stdout.includes(`quarkus=${path.join(r.payload.log_dir, 'quarkus.log')}`),
    'QUARKUS_LOG_FILE_PATH redirected into the run log dir',
  );

  // ...and an explicit env value from the caller still wins over the redirect.
  const over = await call('run_script', {
    script: 'smoke/info.js',
    env: { LOGGING_FILE_NAME: 'custom-app.log' },
  });
  assert.ok(over.payload.stdout.includes('spring=custom-app.log'), 'caller env wins over redirect');
  assert.ok(
    over.payload.stdout.includes(`quarkus=${path.join(over.payload.log_dir, 'quarkus.log')}`),
    'other redirect vars still apply when one is overridden',
  );

  const log = await call('read_log', { run_id: r.payload.run_id, which: 'stdout' });
  assert.ok(log.payload.content.includes('flag=yes'), 'full stdout log');
  console.log('  PASS  run .js: env/exit code/stderr/log + log redirect');
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

/* 13. filesystem tools: allowed directories + full CRUD flow */
{
  // allowed directories = sandbox root first (+ SCRIPT_SANDBOX_FS_ROOTS)
  const allowed = await call('list_allowed_directories');
  assert.ok(!allowed.isError);
  assert.equal(allowed.payload.directories[0], info.root, 'first allowed dir = sandbox root');
  assert.ok(info.fs_allowed_directories?.includes(info.root), 'sandbox_info exposes fs roots');

  // write -> read -> head -> get_file_info -> list
  const w = await call('write_file', { path: 'fs/hello.txt', content: 'hello-fs\nsecond\n', overwrite: true });
  assert.ok(!w.isError, `write_file: ${JSON.stringify(w.payload)}`);
  const r = await call('read_text_file', { path: 'fs/hello.txt' });
  assert.ok(r.payload.content.includes('hello-fs'));
  const head = await call('read_text_file', { path: 'fs/hello.txt', head: 1 });
  assert.equal(head.payload.lines_returned, 1, 'head=1 returns one line');
  assert.ok(!head.payload.content.includes('second'));
  expectCode(await call('read_text_file', { path: 'fs/hello.txt', head: 1, tail: 1 }), 'INVALID_INPUT');

  const meta = await call('get_file_info', { path: 'fs/hello.txt' });
  assert.equal(meta.payload.type, 'file');
  assert.ok(meta.payload.size_bytes > 0);
  assert.equal(meta.payload.permissions.octal.length, 3);

  const list = await call('list_directory', { path: 'fs' });
  assert.ok(list.payload.entries.some((e) => e.name === 'hello.txt' && e.type === 'file'));
  const sizes = await call('list_directory_with_sizes', { path: 'fs', sortBy: 'size' });
  assert.ok(sizes.payload.summary.total_files >= 1, 'summary counts the files');
  assert.equal(
    sizes.payload.summary.total_files + sizes.payload.summary.total_directories,
    sizes.payload.entries.length,
    'summary adds up to the entry list',
  );

  // overwrite guard + partial batch failure
  expectCode(await call('write_file', { path: 'fs/hello.txt', content: 'x' }), 'ALREADY_EXISTS');
  const multi = await call('read_multiple_files', { paths: ['fs/hello.txt', 'fs/missing.txt'] });
  assert.equal(multi.payload.failed, 1, 'one bad path does not stop the batch');
  assert.ok(multi.payload.files[0].ok && !multi.payload.files[1].ok);

  // edit_file: dry run previews without writing, then apply
  const edits = [{ oldText: 'second', newText: 'SECOND' }];
  const dry = await call('edit_file', { path: 'fs/hello.txt', edits, dryRun: true });
  assert.ok(!dry.isError && dry.payload.dry_run && dry.payload.changed && !dry.payload.written);
  assert.ok(dry.payload.diff.includes('-second') && dry.payload.diff.includes('+SECOND'), 'diff shown');
  const untouched = await call('read_text_file', { path: 'fs/hello.txt' });
  assert.ok(untouched.payload.content.includes('second'), 'dry run did not write');
  const applied = await call('edit_file', { path: 'fs/hello.txt', edits });
  assert.ok(applied.payload.written && applied.payload.diff.includes('+SECOND'));
  const afterEdit = await call('read_text_file', { path: 'fs/hello.txt' });
  assert.ok(afterEdit.payload.content.includes('SECOND'), 'edit applied');
  expectCode(
    await call('edit_file', { path: 'fs/hello.txt', edits: [{ oldText: 'nope-nope', newText: 'x' }] }),
    'NOT_FOUND',
  );

  // create dir -> search -> tree -> move
  await call('create_directory', { path: 'fs/sub' });
  await call('write_file', { path: 'fs/sub/findme.js', content: 'x\n' });
  const found = await call('search_files', { path: 'fs', pattern: '*.js' });
  assert.ok(found.payload.matches.some((m) => m.endsWith('findme.js')), 'glob search finds the file');
  const tree = await call('directory_tree', { path: 'fs' });
  const sub = tree.payload.tree.find((n) => n.name === 'sub');
  assert.equal(sub?.type, 'directory');
  assert.ok(sub.children.some((c) => c.name === 'findme.js'), 'tree contains the child');
  const mv = await call('move_file', {
    source: 'fs/sub/findme.js',
    // unique per run: a leftover from a previous run would make the target exist
    destination: `fs/sub/moved-${Date.now()}.js`,
  });
  assert.ok(mv.payload.moved, 'move_file works');
  expectCode(
    await call('move_file', { source: 'fs/sub/moved.js', destination: 'fs/hello.txt' }),
    'ALREADY_EXISTS',
  );

  // read_media_file (an .svg is text media -> base64 round-trip)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>';
  await call('write_file', { path: 'fs/img.svg', content: svg, overwrite: true });
  const media = await call('read_media_file', { path: 'fs/img.svg' });
  assert.equal(media.payload.mime_type, 'image/svg+xml');
  assert.equal(Buffer.from(media.payload.data, 'base64').toString('utf8'), svg, 'base64 round-trip');

  // access control: outside every allowed directory is refused
  expectCode(await call('read_text_file', { path: 'C:/Windows/win.ini' }), 'PATH_ESCAPE');
  expectCode(await call('read_text_file', { path: '../../../escape.txt' }), 'PATH_ESCAPE');
  expectCode(await call('write_file', { path: '../../escape.txt', content: 'x' }), 'PATH_ESCAPE');
  console.log('  PASS  filesystem tools + access control');
}

await client.close();
console.log('\nsmoke test finished');
