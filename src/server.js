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
 * Plus filesystem tools (read/write/edit/list/search/tree/move) restricted to
 * the allowed directories: sandbox root + SCRIPT_SANDBOX_FS_ROOTS (see files.js).
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
  createDirectory,
  directoryTree,
  editFile,
  getFileInfo,
  listAllowedDirectories,
  listDirectory,
  listDirectoryWithSizes,
  moveFile,
  readMediaFile,
  readMultipleFiles,
  readTextFile,
  searchFiles,
  writeFile,
} from './files.js';
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
      'relative to the scripts/ folder inside the sandbox; paths outside the sandbox are rejected. ' +
      'Filesystem tools (read_text_file, write_file, edit_file, list_directory, search_files, directory_tree, ...) ' +
      'operate only inside the allowed directories — the sandbox root plus SCRIPT_SANDBOX_FS_ROOTS; ' +
      'call list_allowed_directories to see them.',
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

/**
 * MCP ToolAnnotations — the same hint semantics the official Filesystem server
 * sends, so clients (Cline, Roo, Copilot, Claude, ...) can auto-approve
 * read-only tools and warn before destructive ones. idempotent/destructive are
 * only meaningful for write tools (per spec), hence absent on read-only ones.
 * openWorldHint=false = stays inside the local filesystem/sandbox; the run_*
 * tools execute native code that CAN reach the network, so they are
 * open-world, never read-only, never idempotent.
 */
const TOOL_ANNOTATIONS = {
  // script tools
  sandbox_info: { readOnlyHint: true, openWorldHint: false },
  list_scripts: { readOnlyHint: true, openWorldHint: false },
  read_script: { readOnlyHint: true, openWorldHint: false },
  read_log: { readOnlyHint: true, openWorldHint: false },
  write_script: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  delete_script: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
  run_script: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  run_code: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  run_executable: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  // filesystem tools — mapping copied from the official server's docs
  list_allowed_directories: { readOnlyHint: true, openWorldHint: false },
  read_text_file: { readOnlyHint: true, openWorldHint: false },
  read_multiple_files: { readOnlyHint: true, openWorldHint: false },
  read_media_file: { readOnlyHint: true, openWorldHint: false },
  write_file: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  edit_file: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
  create_directory: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  move_file: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
  list_directory: { readOnlyHint: true, openWorldHint: false },
  list_directory_with_sizes: { readOnlyHint: true, openWorldHint: false },
  search_files: { readOnlyHint: true, openWorldHint: false },
  directory_tree: { readOnlyHint: true, openWorldHint: false },
  get_file_info: { readOnlyHint: true, openWorldHint: false },
};

/** registerTool + required annotations — a tool without an entry fails fast at startup. */
function register(name, config, handler) {
  const annotations = TOOL_ANNOTATIONS[name];
  if (!annotations) {
    throw new Error(`Missing TOOL_ANNOTATIONS entry for tool "${name}"`);
  }
  server.registerTool(name, { ...config, annotations }, handler);
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

register(
  'sandbox_info',
  {
    title: 'Sandbox info',
    description:
      'Sandbox information: the root/scripts/work/logs folders, languages + interpreters available ' +
      'on this device (with versions), limits, per-language guardrails, env allowlist, file count, ' +
      'and the file-log redirect (Spring Boot / Quarkus built in, any other stack via ' +
      'SCRIPT_SANDBOX_LOG_VARS; the files land in logs/<run_id>/ so running a project never drops .log files into its folder).',
    inputSchema: {},
  },
  wrap(async () => ok(await sandboxInfo())),
);

/* ------------------------------------------------------------ list_scripts */


register(
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


register(
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


register(
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


register(
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


register(
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


register(
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


register(
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


register(
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

/* ------------------------------------------------- filesystem tool schemas */

const fsPathSchema = z
  .string()
  .describe(
    'Absolute path inside an allowed directory, or a path relative to the sandbox root.',
  );

const excludePatternsSchema = z
  .array(z.string())
  .optional()
  .describe('Globs to skip, e.g. ["node_modules", "**/*.tmp"].');

/* ------------------------------------------------- filesystem: allowed dirs */


register(
  'list_allowed_directories',
  {
    title: 'List allowed directories',
    description:
      'Lists every directory the filesystem tools may read/write: the sandbox root ' +
      'plus anything in SCRIPT_SANDBOX_FS_ROOTS. Paths outside these are refused.',
    inputSchema: {},
  },
  wrap(async () => ok(listAllowedDirectories())),
);

/* ------------------------------------------------------- filesystem: read */


register(
  'read_text_file',
  {
    title: 'Read text file',
    description:
      'Reads a UTF-8 text file inside an allowed directory. Optionally return only the ' +
      'first (head) or last (tail) N lines — head and tail cannot be combined.',
    inputSchema: {
      path: fsPathSchema,
      head: z.number().int().positive().optional().describe('First N lines of the file.'),
      tail: z.number().int().positive().optional().describe('Last N lines of the file.'),
    },
  },
  wrap(async (args) => ok(await readTextFile(args))),
);


register(
  'read_multiple_files',
  {
    title: 'Read multiple files',
    description:
      'Reads several UTF-8 text files in one call. A failing path does not stop the batch: ' +
      'the failure is reported per file (ok=false + code).',
    inputSchema: {
      paths: z.array(z.string()).min(1).describe('Files to read (max 50).'),
    },
  },
  wrap(async (args) => ok(await readMultipleFiles(args))),
);


register(
  'read_media_file',
  {
    title: 'Read media file',
    description:
      'Reads an image/audio/video/PDF file and returns it base64-encoded with its MIME type. ' +
      'Size cap: SCRIPT_SANDBOX_FS_MAX_MEDIA_BYTES (default 5 MB).',
    inputSchema: {
      path: fsPathSchema,
    },
  },
  wrap(async (args) => ok(await readMediaFile(args))),
);

/* ---------------------------------------------------- filesystem: write */


register(
  'write_file',
  {
    title: 'Write file',
    description:
      'Creates a file (parents are created automatically) inside an allowed directory. ' +
      'An existing file is only replaced with overwrite=true. Size cap: ' +
      'SCRIPT_SANDBOX_FS_MAX_WRITE_BYTES (default 1 MB).',
    inputSchema: {
      path: fsPathSchema,
      content: z.string().describe('File content (UTF-8).'),
      overwrite: z.boolean().optional().describe('Set true to replace an existing file.'),
    },
  },
  wrap(async (args) => ok(await writeFile(args))),
);


register(
  'edit_file',
  {
    title: 'Edit file',
    description:
      'Makes selective edits with git-style diff output. Each edit replaces a unique oldText ' +
      'with newText (substring match; when only whitespace differs, indentation is carried ' +
      'over line by line). Ambiguous or missing patterns are refused with a clear code. ' +
      'Always dry_run=true first to preview the diff before applying.',
    inputSchema: {
      path: fsPathSchema,
      edits: z
        .array(
          z.object({
            oldText: z.string().describe('Text to find (must match exactly once).'),
            newText: z.string().describe('Replacement text.'),
          }),
        )
        .min(1)
        .describe('Edits applied in order (max 50).'),
      dryRun: z.boolean().optional().describe('Preview the diff without writing (default false).'),
    },
  },
  wrap(async (args) => ok(await editFile(args))),
);


register(
  'create_directory',
  {
    title: 'Create directory',
    description: 'Creates a directory (and its parents) inside an allowed directory.',
    inputSchema: {
      path: fsPathSchema,
    },
  },
  wrap(async (args) => ok(await createDirectory(args))),
);


register(
  'move_file',
  {
    title: 'Move file or directory',
    description:
      'Moves or renames a file/directory inside the allowed directories. Fails with ' +
      'ALREADY_EXISTS if the destination exists.',
    inputSchema: {
      source: fsPathSchema,
      destination: fsPathSchema,
    },
  },
  wrap(async (args) => ok(await moveFile(args))),
);

/* ------------------------------------------------- filesystem: list/search */


register(
  'list_directory',
  {
    title: 'List directory',
    description: 'Lists a directory: every entry with its type (file or directory).',
    inputSchema: {
      path: fsPathSchema,
    },
  },
  wrap(async (args) => ok(await listDirectory(args))),
);


register(
  'list_directory_with_sizes',
  {
    title: 'List directory with sizes',
    description:
      'Lists a directory with file sizes, modification times and a summary ' +
      '(total files/directories/bytes); entries sorted by name or size.',
    inputSchema: {
      path: fsPathSchema,
      sortBy: z.enum(['name', 'size']).optional().describe('Default: name.'),
    },
  },
  wrap(async (args) => ok(await listDirectoryWithSizes(args))),
);


register(
  'search_files',
  {
    title: 'Search files',
    description:
      'Recursively searches a directory for files/directories matching a glob pattern ' +
      '(e.g. "*.js", "src/**/*.ts"). A pattern without "/" matches names at any depth. ' +
      'Returns full paths, up to 500 matches.',
    inputSchema: {
      path: fsPathSchema,
      pattern: z.string().describe('Glob pattern, e.g. "*.py" or "src/**/*.ts".'),
      excludePatterns: excludePatternsSchema,
    },
  },
  wrap(async (args) => ok(await searchFiles(args))),
);


register(
  'directory_tree',
  {
    title: 'Directory tree',
    description:
      'Recursive JSON tree of a directory: name/type per entry, children for directories ' +
      '(empty array when empty). Symlinks are listed but never followed.',
    inputSchema: {
      path: fsPathSchema,
      excludePatterns: excludePatternsSchema,
    },
  },
  wrap(async (args) => ok(await directoryTree(args))),
);


register(
  'get_file_info',
  {
    title: 'Get file info',
    description:
      'File/directory metadata: size, created/modified/accessed times, type, permissions ' +
      '(octal + rwx) and whether it is a symlink.',
    inputSchema: {
      path: fsPathSchema,
    },
  },
  wrap(async (args) => ok(await getFileInfo(args))),
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
