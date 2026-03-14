---
name: embedded-platform-onboard
description: Onboard new platform and product by autonomous SDK/source exploration and generate manifest checklists.
---

# Embedded Platform/Product Onboard

Use this skill when user provides a new `platform` and `product` that are not fully configured.

## Objective

Discover build and flash prerequisites from actual SDK and source tree, then persist them as manifests. Do not hardcode unknown paths in prompt text.

## Discovery Workflow

1. Gather inputs: platform, product, known sdk roots, target board/programmer.
2. Run `embedded_sdk_sdk_discover` with platform/product keywords and candidate roots.
3. Check toolchain binaries with `embedded_sdk_sdk_inspect`.
4. Search source tree for build and flash commands (`CMakeLists.txt`, `Makefile`, board scripts).
5. Build a checklist with:
   - sdk roots
   - source roots
   - toolchains
   - build profiles
   - flash command/script
   - serial/debug defaults
6. Save result through `embedded_sdk_sdk_record` as:
   - `.opencode/embedded/manifest/platforms/<platform>.json`
   - `.opencode/embedded/manifest/products/<product>.json`

## Deliverables

- A manifest-first configuration, not prompt-only assumptions.
- Explicit unknown items tagged as `TODO` fields in manifest.
- Suggested verification commands for build, flash, and serial monitor.
