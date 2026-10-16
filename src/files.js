/**
 * Filesystem tools — the Filesystem MCP server's functionality
 * (https://mcpservers.org/servers/modelcontextprotocol/filesystem), ported
 * into script-sandbox and restricted to the allowed directories:
 *
 *   1. the sandbox root (SCRIPT_SANDBOX_ROOT, default os.tmpdir()/opencode/script-sandbox)
 *   2. everything SCRIPT_SANDBOX_FS_ROOTS adds ("D:/data,/home/me/notes")
 *
 * Every path is checked lexically AND via realpath, so `..` traversal and
 * symlinks pointing out of an allowed directory are refused (PATH_ESCAPE).
 * Relative paths resolve against the first allowed directory.
 *
 * Tools: read_text_file, read_media_file, read_multiple_files, write_file,
 * edit_file, create_directory, list_directory, list_directory_with_sizes,
 * move_file, search_files, directory_tree, get_file_info,
 * list_allowed_directories.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';
import { SandboxError } from './sandbox.js';

/** Cross-platform absolute path detection (POSIX root, Windows drive, UNC). */
const ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

const MAX_MATCHES = 500; // search_files
const MAX_TREE_NODES = 20_000; // directory_tree
const MAX_BATCH = 50; // read_multiple_files / edit_file edits

/* -------------------------------------------------------------- path guard */

function assertNoNul(value, what = 'path') {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new SandboxError(`Invalid ${what}.`, 'INVALID_PATH');
  }
}

/** True when `target` is `base` itself or lives under it (no `..foo` false alarm). */
function isInside(base, target) {
  const rel = path.relative(base, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * Realpath of the deepest existing ancestor + the not-yet-existing suffix,
 * so a symlinked ancestor pointing out of an allowed directory is caught
 * even when the final target does not exist yet (write/create case).
 */
async function realpathOf(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return tail.length ? path.resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null; // walked past the filesystem root
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Realpaths of every allowed directory (falls back to the lexical path). */
async function allowedRoots() {
  const roots = [];
  for (const root of config.fsRoots) {
    roots.push((await realpathOf(root)) || path.resolve(root));
  }
  return roots;
}

/**
 * Resolve a caller path and require it to stay inside an allowed directory.
 * Absolute paths are used as-is; relative paths resolve against the sandbox
 * root (config.fsRoots[0]). Returns the lexical absolute path for the
 * operation — authorization was done on its realpath.
 */
async function resolveAllowed(target, label = 'path') {
  assertNoNul(target);
  const roots = await allowedRoots();
  if (roots.length === 0) {
    throw new SandboxError('Access denied — no allowed directories.', 'ACCESS_DENIED');
  }
  const absolute =
    path.isAbsolute(target) || ABSOLUTE_RE.test(target)
      ? path.resolve(target)
      : path.resolve(config.fsRoots[0], target);
  const real = (await realpathOf(absolute)) || absolute;
  if (!roots.some((root) => isInside(root, real))) {
    throw new SandboxError(
      `${label} is outside the allowed directories: ${target} ` +
        `(allowed: ${roots.join(', ')})`,
      'PATH_ESCAPE',
    );
  }
  return absolute;
}

async function statOf(target, label = 'path') {
  try {
    return await fsp.stat(target);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw new SandboxError(`${label} not found: ${target}`, 'NOT_FOUND');
    }
    throw new SandboxError(`Cannot read ${label}: ${err.message}`, 'IO_ERROR');
  }
}

async function requireDirectory(target) {
  const dir = await resolveAllowed(target);
  const stat = await statOf(dir, 'directory');
  if (!stat.isDirectory()) {
    throw new SandboxError(`Not a directory: ${target}`, 'NOT_A_DIRECTORY');
  }
  return dir;
}

/** Path relative to `base`, always with forward slashes (glob-friendly). */
function posixRel(base, target) {
  return path.relative(base, target).split(path.sep).join('/') || '.';
}

function displayPath(target) {
  return String(target).split(path.sep).join('/');
}

/* --------------------------------------------------------- glob + excludes */

function globToRegExp(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') {
          re += '(?:[^/]*\\/)*'; // '**/' crosses directories
          i += 1;
        } else {
          re += '.*'; // '**' matches everything
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += /[\\^$.|+(){}[\]]/.test(c) ? `\\${c}` : c;
    i += 1;
  }
  return new RegExp(`^${re}$`, config.isWindows ? 'i' : '');
}

/** Compile one user glob: no slash = matches names at any depth. */
function compileGlob(glob) {
  assertNoNul(glob, 'pattern');
  return { raw: glob, hasSlash: glob.includes('/'), re: globToRegExp(glob) };
}

function matchesGlob(glob, relPosix, name) {
  return glob.hasSlash ? glob.re.test(relPosix) : glob.re.test(name);
}

function isExcluded(excludes, relPosix, name) {
  for (const ex of excludes) {
    if (matchesGlob(ex, relPosix, name)) return true;
    // plain directory name ("node_modules") also excludes everything below it
    if (!ex.hasSlash && relPosix.startsWith(`${ex.raw}/`)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ readers */

export function listAllowedDirectories() {
  return { ok: true, directories: [...config.fsRoots] };
}

export async function readTextFile({ path: target, head, tail }) {
  if (head != null && tail != null) {
    throw new SandboxError('head and tail cannot be combined.', 'INVALID_INPUT');
  }
  if (head != null && (!Number.isInteger(head) || head < 1)) {
    throw new SandboxError('head must be a positive integer.', 'INVALID_INPUT');
  }
  if (tail != null && (!Number.isInteger(tail) || tail < 1)) {
    throw new SandboxError('tail must be a positive integer.', 'INVALID_INPUT');
  }
  const file = await resolveAllowed(target);
  const stat = await statOf(file, 'file');
  if (stat.isDirectory()) {
    throw new SandboxError(`Is a directory: ${target}`, 'IS_DIRECTORY');
  }
  const content = await fsp.readFile(file, 'utf8');
  const base = {
    ok: true,
    path: file,
    size_bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
  };
  if (head == null && tail == null) return { ...base, content };

  const lines = content.split('\n');
  const count = head ?? tail;
  const picked = head != null ? lines.slice(0, count) : lines.slice(-count);
  return {
    ...base,
    selection: head != null ? 'head' : 'tail',
    lines_total: lines.length,
    lines_returned: picked.length,
    truncated: picked.length < lines.length,
    content: picked.join('\n'),
  };
}

export async function readMultipleFiles({ paths }) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new SandboxError('paths must be a non-empty array.', 'INVALID_INPUT');
  }
  if (paths.length > MAX_BATCH) {
    throw new SandboxError(`At most ${MAX_BATCH} files per call.`, 'INVALID_INPUT');
  }
  const files = [];
  for (const raw of paths) {
    try {
      const one = await readTextFile({ path: raw });
      files.push({ path: raw, ok: true, size_bytes: one.size_bytes, content: one.content });
    } catch (err) {
      // one bad path never stops the batch (same contract as the source server)
      files.push({ path: raw, ok: false, error: err?.message || String(err), code: err?.code || 'INTERNAL_ERROR' });
    }
  }
  return { ok: true, files, failed: files.filter((f) => !f.ok).length };
}

/** Extension -> MIME for read_media_file (text media included, e.g. .svg/.pdf). */
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
};

export async function readMediaFile({ path: target }) {
  const file = await resolveAllowed(target);
  const stat = await statOf(file, 'file');
  if (stat.isDirectory()) {
    throw new SandboxError(`Is a directory: ${target}`, 'IS_DIRECTORY');
  }
  if (stat.size > config.fsMaxMediaBytes) {
    throw new SandboxError(
      `File is ${stat.size} bytes, over the ${config.fsMaxMediaBytes}-byte media limit ` +
        '(SCRIPT_SANDBOX_FS_MAX_MEDIA_BYTES).',
      'TOO_LARGE',
    );
  }
  const data = await fsp.readFile(file);
  return {
    ok: true,
    path: file,
    mime_type: MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    encoding: 'base64',
    size_bytes: stat.size,
    data: data.toString('base64'),
  };
}

/* ------------------------------------------------------------------ writers */

export async function writeFile({ path: target, content, overwrite = false }) {
  assertNoNul(content, 'content');
  const file = await resolveAllowed(target);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > config.fsMaxWriteBytes) {
    throw new SandboxError(
      `Content is ${bytes} bytes, over the ${config.fsMaxWriteBytes}-byte limit ` +
        '(SCRIPT_SANDBOX_FS_MAX_WRITE_BYTES).',
      'TOO_LARGE',
    );
  }
  let existed = false;
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) {
      throw new SandboxError(`Is a directory: ${target}`, 'IS_DIRECTORY');
    }
    existed = true;
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
      throw new SandboxError(`Cannot inspect target: ${err.message}`, 'IO_ERROR');
    }
  }
  if (existed && !overwrite) {
    throw new SandboxError(
      `File already exists: ${target}. Use overwrite=true to replace it.`,
      'ALREADY_EXISTS',
    );
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
  return { ok: true, path: file, created: !existed, overwritten: existed, size_bytes: bytes };
}

export async function createDirectory({ path: target }) {
  const dir = await resolveAllowed(target);
  let created = false;
  try {
    const stat = await fsp.lstat(dir);
    if (!stat.isDirectory()) {
      throw new SandboxError(`Already exists as a file: ${target}`, 'ALREADY_EXISTS');
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    created = true;
  }
  if (created) await fsp.mkdir(dir, { recursive: true });
  return { ok: true, path: dir, created };
}

export async function moveFile({ source, destination }) {
  const from = await resolveAllowed(source, 'source');
  const to = await resolveAllowed(destination, 'destination');
  const stat = await statOf(from, 'source');
  let exists = false;
  try {
    await fsp.lstat(to);
    exists = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (exists) {
    throw new SandboxError(`Destination already exists: ${destination}`, 'ALREADY_EXISTS');
  }
  if (stat.isDirectory() && isInside(from, to)) {
    throw new SandboxError('Cannot move a directory into itself.', 'INVALID_INPUT');
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err?.code !== 'EXDEV') {
      throw new SandboxError(`Move failed: ${err.message}`, 'IO_ERROR');
    }
    // different filesystems: copy then remove (rename cannot cross devices)
    await fsp.cp(from, to, { recursive: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
  return {
    ok: true,
    source: from,
    destination: to,
    moved: true,
    type: stat.isDirectory() ? 'directory' : 'file',
  };
}

/* ------------------------------------------------------- list / info / tree */

export async function listDirectory({ path: target }) {
  const dir = await requireDirectory(target);
  const entries = (await fsp.readdir(dir, { withFileTypes: true }))
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, path: dir, count: entries.length, entries };
}

export async function listDirectoryWithSizes({ path: target, sortBy = 'name' }) {
  if (!['name', 'size'].includes(sortBy)) {
    throw new SandboxError('sortBy must be "name" or "size".', 'INVALID_INPUT');
  }
  const dir = await requireDirectory(target);
  const names = await fsp.readdir(dir);
  const entries = await Promise.all(
    names.map(async (name) => {
      const full = path.join(dir, name);
      try {
        const stat = await fsp.lstat(full);
        return {
          name,
          type: stat.isDirectory() ? 'directory' : 'file',
          is_symlink: stat.isSymbolicLink(),
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
        };
      } catch {
        return { name, type: 'unknown', is_symlink: false, size_bytes: null, modified_at: null };
      }
    }),
  );
  entries.sort(
    sortBy === 'size'
      ? (a, b) => (b.size_bytes ?? -1) - (a.size_bytes ?? -1) || a.name.localeCompare(b.name)
      : (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const files = entries.filter((e) => e.type === 'file');
  return {
    ok: true,
    path: dir,
    sort_by: sortBy,
    entries,
    summary: {
      total_files: files.length,
      total_directories: entries.filter((e) => e.type === 'directory').length,
      total_size_bytes: files.reduce((sum, e) => sum + (e.size_bytes || 0), 0),
    },
  };
}

export async function getFileInfo({ path: target }) {
  const file = await resolveAllowed(target);
  const stat = await statOf(file);
  let link = null;
  try {
    link = await fsp.lstat(file);
  } catch {
    /* race: disappeared between stat and lstat */
  }
  const mode = stat.mode & 0o777;
  return {
    ok: true,
    path: file,
    type: stat.isDirectory() ? 'directory' : 'file',
    size_bytes: stat.size,
    created_at: stat.birthtime.toISOString(),
    modified_at: stat.mtime.toISOString(),
    accessed_at: stat.atime.toISOString(),
    is_symlink: Boolean(link?.isSymbolicLink()),
    permissions: {
      octal: mode.toString(8).padStart(3, '0'),
      rwx: Array.from({ length: 9 }, (_, i) => (mode >> (8 - i)) & 1 ? 'rwx'[i % 3] : '-').join(''),
    },
  };
}

export async function directoryTree({ path: target, excludePatterns = [] }) {
  const dir = await requireDirectory(target);
  const excludes = excludePatterns.map(compileGlob);
  let nodes = 0;

  const build = async (current) => {
    const children = [];
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return children; // unreadable folder -> leaf
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = posixRel(dir, full);
      if (isExcluded(excludes, rel, entry.name)) continue;
      if (++nodes > MAX_TREE_NODES) {
        throw new SandboxError(
          `directory_tree stopped: more than ${MAX_TREE_NODES} entries. Narrow the path or add excludePatterns.`,
          'TOO_LARGE',
        );
      }
      if (entry.isDirectory()) {
        children.push({ name: entry.name, type: 'directory', children: await build(full) });
      } else {
        children.push({ name: entry.name, type: 'file' }); // symlinks: not followed
      }
    }
    return children;
  };

  return { ok: true, path: dir, nodes, tree: await build(dir) };
}

/* ------------------------------------------------------------------ search */

export async function searchFiles({ path: target, pattern, excludePatterns = [] }) {
  const dir = await requireDirectory(target);
  const glob = compileGlob(pattern);
  const excludes = excludePatterns.map(compileGlob);
  const matches = [];
  let truncated = false;

  const walk = async (current) => {
    if (truncated) return;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        return;
      }
      const full = path.join(current, entry.name);
      const rel = posixRel(dir, full);
      if (isExcluded(excludes, rel, entry.name)) continue;
      if (matchesGlob(glob, rel, entry.name)) matches.push(full);
      if (entry.isDirectory()) await walk(full); // symlinks are never followed
    }
  };
  await walk(dir);

  matches.sort();
  return {
    ok: true,
    path: dir,
    pattern,
    count: matches.length,
    truncated,
    matches,
  };
}

/* -------------------------------------------------------------------- edit */

const normLine = (line) => line.trim().replace(/\s+/g, ' ');
const indentOf = (line) => (line.match(/^[ \t]*/) || [''])[0];

/**
 * Locate `oldText` in `content`:
 * 1. exact substring (unique — several matches are refused as ambiguous)
 * 2. line-based, whitespace-insensitive fallback (indentation of the replaced
 *    lines is carried over to the replacement, like the source server)
 * Returns { start, end, replacement } — `replacement` is the final text.
 */
function findEditMatch(content, oldText, newText, index) {
  const first = content.indexOf(oldText);
  if (first !== -1) {
    if (content.indexOf(oldText, first + oldText.length) !== -1) {
      const count = content.split(oldText).length - 1;
      throw new SandboxError(
        `Edit ${index}: the pattern occurs ${count} times — add surrounding context to make it unique.`,
        'AMBIGUOUS',
      );
    }
    return { start: first, end: first + oldText.length, replacement: newText, mode: 'exact' };
  }

  const lines = content.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const want = oldText.split('\n').map(normLine);
  const found = [];
  for (let s = 0; s + want.length <= lines.length; s++) {
    let hit = true;
    for (let j = 0; j < want.length; j++) {
      if (normLine(lines[s + j]) !== want[j]) {
        hit = false;
        break;
      }
    }
    if (hit) found.push(s);
    if (found.length > 1) break;
  }
  if (found.length === 0) {
    throw new SandboxError(
      `Edit ${index}: pattern not found (exact and whitespace-insensitive matching both failed).`,
      'NOT_FOUND',
    );
  }
  if (found.length > 1) {
    throw new SandboxError(
      `Edit ${index}: the pattern matches ${found.length} places — add surrounding context to make it unique.`,
      'AMBIGUOUS',
    );
  }

  const startLine = found[0];
  const endLine = startLine + want.length - 1;
  const start = offsets[startLine];
  const end = offsets[endLine] + lines[endLine].length;
  // only whitespace differs here -> each replacement line takes the
  // indentation of the line it replaces
  const replacement = newText
    .split('\n')
    .map((line, k) => {
      if (line.trim() === '') return '';
      const source = lines[startLine + Math.min(k, want.length - 1)];
      return indentOf(source) + line.replace(/^[ \t]+/, '');
    })
    .join('\n');
  return { start, end, replacement, mode: 'whitespace' };
}

export async function editFile({ path: target, edits, dryRun = false }) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new SandboxError('edits must be a non-empty array of { oldText, newText }.', 'INVALID_INPUT');
  }
  if (edits.length > MAX_BATCH) {
    throw new SandboxError(`At most ${MAX_BATCH} edits per call.`, 'INVALID_INPUT');
  }
  const file = await resolveAllowed(target);
  const stat = await statOf(file, 'file');
  if (stat.isDirectory()) {
    throw new SandboxError(`Is a directory: ${target}`, 'IS_DIRECTORY');
  }
  const original = await fsp.readFile(file, 'utf8');
  // work in LF, restore the original line endings afterwards
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let content = original.replace(/\r\n/g, '\n');

  const applied = [];
  for (const [index, edit] of edits.entries()) {
    if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
      throw new SandboxError(
        `Edit ${index}: oldText and newText are required strings.`,
        'INVALID_INPUT',
      );
    }
    if (edit.oldText === '') {
      throw new SandboxError(`Edit ${index}: oldText must not be empty.`, 'INVALID_INPUT');
    }
    const oldText = edit.oldText.replace(/\r\n/g, '\n');
    const newText = edit.newText.replace(/\r\n/g, '\n');
    const match = findEditMatch(content, oldText, newText, index);
    const line = content.slice(0, match.start).split('\n').length;
    content = content.slice(0, match.start) + match.replacement + content.slice(match.end);
    applied.push({ index, mode: match.mode, line });
  }

  const finalContent = eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
  const changed = finalContent !== original;
  const before = original.replace(/\r\n/g, '\n').split('\n');
  const after = content.split('\n');
  const written = changed && !dryRun;
  if (written) await fsp.writeFile(file, finalContent, 'utf8');

  return {
    ok: true,
    path: file,
    dry_run: Boolean(dryRun),
    edits_applied: applied.length,
    matches: applied,
    changed,
    written,
    lines_before: before.length,
    lines_after: after.length,
    diff: unifiedDiff(before, after, displayPath(file)) || '(no changes)',
  };
}

/* ---------------------------------------------------------- diff (unified) */

/**
 * Line diff as { t: 'eq' | 'del' | 'ins', l } ops (Myers O(ND)).
 * Falls back to a single prefix/suffix hunk for very large or very different
 * inputs, where the trace would cost too much memory.
 */
function diffOps(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  const fallback = () => prefixSuffixOps(oldLines, newLines);
  if (n === 0 && m === 0) return [];

  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace = [];
  const SNAPSHOT = () => (2 * max + 1) * 4; // bytes per trace entry
  let found = -1;

  for (let d = 0; d <= max; d++) {
    if (trace.length * SNAPSHOT() > 16 * 1024 * 1024) return fallback(); // memory budget
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found !== -1) break;
  }

  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const snap = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && snap[offset + k - 1] < snap[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = snap[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: 'eq', l: oldLines[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x > prevX) ops.push({ t: 'del', l: oldLines[prevX] });
      else ops.push({ t: 'ins', l: newLines[prevY] });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ t: 'eq', l: oldLines[x - 1] });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/** Degenerate diff: one hunk = everything between first and last change. */
function prefixSuffixOps(oldLines, newLines) {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const ops = oldLines.slice(0, start).map((l) => ({ t: 'eq', l }));
  ops.push(...oldLines.slice(start, endOld).map((l) => ({ t: 'del', l })));
  ops.push(...newLines.slice(start, endNew).map((l) => ({ t: 'ins', l })));
  ops.push(...oldLines.slice(endOld).map((l) => ({ t: 'eq', l })));
  return ops;
}

/** Git-style unified diff with 3 lines of context (empty string = no change). */
function unifiedDiff(oldLines, newLines, label, context = 3) {
  const ops = diffOps(oldLines, newLines);
  if (!ops.some((op) => op.t !== 'eq')) return '';

  const oldIdx = new Array(ops.length).fill(-1);
  const newIdx = new Array(ops.length).fill(-1);
  let oi = 0;
  let ni = 0;
  ops.forEach((op, i) => {
    if (op.t === 'eq') {
      oldIdx[i] = oi;
      newIdx[i] = ni;
      oi += 1;
      ni += 1;
    } else if (op.t === 'del') {
      oldIdx[i] = oi;
      oi += 1;
    } else {
      newIdx[i] = ni;
      ni += 1;
    }
  });

  const changes = ops.map((op, i) => (op.t === 'eq' ? -1 : i)).filter((i) => i !== -1);
  const groups = [];
  for (const i of changes) {
    const last = groups[groups.length - 1];
    if (last && i - last[1] <= context * 2 + 1) last[1] = i;
    else groups.push([i, i]);
  }

  const out = [`--- a/${label}`, `+++ b/${label}`];
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    let oldStart = -1;
    let newStart = -1;
    let oldCount = 0;
    let newCount = 0;
    for (let i = from; i <= to; i++) {
      if (oldIdx[i] !== -1) {
        if (oldStart === -1) oldStart = oldIdx[i];
        oldCount += 1;
      }
      if (newIdx[i] !== -1) {
        if (newStart === -1) newStart = newIdx[i];
        newCount += 1;
      }
    }
    if (oldCount === 0) {
      let prev = -1;
      for (let i = from - 1; i >= 0; i--) {
        if (oldIdx[i] !== -1) {
          prev = oldIdx[i];
          break;
        }
      }
      oldStart = prev + 1;
    }
    if (newCount === 0) {
      let prev = -1;
      for (let i = from - 1; i >= 0; i--) {
        if (newIdx[i] !== -1) {
          prev = newIdx[i];
          break;
        }
      }
      newStart = prev + 1;
    }
    out.push(`@@ -${oldStart + (oldCount ? 1 : 0)},${oldCount} +${newStart + (newCount ? 1 : 0)},${newCount} @@`);
    for (let i = from; i <= to; i++) {
      const op = ops[i];
      out.push(op.t === 'eq' ? ` ${op.l}` : op.t === 'del' ? `-${op.l}` : `+${op.l}`);
    }
  }
  return out.join('\n');
}
