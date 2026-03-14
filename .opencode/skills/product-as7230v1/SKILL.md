---
name: product-as7230v1
description: Product-specific workflow for as7230v1 on ssc377 with build profiles, flash script, and runtime checks.
---

# AS7230V1 Product Skill

Use this skill when product is `as7230v1`.

## Product Files

- Product manifest: `.opencode/embedded/manifest/products/as7230v1.json`
- Flash script: `.opencode/embedded/scripts/flash-as7230v1.sh`

## Build

- Default profile: `debug`
- Available profiles: `debug`, `release`
- Always call `embedded_build_build_profiles` before build execution.

## Flash

- Plan first with `embedded_flash_flash_plan(platform="ssc377", product="as7230v1")`.
- Use `embedded_flash_flash_run` after build artifact validation.

## Debug

- Acquire serial writer lock before issuing runtime commands.
- Prefer monitor endpoint for passive log capture.
