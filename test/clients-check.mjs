/**
 * Test setup-clients.js against dummy config files in a temp folder.
 *
 * What is tested:
 *   - entry shape per client (standard / vscode / opencode)
 *   - merge: user fields (autoApprove, disabled, ...) preserved
 *   - idempotent: second run writes nothing
 *   - JSONC rejected, original file untouched, manual block printed
 *   - dry-run writes nothing; bad arguments -> exit 1
 *
 * Run: node test/clients-check.mjs  (part of `npm test`)
 * Does not touch the device's real configs: everything uses --file to a tmp folder.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const script = path.join(ROOT, 'scripts', 'setup-clients.js');
const NODE = String(process.execPath).replace(/\\/g, '/');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-mcp-clients-'));

function run(...args) {
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true,
  });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

/** Extract the first JSON block from output (used by --print mode). */
function firstJson(out) {
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
}

try {
  // 1) --help mentions all clients; --list exits 0
  {
    const help = run('--help');
    assert.equal(help.code, 0, 'help exit 0');
    for (const id of ['opencode', 'claude-desktop', 'claude-code', 'cline', 'vscode', 'vscode-workspace', 'gemini', 'cursor', 'windsurf']) {
      assert.ok(help.out.includes(id), `help mentions ${id}`);
    }
    assert.equal(run('--list').code, 0, 'list exit 0');
  }

  // 2) --print: standard entry shape (gemini) and vscode (type stdio)
  {
    const gem = firstJson(run('--print', 'gemini').out);
    const g = gem.mcpServers['script-sandbox'];
    assert.equal(g.command, NODE, 'gemini: command = node');
    assert.ok(g.args[0].endsWith('src/server.js'), 'gemini: args point to server.js');
    assert.equal(typeof g.env.SCRIPT_SANDBOX_ROOT, 'string', 'gemini: env present');

    const vs = firstJson(run('--print', 'vscode').out);
    const v = vs.mcp.servers['script-sandbox'];
    assert.equal(v.type, 'stdio', 'vscode: requires type stdio');
    assert.equal(v.command, NODE);

    const oc = firstJson(run('--print', 'opencode').out);
    const o = oc.mcp.servers['script-sandbox'];
    assert.equal(o.type, 'local', 'opencode: type local');
    assert.ok(Array.isArray(o.command) && o.command.length === 2, 'opencode: command array');
    assert.equal(typeof o.environment.SCRIPT_SANDBOX_ROOT, 'string', 'opencode: environment (not env)');
    assert.deepEqual(o.timeout, { startup: 60000 }, 'opencode: timeout startup');
  }

  // 3) write to dummy file: old content preserved, entry added, backup created
  {
    const file = path.join(tmp, 'claude_desktop_config.json');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2)}\n`,
    );

    const first = run('--clients', 'claude-desktop', '--file', file);
    assert.equal(first.code, 0, 'write exit 0');
    assert.ok(first.out.includes('added'), 'first run: added');

    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(cfg.mcpServers.other.command, 'x', 'old content not lost');
    assert.equal(cfg.mcpServers['script-sandbox'].command, NODE);
    assert.ok(fs.existsSync(`${file}.bak.mcp`), 'backup .bak.mcp created');

    // 4) idempotent: second run writes nothing
    const second = run('--clients', 'claude-desktop', '--file', file);
    assert.ok(second.out.includes('already identical'), 'second run: already identical');
    assert.ok(/0 changed/.test(second.out), 'second run: 0 changed');

    // 5) merge: user fields preserved when the server is updated
    cfg.mcpServers['script-sandbox'].autoApprove = ['run_script'];
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
    run('--clients', 'claude-desktop', '--file', file, '--server', path.join(ROOT, 'src', 'server.js'));
    const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(
      merged.mcpServers['script-sandbox'].autoApprove,
      ['run_script'],
      'user field (autoApprove) preserved',
    );
  }

  // 6) JSONC: untouched, manual block printed
  {
    const file = path.join(tmp, 'cline_mcp_settings.json');
    fs.writeFileSync(file, '{\n  // user comment\n  "mcpServers": {}\n}\n');
    const res = run('--clients', 'cline', '--file', file);
    assert.equal(res.code, 0, 'JSONC: exit 0 (not an error)');
    assert.ok(res.out.includes('paste manually'), 'JSONC: status skipped');
    assert.ok(fs.readFileSync(file, 'utf8').includes('// user comment'), 'original file unchanged');
    assert.ok(!fs.existsSync(`${file}.bak.mcp`), 'no backup for an untouched file');
    const block = firstJson(res.out);
    assert.ok(block.mcpServers['script-sandbox'].command, 'manual block printed');
  }

  // 7) dry-run writes nothing; --sandbox-root overrides env; --file may target
  //    a folder that does not exist yet (created automatically)
  {
    const file = path.join(tmp, 'gemini-settings.json');
    const dry = run('--clients', 'gemini', '--file', file, '--dry-run', '--sandbox-root', 'D:/example/sandbox');
    assert.ok(dry.out.includes('will be created'), 'dry-run: would be created');
    assert.ok(!fs.existsSync(file), 'dry-run does not write the file');

    const real = run('--clients', 'gemini', '--file', file, '--sandbox-root', 'D:/example/sandbox');
    assert.equal(real.code, 0);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(
      cfg.mcpServers['script-sandbox'].env.SCRIPT_SANDBOX_ROOT,
      'D:/example/sandbox',
      'sandbox-root override applied',
    );

    // --file under a missing parent: folder created, file still written
    const nested = path.join(tmp, 'does-not-exist', 'gemini', 'settings.json');
    const res = run('--clients', 'gemini', '--file', nested);
    assert.ok(res.out.includes('created'), 'parent folder that does not exist yet is still created');
    assert.ok(fs.existsSync(nested), 'nested file created');
  }

  // 8) bad arguments -> exit 1
  {
    assert.equal(run('--clients', 'nonexistent').code, 1, 'unknown client: exit 1');
    const file = path.join(tmp, 'a.json');
    assert.equal(
      run('--clients', 'gemini,cline', '--file', file).code,
      1,
      '--file + multiple clients: exit 1',
    );
  }

  console.log('clients-check: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
