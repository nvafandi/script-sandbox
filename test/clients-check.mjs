/**
 * Test setup-clients.js terhadap file config tiruan di folder sementara.
 *
 * Yang diuji:
 *   - bentuk entry tiap client (standard / vscode / opencode)
 *   - merge: field user (autoApprove, disabled, ...) dipertahankan
 *   - idempoten: run kedua tidak menulis apa pun
 *   - JSONC ditolak, file asli tidak disentuh, blok manual dicetak
 *   - dry-run tidak menulis; argumen rusak -> exit 1
 *
 * Jalankan: node test/clients-check.mjs  (ikut `npm test`)
 * Tidak menyentuh config asli device: semua lewat --file ke folder tmp.
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

/** Ambil blok JSON pertama dari output (dipakai mode --print). */
function firstJson(out) {
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
}

try {
  // 1) --help menyebut semua client; --list exit 0
  {
    const help = run('--help');
    assert.equal(help.code, 0, 'help exit 0');
    for (const id of ['opencode', 'claude-desktop', 'claude-code', 'cline', 'vscode', 'vscode-workspace', 'gemini', 'cursor', 'windsurf']) {
      assert.ok(help.out.includes(id), `help menyebut ${id}`);
    }
    assert.equal(run('--list').code, 0, 'list exit 0');
  }

  // 2) --print: bentuk entry standard (gemini) dan vscode (type stdio)
  {
    const gem = firstJson(run('--print', 'gemini').out);
    const g = gem.mcpServers['script-sandbox'];
    assert.equal(g.command, NODE, 'gemini: command = node');
    assert.ok(g.args[0].endsWith('src/server.js'), 'gemini: args menunjuk server.js');
    assert.equal(typeof g.env.SCRIPT_SANDBOX_ROOT, 'string', 'gemini: env ada');

    const vs = firstJson(run('--print', 'vscode').out);
    const v = vs.mcp.servers['script-sandbox'];
    assert.equal(v.type, 'stdio', 'vscode: butuh type stdio');
    assert.equal(v.command, NODE);

    const oc = firstJson(run('--print', 'opencode').out);
    const o = oc.mcp.servers['script-sandbox'];
    assert.equal(o.type, 'local', 'opencode: type local');
    assert.ok(Array.isArray(o.command) && o.command.length === 2, 'opencode: command array');
    assert.equal(typeof o.environment.SCRIPT_SANDBOX_ROOT, 'string', 'opencode: environment (bukan env)');
    assert.deepEqual(o.timeout, { startup: 60000 }, 'opencode: timeout startup');
  }

  // 3) tulis ke file tiruan: konten lama utuh, entry masuk, backup dibuat
  {
    const file = path.join(tmp, 'claude_desktop_config.json');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2)}\n`,
    );

    const first = run('--clients', 'claude-desktop', '--file', file);
    assert.equal(first.code, 0, 'tulis exit 0');
    assert.ok(first.out.includes('ditambahkan'), 'run pertama: ditambahkan');

    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(cfg.mcpServers.other.command, 'x', 'konten lama tidak hilang');
    assert.equal(cfg.mcpServers['script-sandbox'].command, NODE);
    assert.ok(fs.existsSync(`${file}.bak.mcp`), 'backup .bak.mcp dibuat');

    // 4) idempoten: run kedua tidak menulis
    const second = run('--clients', 'claude-desktop', '--file', file);
    assert.ok(second.out.includes('sudah sama'), 'run kedua: sudah sama');
    assert.ok(/0 berubah/.test(second.out), 'run kedua: 0 berubah');

    // 5) merge: field user dipertahankan saat server diperbarui
    cfg.mcpServers['script-sandbox'].autoApprove = ['run_script'];
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
    run('--clients', 'claude-desktop', '--file', file, '--server', path.join(ROOT, 'src', 'server.js'));
    const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(
      merged.mcpServers['script-sandbox'].autoApprove,
      ['run_script'],
      'field user (autoApprove) dipertahankan',
    );
  }

  // 6) JSONC: tidak disentuh, blok manual dicetak
  {
    const file = path.join(tmp, 'cline_mcp_settings.json');
    fs.writeFileSync(file, '{\n  // komentar user\n  "mcpServers": {}\n}\n');
    const res = run('--clients', 'cline', '--file', file);
    assert.equal(res.code, 0, 'JSONC: exit 0 (bukan error)');
    assert.ok(res.out.includes('tempel manual'), 'JSONC: status dilewati');
    assert.ok(fs.readFileSync(file, 'utf8').includes('// komentar user'), 'file asli tidak diubah');
    assert.ok(!fs.existsSync(`${file}.bak.mcp`), 'tanpa backup untuk file yang tidak disentuh');
    const block = firstJson(res.out);
    assert.ok(block.mcpServers['script-sandbox'].command, 'blok manual dicetak');
  }

  // 7) dry-run tidak menulis; --sandbox-root override env; --file boleh menembus
  //    folder yang belum ada (dibuat otomatis)
  {
    const file = path.join(tmp, 'gemini-settings.json');
    const dry = run('--clients', 'gemini', '--file', file, '--dry-run', '--sandbox-root', 'D:/contoh/sandbox');
    assert.ok(dry.out.includes('akan dibuat'), 'dry-run: akan dibuat');
    assert.ok(!fs.existsSync(file), 'dry-run tidak menulis file');

    const real = run('--clients', 'gemini', '--file', file, '--sandbox-root', 'D:/contoh/sandbox');
    assert.equal(real.code, 0);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(
      cfg.mcpServers['script-sandbox'].env.SCRIPT_SANDBOX_ROOT,
      'D:/contoh/sandbox',
      'sandbox-root override dipakai',
    );

    // --file ke parent yang belum ada: folder dibuat, file tetap terisi
    const nested = path.join(tmp, 'belum-ada', 'gemini', 'settings.json');
    const res = run('--clients', 'gemini', '--file', nested);
    assert.ok(res.out.includes('dibuat baru'), 'parent folder belum ada tetap dibuat');
    assert.ok(fs.existsSync(nested), 'file nested tercipta');
  }

  // 8) argumen rusak -> exit 1
  {
    assert.equal(run('--clients', 'tidak-ada').code, 1, 'client tak dikenal: exit 1');
    const file = path.join(tmp, 'a.json');
    assert.equal(
      run('--clients', 'gemini,cline', '--file', file).code,
      1,
      '--file + banyak client: exit 1',
    );
  }

  console.log('clients-check: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
