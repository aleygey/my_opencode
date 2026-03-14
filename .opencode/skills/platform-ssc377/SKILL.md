---
name: platform-ssc377
description: Platform-specific workflow for ssc377 toolchain validation, compilation, flashing, and serial debug.
---

# SSC377 Platform Skill

Use this skill when the platform is `ssc377`.

## Baseline

- Platform manifest: `.opencode/embedded/manifest/platforms/ssc377.json`
- Required binaries: `arm-none-eabi-gcc`, `cmake`, `ninja`
- ser2net defaults: host `127.0.0.1`, rw `3333`, monitor `3334`

## Process

1. Validate with `embedded_sdk_sdk_inspect(platform="ssc377")`.
2. If missing toolchain or sdk path, run `embedded_sdk_sdk_discover(platform="ssc377")`.
3. Build through `embedded_build_build_run`.
4. Flash with `embedded_flash_flash_plan` then `embedded_flash_flash_run`.
5. Debug serial with `embedded_debug` lock/write/monitor flow.

## Safety

- Keep `FLASH_DRY_RUN=1` until user confirms actual board flashing.
- Do not write to serial endpoint without a lock.
