---
description: Run embedded build and flash in subagent context
agent: embedded-buildflash
subtask: true
---

Run embedded build and flash for target: $ARGUMENTS.

Use project and skill context to select commands, then execute build and flash.
Return:

- status
- commands executed
- key failures or success markers
- next best action
