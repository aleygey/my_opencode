---
name: embedded-workflow
description: Embedded workflow orchestration for sdk discovery, build, flash, and serial debug with MCP tools.
---

# Embedded Workflow

Use this skill when the task is firmware development, board bring-up, or issue triage on embedded targets.

## Required Tooling

- Use `embedded_sdk` to inspect manifests and verify toolchain paths.
- Use `embedded_build` to list profiles and run compilation.
- Use `embedded_flash` to validate and run flashing.
- Use `embedded_debug` for serial lock/write/monitor operations.

## Execution Order

1. Call `embedded_sdk_sdk_inspect` with platform/product.
2. If paths are missing, call `embedded_sdk_sdk_discover` and produce a checklist.
3. Call `embedded_build_build_profiles` and pick a profile.
4. Call `embedded_build_build_run`.
5. Call `embedded_flash_flash_plan`, then `embedded_flash_flash_run`.
6. Call `embedded_debug_debug_claim_writer`, `embedded_debug_debug_write`, and `embedded_debug_debug_monitor`.
7. Call `embedded_debug_debug_release_writer`.

## Output Contract

Always return:

- selected platform/product/profile
- resolved sdk/toolchain paths
- build, flash and debug results
- unresolved gaps as an explicit checklist
