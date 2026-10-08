#!/usr/bin/env node
/**
 * MCP server (stdio) — script-sandbox
 *
 * Menjalankan script APA SAJA (PowerShell, bash, Python, Node, Ruby, Perl,
 * Lua, PHP, R, batch, VBScript) dan executable apa pun di sandbox ringan:
 * - working dir khusus per run (di dalam sandbox root)
 * - env minimal (allowlist) + TEMP/TMP diarahkan ke dalam sandbox
 * - timeout + kill seluruh pohon proses
 * - log stdout/stderr + result.json per run, output dipotong untuk pemanggil
 * - penjaga path (anti traversal/symlink escape) + guardrails per bahasa
 *
 * CATATAN: ini isolasi ringan, bukan security boundary. Executable native
 * apalagi tidak bisa dibatasi oleh sandbox lembut — jangan jalankan yang tidak
 * dipercaya tanpa sandbox OS (container, VM, AppContainer/WDAC).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import config from './config.js';
import {
  SandboxError,
  deleteScript,
  ensureLayout,
  listScripts,
  readLog,
  readScript,
  runCode,
  runExecutable,
  runScript,
  sandboxInfo,
  writeScript,
} from './sandbox.js';

const PKG = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);

const server = new McpServer(
  { name: 'script-sandbox', version: PKG.version },
  {
    capabilities: { tools: {} },
    instructions:
      'Gunakan tool ini untuk menulis dan menjalankan script atau executable tanpa mencemari ' +
      'folder kerja utama. Alur umum: write_script -> run_script -> baca stdout/stderr dari hasil; ' +
      'atau run_code untuk potongan kode singkat; atau run_executable untuk biner/tool CLI. ' +
      'Interpreter dipilih otomatis dari ekstensi file (.ps1, .sh, .py, .js, .rb, .pl, .lua, .php, ' +
      '.r, .bat, .vbs — lihat sandbox_info untuk yang terpasang di device ini). Semua path script ' +
      'relatif terhadap folder scripts/ di dalam sandbox; path di luar sandbox ditolak.',
  },
);

function ok(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(err) {
  const payload =
    err instanceof SandboxError
      ? { ok: false, error: err.message, code: err.code }
      : { ok: false, error: err?.message || String(err), code: 'INTERNAL_ERROR' };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function wrap(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof SandboxError) {
        console.error(`[script-sandbox] ditolak (${err.code}): ${err.message}`);
      } else {
        console.error('[script-sandbox] error:', err?.stack || err);
      }
      return fail(err);
    }
  };
}

const timeoutSchema = z
  .number()
  .int()
  .positive()
  .max(config.maxTimeoutMs)
  .optional()
  .describe(`Timeout dalam ms (default ${config.defaultTimeoutMs}, maks ${config.maxTimeoutMs}).`);

const envSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe('Env var tambahan untuk run ini (maks 20).');

const argsSchema = z
  .array(z.string())
  .optional()
  .describe('Argumen tambahan (array supaya spasi tidak terpecah).');

/* ------------------------------------------------------------ sandbox_info */

server.registerTool(
  'sandbox_info',
  {
    title: 'Info sandbox',
    description:
      'Informasi sandbox: folder root/scripts/work/logs, bahasa + interpreter yang tersedia di ' +
      'device ini (dengan versinya), limit, guardrails per bahasa, env allowlist, dan jumlah file.',
    inputSchema: {},
  },
  wrap(async () => ok(await sandboxInfo())),
);

/* ------------------------------------------------------------ list_scripts */

server.registerTool(
  'list_scripts',
  {
    title: 'Daftar script',
    description:
      'Daftar semua file script yang ada di folder scripts/ sandbox (semua bahasa yang didukung), ' +
      'diurutkan dari yang terbaru.',
    inputSchema: {},
  },
  wrap(async () => ok({ ok: true, scripts: await listScripts() })),
);

/* ------------------------------------------------------------ write_script */

server.registerTool(
  'write_script',
  {
    title: 'Tulis script',
    description:
      'Membuat atau menimpa file script di dalam folder scripts/ sandbox. Path relatif saja ' +
      '(subfolder dibolehkan). Ekstensi menentukan bahasa: .ps1 PowerShell, .sh/.bash bash, ' +
      '.py Python, .js/.mjs/.cjs Node, .rb Ruby, .pl Perl, .lua Lua, .php PHP, .r R, ' +
      '.bat/.cmd batch, .vbs VBScript. .sh/.bash dinormalisasi ke LF dan dilaporkan lewat ' +
      'normalized_crlf.',
    inputSchema: {
      name: z.string().describe('Nama file relatif dengan ekstensi bahasanya, contoh: build/deploy.py'),
      content: z.string().describe('Isi script (UTF-8) sesuai bahasa ekstensinya.'),
      overwrite: z.boolean().optional().describe('Set true untuk menimpa file yang sudah ada.'),
    },
  },
  wrap(async ({ name, content, overwrite }) =>
    ok({ ok: true, ...(await writeScript({ name, content, overwrite })) })),
);

/* ------------------------------------------------------------- read_script */

server.registerTool(
  'read_script',
  {
    title: 'Baca script',
    description: 'Membaca isi file script apa pun dari folder scripts/ sandbox.',
    inputSchema: {
      name: z.string().describe('Nama file relatif, contoh: build/deploy.py'),
    },
  },
  wrap(async ({ name }) => ok({ ok: true, ...(await readScript(name)) })),
);

/* ----------------------------------------------------------- delete_script */

server.registerTool(
  'delete_script',
  {
    title: 'Hapus script',
    description: 'Menghapus file script dari folder scripts/ sandbox.',
    inputSchema: {
      name: z.string().describe('Nama file relatif, contoh: build/deploy.py'),
    },
  },
  wrap(async ({ name }) => ok({ ok: true, ...(await deleteScript(name)) })),
);

/* -------------------------------------------------------------- run_script */

server.registerTool(
  'run_script',
  {
    title: 'Jalankan script',
    description:
      'Menjalankan file script bahasa apa pun di sandbox: proses terpisah, working dir per-run, ' +
      'env minimal, timeout, log, dan hasil berisi exit_code/duration/stdout/stderr. Interpreter ' +
      'dipilih dari ekstensi file (lihat sandbox_info). Kalau interpreter untuk ekstensi itu tidak ' +
      'terpasang di device, run menolak dengan kode INCOMPATIBLE + saran perbaikannya.',
    inputSchema: {
      script: z.string().describe('Path relatif script, contoh: build/deploy.py atau check.ps1'),
      args: argsSchema,
      timeout_ms: timeoutSchema,
      env: envSchema,
      label: z.string().optional().describe('Label bebas untuk keperluan pencatatan run.'),
    },
  },
  wrap(async (args) => ok(await runScript(args))),
);

/* ---------------------------------------------------------------- run_code */

server.registerTool(
  'run_code',
  {
    title: 'Jalankan kode inline',
    description:
      'Menjalankan potongan kode bahasa apa pun langsung. Kode ditulis ke file sementara di ' +
      'sandbox (dihapus otomatis setelah run) lalu dieksekusi dengan proteksi yang sama seperti ' +
      'run_script. Untuk kode panjang atau multi-file, pakai write_script + run_script.',
    inputSchema: {
      code: z.string().describe('Kode yang akan dieksekusi.'),
      language: z
        .string()
        .describe(
          'Bahasa kode: salah satu kind/ekstensi — ps1, sh, py, js, rb, pl, lua, php, r, bat, vbs.',
        ),
      args: argsSchema,
      timeout_ms: timeoutSchema,
      env: envSchema,
      label: z.string().optional(),
    },
  },
  wrap(async (args) => ok(await runCode(args))),
);

/* --------------------------------------------------------- run_executable */

server.registerTool(
  'run_executable',
  {
    title: 'Jalankan executable',
    description:
      'Menjalankan executable apa pun (tool CLI, biner hasil kompilasi) di sandbox yang sama: ' +
      'cwd per-run, env minimal, timeout, log. Nama tanpa path dicari di PATH; path absolut dipakai ' +
      'apa adanya. Args di-scan guardrail. PERINGATAN: biner native tidak bisa dibatasi sandbox ' +
      'lembut ini — jalankan hanya yang kamu percaya.',
    inputSchema: {
      executable: z
        .string()
        .describe('Nama executable di PATH (contoh: node, git) atau path absolut.'),
      args: argsSchema,
      timeout_ms: timeoutSchema,
      env: envSchema,
      label: z.string().optional(),
    },
  },
  wrap(async (args) => ok(await runExecutable(args))),
);

/* ---------------------------------------------------------------- read_log */

server.registerTool(
  'read_log',
  {
    title: 'Baca log run',
    description:
      'Membaca log stdout/stderr lengkap dari sebuah run (output yang dikembalikan run_script sudah dipotong).',
    inputSchema: {
      run_id: z.string().describe('run_id dari hasil run, contoh: 20260101-120000-a1b2c3'),
      which: z.enum(['stdout', 'stderr']).optional().describe('Default: stdout'),
    },
  },
  wrap(async ({ run_id, which }) => ok({ ok: true, ...(await readLog(run_id, which || 'stdout')) })),
);

/* ------------------------------------------------------------------- start */

async function main() {
  await ensureLayout();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr saja — stdout dipakai protokol MCP.
  console.error(`[script-sandbox] siap, root=${config.dirs.root}`);
}

main().catch((err) => {
  console.error('[script-sandbox] gagal start:', err);
  process.exit(1);
});
