#!/usr/bin/env node
/**
 * MCP server (stdio) — script-sandbox
 *
 * Runs ANY script (PowerShell, bash, Python, Node, Ruby, Perl,
 * Lua, PHP, R, Java, batch, VBScript) and any executable in a lightweight sandbox:
 * - dedicated working dir per run (inside the sandbox root)
 * - minimal env (allowlist) + TEMP/TMP redirected into the sandbox
 * - timeout + kill of the whole process tree
 * - stdout/stderr log + result.json per run, output truncated for the caller
 * - path guard (anti traversal/symlink escape) + per-language guardrails
 *
 * NOTE: this is lightweight isolation, not a security boundary. Native executables
 * in particular cannot be contained by a soft sandbox — never run anything untrusted
 * without an OS sandbox (container, VM, AppContainer/WDAC).
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
      'Use this tool to write and run scripts or executables without polluting ' +
      'the main working folder. Common flow: write_script -> run_script -> read stdout/stderr from the result; ' +
      'or run_code for short code snippets; or run_executable for binaries/CLI tools. ' +
      'The interpreter is chosen automatically from the file extension (.ps1, .sh, .py, .js, .rb, .pl, .lua, .php, ' +
      '.r, .java, .bat, .vbs — see sandbox_info for what is installed on this device). All script paths are ' +
      'relative to the scripts/ folder inside the sandbox; paths outside the sandbox are rejected.',
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
        console.error(`[script-sandbox] rejected (${err.code}): ${err.message}`);
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
  .describe(`Timeout in ms (default ${config.defaultTimeoutMs}, max ${config.maxTimeoutMs}).`);

const envSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe('Additional env vars for this run (max 20).');

const argsSchema = z
  .array(z.string())
  .optional()
  .describe('Extra arguments (an array so spaces are not split).');

/* ------------------------------------------------------------ sandbox_info */

server.registerTool(
  'sandbox_info',
  {
    title: 'Sandbox info',
    description:
      'Sandbox information: the root/scripts/work/logs folders, languages + interpreters available ' +
      'on this device (with versions), limits, per-language guardrails, env allowlist, and file count.',
    inputSchema: {},
  },
  wrap(async () => ok(await sandboxInfo())),
);

/* ------------------------------------------------------------ list_scripts */

server.registerTool(
  'list_scripts',
  {
    title: 'List scripts',
    description:
      'Lists every script file in the sandbox scripts/ folder (all supported languages), ' +
      'sorted newest first.',
    inputSchema: {},
  },
  wrap(async () => ok({ ok: true, scripts: await listScripts() })),
);

/* ------------------------------------------------------------ write_script */

server.registerTool(
  'write_script',
  {
    title: 'Write script',
    description:
      'Creates or overwrites a script file inside the sandbox scripts/ folder. Relative paths only ' +
      '(subfolders allowed). The extension selects the language: .ps1 PowerShell, .sh/.bash bash, ' +
      '.py Python, .js/.mjs/.cjs Node, .rb Ruby, .pl Perl, .lua Lua, .php PHP, .r R, ' +
      '.java Java, .bat/.cmd batch, .vbs VBScript. .sh/.bash is normalized to LF and reported via ' +
      'normalized_crlf. For .java: the public class name must match the file name ' +
      '(the usual Java rule); without the public modifier the file name is free.',
    inputSchema: {
      name: z.string().describe('Relative file name with its language extension, e.g. build/deploy.py'),
      content: z.string().describe('Script content (UTF-8) matching its extension language.'),
      overwrite: z.boolean().optional().describe('Set true to overwrite an existing file.'),
    },
  },
  wrap(async ({ name, content, overwrite }) =>
    ok({ ok: true, ...(await writeScript({ name, content, overwrite })) })),
);

/* ------------------------------------------------------------- read_script */

server.registerTool(
  'read_script',
  {
    title: 'Read script',
    description: 'Reads the contents of any script file from the sandbox scripts/ folder.',
    inputSchema: {
      name: z.string().describe('Relative file name, e.g. build/deploy.py'),
    },
  },
  wrap(async ({ name }) => ok({ ok: true, ...(await readScript(name)) })),
);

/* ----------------------------------------------------------- delete_script */

server.registerTool(
  'delete_script',
  {
    title: 'Delete script',
    description: 'Deletes a script file from the sandbox scripts/ folder.',
    inputSchema: {
      name: z.string().describe('Relative file name, e.g. build/deploy.py'),
    },
  },
  wrap(async ({ name }) => ok({ ok: true, ...(await deleteScript(name)) })),
);

/* -------------------------------------------------------------- run_script */

server.registerTool(
  'run_script',
  {
    title: 'Run script',
    description:
      'Runs a script file of any language in the sandbox: separate process, per-run working dir, ' +
      'minimal env, timeout, logs, and a result with exit_code/duration/stdout/stderr. The interpreter ' +
      'is chosen from the file extension (see sandbox_info). If the interpreter for that extension is not ' +
      'installed on this device, the run is rejected with code INCOMPATIBLE plus a fix suggestion.',
    inputSchema: {
      script: z.string().describe('Relative script path, e.g. build/deploy.py or check.ps1'),
      args: argsSchema,
      timeout_ms: timeoutSchema,
      env: envSchema,
      label: z.string().optional().describe('Free-form label for run bookkeeping.'),
    },
  },
  wrap(async (args) => ok(await runScript(args))),
);

/* ---------------------------------------------------------------- run_code */

server.registerTool(
  'run_code',
  {
    title: 'Run inline code',
    description:
      'Runs a code snippet of any language directly. The code is written to a temporary file in ' +
      'the sandbox (deleted automatically after the run) and executed with the same protections as ' +
      'run_script. For long or multi-file code, use write_script + run_script.',
    inputSchema: {
      code: z.string().describe('Code to execute.'),
      language: z
        .string()
        .describe(
          'Code language: one of the kind/extension — ps1, sh, py, js, rb, pl, lua, php, r, java, ' +
          'bat, vbs. Java note: the file name is generated automatically, so do not give the first ' +
          'class the public modifier (just `class Main { public static void main(String[] a) {...} }`).',
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
    title: 'Run executable',
    description:
      'Runs any executable (CLI tools, compiled binaries) in the same sandbox: ' +
      'per-run cwd, minimal env, timeout, logs. A bare name is looked up on PATH; an absolute path is ' +
      'used as-is. Args are scanned by the guardrails. WARNING: native binaries cannot be contained by ' +
      'this soft sandbox — only run what you trust.',
    inputSchema: {
      executable: z
        .string()
        .describe('Executable name on PATH (e.g. node, git) or an absolute path.'),
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
    title: 'Read run log',
    description:
      'Reads the full stdout/stderr log of a run (the output returned by run_script is already truncated).',
    inputSchema: {
      run_id: z.string().describe('run_id from a run result, e.g. 20260101-120000-a1b2c3'),
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
  // stderr only — stdout is used by the MCP protocol.
  console.error(`[script-sandbox] ready, root=${config.dirs.root}`);
}

main().catch((err) => {
  console.error('[script-sandbox] failed to start:', err);
  process.exit(1);
});
