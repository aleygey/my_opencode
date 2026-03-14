# Embedded Bundle Deploy

This folder builds a standalone bundle for other PCs that only have OpenCode installed.

## Build package

```bash
bash .opencode/embedded/deploy/pack.sh
```

Output:

- `.opencode/embedded/dist/opencode-embedded-bundle-<timestamp>.tar.gz`

## Install on another PC

1. Copy the tarball to target PC
2. Extract and run installer

```bash
tar -xzf opencode-embedded-bundle-*.tar.gz
cd opencode-embedded-bundle-*
bash install.sh
```

Optional custom target path:

```bash
bash install.sh ~/.config/opencode
```

## What installer does

- Copies `mcp/`, `skills/`, `embedded/` into `~/.config/opencode`
- Installs MCP runtime deps via `bun add`
- Merges embedded MCP config into `opencode.json(c)` with backup

## Runtime requirements on target PC

- `bun`
- `python3`
- `ser2net`
- build/flash toolchain (`cmake`, `ninja`, `openocd`, compiler)
