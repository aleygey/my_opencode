# Multi-Agent Workflow

This repository now includes a persistent workflow runtime for orchestrated multi-agent execution.

## Agents

- `orchestrator`
  - Creates workflows and nodes
  - Supervises runtime state
  - Reads incremental updates with `workflow_read`
  - Controls nodes with `workflow_control`
- `coding`
  - Implements code changes
  - Reports node progress with `workflow_update`
  - Pulls pending commands with `workflow_pull`
- `build-flash`
  - Builds artifacts
  - Flashes targets
  - Treats each full build/flash cycle as an attempt when needed
- `debug`
  - Reproduces issues
  - Collects evidence
  - Reports findings and blockers through the runtime

## Runtime Model

- `workflow`
  - Root runtime object bound to the orchestrator session
- `workflow_node`
  - One node per subagent task
  - Usually bound to a child session
- `workflow_edge`
  - Dependency or control-flow relation between nodes
- `workflow_checkpoint`
  - Gate after a node or milestone
- `workflow_event`
  - Immutable runtime log and command bus

## Node Fields

Each node keeps these core fields:

- `status`
- `result_status`
- `fail_reason`
- `action_count`
- `attempt`
- `max_attempts`
- `max_actions`
- `session_id`
- `agent`
- `model`
- `config`

Additional semantic payload can be stored in:

- `state_json`
- `result_json`

## Runtime Tools

- `workflow_create`
- `workflow_node_create`
- `workflow_edge_create`
- `workflow_checkpoint_create`
- `workflow_read`
- `workflow_control`
- `workflow_update`
- `workflow_pull`

## Communication Pattern

1. Orchestrator creates the workflow and node graph.
2. Each node gets a child session when needed.
3. Subagents report deltas through `workflow_update`.
4. Orchestrator reads deltas with `workflow_read`.
5. Runtime commands are delivered through `workflow_control`.
6. Subagents fetch commands and injected context through `workflow_pull`.

## Web UI

- Left column
  - Workflow/session cards at the top
  - Root session shows the workflow topology canvas
  - Node sessions keep their conversation view
- Middle column
  - Review and diff surface
  - Root workflow session shows aggregated workflow diffs
- Right column
  - Workspace and changed-file tree

## Notes

- The runtime is the source of truth.
- Agents should not treat compressed conversation context as authoritative runtime state.
- `tools sandbox` and `agent_factory` are intentionally deferred.
