# script-sandbox

MCP server (stdio) for running **any script** (PowerShell, bash, Python, Node.js,
Ruby, Perl, Lua, PHP, R, batch, VBScript) and **any executable** inside a
lightweight sandbox — without polluting your main working directory.

The engine is registry-driven: the interpreter is chosen automatically from the
file extension, so adding a language means adding a registry entry, not new
engine code. Interpreters are resolved from your machine's `PATH` at startup.

## Quick start

Install from npm:

```bash
npm install script-sandbox          # inside a project
npm install -g script-sandbox       # or globally on the machine
```

Then point any MCP client that speaks stdio at it:

```json
{
  "mcpServers": {
    "script-sandbox": {
      "command": "node",
      "args": ["./node_modules/script-sandbox/src/server.js"],
      "env": { "SCRIPT_SANDBOX_ROOT": "/tmp/opencode/script-sandbox" }
    }
  }
}
```

Other ways to reference the server after installing:

```json
{ "command": "npx", "args": ["-y", "script-sandbox"] }
{ "command": "script-sandbox", "args": [] }          // after global install
```

> **Windows note:** some MCP clients spawn commands without a shell, so the
> `npx`/`.cmd` shim often fails there. The most portable form — used by the
> bundled installers below — is the absolute path to `node` plus
> `node_modules/script-sandbox/src/server.js`.

`env` is optional; the sandbox root defaults to `os.tmpdir()/opencode/script-sandbox`.

## Automatic setup for MCP clients

Two bundled installers write the client config for you (they resolve every path
from the device environment — nothing is hard-coded):

```bash
# OpenCode: install to a per-user folder + write opencode.json
npm run setup:npm
npm run setup:npm -- --enable      # also switch the server on

# Any other client (Claude Desktop/Code, Cline, Roo Code, VS Code,
# GitHub Copilot, Gemini CLI, Cursor, Windsurf):
npm run setup:clients -- --list          # detect installed clients + config paths
npm run setup:clients --                 # write to every detected client
npm run setup:clients -- --print gemini  # ready-to-paste block, no writes
```

Without a project folder (package straight from the registry):

```bash
npm install script-sandbox --no-save
node node_modules/script-sandbox/scripts/setup-npm.js --from-registry --enable
```

Safety rules of the installers: JSON files with comments (JSONC) are never
modified (a paste-ready block is printed instead), existing configs are backed
up once (`*.bak.mcp` / `*.bak.npm`), re-runs are idempotent, and extra fields
you added yourself (e.g. `disabled`, `autoApprove`) are preserved on update.

## Tools

| Tool | Function |
|---|---|
| `sandbox_info` | Languages + interpreters available on this machine (with versions), limits, guardrails |
| `list_scripts` | List script files in the sandbox `scripts/` folder |
| `write_script` | Create/overwrite a script (extension = language) |
| `read_script` | Read a script |
| `delete_script` | Delete a script |
| `run_script` | Run a script: per-run working dir, minimal env, timeout, logs |
| `run_code` | Run inline code (pick `language`); the temp file is removed afterwards |
| `run_executable` | Run any executable (name on `PATH` or absolute path) |
| `read_log` | Read the full stdout/stderr log of a run |

## Supported languages

Extension → interpreter (resolved from the machine's `PATH` at startup):

| Extension | Language | Notes |
|---|---|---|
| `.ps1` | PowerShell | `powershell.exe`, then `pwsh` |
| `.sh` `.bash` | bash | Git Bash is preferred on Windows (not the WSL-launcher `bash` from WindowsApps) |
| `.py` | Python | `python3`, then `python` |
| `.js` `.mjs` `.cjs` | Node.js | |
| `.rb` | Ruby | |
| `.pl` | Perl | |
| `.lua` | Lua | `lua`, `lua54`, `luajit` |
| `.php` | PHP | |
| `.r` | R | `Rscript` |
| `.bat` `.cmd` | CMD batch | Windows |
| `.vbs` | VBScript | `cscript //B //Nologo` |

Interpreter not installed? The run is rejected with code `INCOMPATIBLE` plus
the candidate names that were searched — or point to one manually:
`SCRIPT_SANDBOX_SHELL_PYTHON=D:/Python/python.exe`.
Call `sandbox_info` to see what is available on the current machine.

## Isolation: what is and is not guaranteed

**Provided (lightweight sandbox):**

- Per-run working directory inside the sandbox — scripts cannot litter other folders
- Child process env limited to an allowlist; `TEMP`/`TMP` redirected into the sandbox
- Timeout + full process-tree kill; capped output; per-run logs
- Script paths must be relative (anti path-traversal / symlink escape)
- Per-language guardrails against destructive patterns (`Format-Volume`,
  `rm -rf /`, `mkfs`, `shutil.rmtree('/')`, ...). Disable globally with
  `SCRIPT_SANDBOX_DENY=0` or per language with `SCRIPT_SANDBOX_DENY_OFF=sh,python`

**Not guaranteed — this is not a security boundary:**

- Native processes (especially via `run_executable`) can access the
  filesystem/network with the full rights of the user running node.
  For untrusted code, add an OS-level sandbox: a container (Docker/Podman), a
  VM, or AppContainer/WDAC.

## Configuration (env `SCRIPT_SANDBOX_*`)

| Env | Default | Function |
|---|---|---|
| `SCRIPT_SANDBOX_ROOT` | `os.tmpdir()/opencode/script-sandbox` | Sandbox root folder |
| `SCRIPT_SANDBOX_DEFAULT_TIMEOUT_MS` | `120000` | Default run timeout |
| `SCRIPT_SANDBOX_MAX_TIMEOUT_MS` | `600000` | Timeout ceiling |
| `SCRIPT_SANDBOX_MAX_OUTPUT_BYTES` | `200000` | Output returned to the caller (full log always on disk) |
| `SCRIPT_SANDBOX_MAX_CONCURRENT` | `2` | Max parallel runs |
| `SCRIPT_SANDBOX_KEEP_RUNS` | `50` | Number of runs kept on disk |
| `SCRIPT_SANDBOX_MAX_SCRIPT_BYTES` | `1000000` | Max script size |
| `SCRIPT_SANDBOX_EXTENSIONS` | (all) | Restrict allowed extensions |
| `SCRIPT_SANDBOX_DENY` | `1` | Guardrails on/off |
| `SCRIPT_SANDBOX_DENY_OFF` | (empty) | Disable guardrails per language kind: `sh,python` |
| `SCRIPT_SANDBOX_SHELL_<KIND>` | (auto) | Pin an interpreter: `SCRIPT_SANDBOX_SHELL_NODE=D:/node/node.exe` |

## Usage flow

```
1. Write a script : write_script { name: "build/check.py", content: "..." }
2. Run it         : run_script   { script: "build/check.py", timeout_ms: 60000 }
3. Read the result: exit_code / stdout / stderr are in the run result
4. Full log (opt.) : read_log { run_id: "...", which: "stderr" }

One-shot code : run_code   { code: "print(6*7)", language: "py" }
A binary/CLI  : run_executable { executable: "git", args: ["--version"] }
```

## Project layout

- `src/server.js` — MCP stdio server, 9 tools
- `src/config.js` — interpreter registry + guardrails + limits (all overridable via `SCRIPT_SANDBOX_*` env)
- `src/sandbox.js` — execution engine (per-run cwd, env allowlist, timeout, logs)
- `scripts/` — npm installer + multi-client registrar
- `test/` — smoke test, config-check, clients-check

## Testing

```bash
npm test    # smoke (MCP + every tool) + config-check + clients-check
```

The smoke test follows the interpreters available on the machine: languages
that are not installed are skipped automatically.

## Publishing

```bash
npm version patch
npm publish          # prepublishOnly runs the full test suite
```

Installing on another machine is just `npm install script-sandbox` (see Quick start).

## License

MIT
