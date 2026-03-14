# Embedded Workflow Template

This template adds an embedded development workflow for OpenCode with:

- one read-only planning agent
- one primary orchestrator agent
- one build/flash subagent
- one serial-debug subagent
- one local plugin for env injection and structured logs
- command shortcuts that always run in subtask context

## What It Creates

- `.opencode/opencode.jsonc`
- `.opencode/package.json`
- `.opencode/plugins/embedded-workflow.ts`
- `.opencode/agents/embedded-plan.md`
- `.opencode/agents/embedded-orchestrator.md`
- `.opencode/agents/embedded-buildflash.md`
- `.opencode/agents/embedded-debug.md`
- `.opencode/commands/embedded-buildflash.md`
- `.opencode/commands/embedded-debug.md`
- `install.sh`
- `package.sh`

## Quick Deploy To Another PC

Create a portable archive from your current project's `.opencode` (recommended):

```bash
bash templates/embedded-workflow/package.sh --source /path/to/project/.opencode
```

Or package bundled template defaults:

```bash
bash templates/embedded-workflow/package.sh
```

Copy `templates/embedded-workflow/dist/embedded-workflow-<timestamp>.tar.gz`
to another PC, then run:

```bash
tar -xzf embedded-workflow-<timestamp>.tar.gz
bash embedded-workflow-<timestamp>/install.sh project /path/to/project --install-deps
```

For global install on target machine:

```bash
bash embedded-workflow-<timestamp>/install.sh global
```

## Install Into A Project

From your target project root:

```bash
bash /path/to/templates/embedded-workflow/install.sh project /path/to/project --install-deps
```

## Install Globally (for all projects)

```bash
bash /path/to/templates/embedded-workflow/install.sh global
```

## Dependency Behavior

- OpenCode auto-installs `.opencode/package.json` dependencies on startup when
  the target directory is writable.
- `--install-deps` runs `bun install` during deployment for a cleaner first run.

## Verify Dependency Auto-Load

After startup, verify these exist in the install target:

- `node_modules/`
- `bun.lock`

If not generated, check:

- target directory is writable
- OpenCode has network access to npm registry
- startup logs for install failures

## Usage

- switch to `embedded-plan` for strict planning mode
- switch to `embedded-orchestrator` for implementation
- run `/embedded-buildflash <args>` for compile/flash loops
- run `/embedded-debug <args>` for serial log triage

## MCP + Skills Permissions

- control per-agent access using frontmatter `permission`
- allow only selected subagents via `permission.task`
- set tool patterns for MCP tools (for example `embedded-build_*`)
- keep `skill` permission enabled only where needed
