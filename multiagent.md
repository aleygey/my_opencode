# Workflow Design

This document describes the current multi-agent workflow implementation in this worktree.

## Goal

Provide a persistent workflow runtime where:

- the root `orchestrator` session plans and supervises
- each executable node runs in its own subagent session
- runtime state is durable and queryable
- workflow execution is visible in the Web UI

## Agents

- `orchestrator`
  - plans in the root session
  - waits for explicit user confirmation before creating a workflow
  - creates nodes, edges, and checkpoints
  - starts node sessions only when execution begins
  - supervises nodes through runtime reads and control commands
- `coding`
  - owns code implementation and narrow validation
  - reports progress with `workflow_update`
  - receives commands with `workflow_pull`
- `build-flash`
  - owns configure/build/package/flash work
  - treats full build or flash cycles as `attempt`
  - reports partial success when flash or validation is incomplete
- `debug`
  - owns reproduction, observation, and diagnosis
  - reports blockers and findings through runtime state

## Lifecycle

### 1. Planning

- The user talks only to the root `orchestrator` session.
- The orchestrator iterates on the plan.
- No workflow should be created during this phase.

### 2. Confirmation

- The user explicitly confirms execution.
- `workflow_create` is now allowed.
- This check is enforced in code, not only in the prompt.

### 3. Execution

- The orchestrator creates the workflow graph.
- Nodes may exist without child sessions during planning.
- When a node is ready to run, the orchestrator calls `workflow_node_start`.
- `workflow_node_start` creates the child session, binds it to the node, and hands off execution.

### 4. Supervision

- The root session does not execute node work after handoff.
- The orchestrator supervises by:
  - calling `workflow_read`
  - sending `workflow_control`
  - reacting to runtime wake events

### 5. Completion

- A completed workflow is folded in the UI into a compact plan/result card.
- Node sessions remain as history, but are hidden from the top strip by default once the workflow is finished.

## Runtime Model

The runtime is the source of truth.

### Core entities

- `workflow`
  - root workflow object bound to the orchestrator session
- `workflow_node`
  - one execution target per subagent task
- `workflow_edge`
  - dependency or control-flow relation
- `workflow_checkpoint`
  - gate after a node or milestone
- `workflow_event`
  - immutable event log and command bus

### Node fields

Every node keeps fixed control fields:

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

Semantic payload is kept in:

- `state_json`
- `result_json`

### Aggregated runtime state

Each workflow snapshot also exposes aggregated runtime data:

- `phase`
- `active_node_id`
- `waiting_node_ids`
- `failed_node_ids`
- `command_count`
- `update_count`
- `pull_count`
- `last_event_id`

## Runtime Tools

- `workflow_create`
- `workflow_node_create`
- `workflow_node_start`
- `workflow_edge_create`
- `workflow_checkpoint_create`
- `workflow_read`
- `workflow_control`
- `workflow_update`
- `workflow_pull`

## Execution Rules

### Confirmation gate

`workflow_create` is blocked until the latest real user message in the root session contains an explicit execute/confirm signal.

### Node ownership

Once a node is started:

- it must be operated from its bound child session
- `workflow_update` and `workflow_pull` reject calls from the wrong session
- the root session must supervise, not execute the node's work directly

## Communication Pattern

### Orchestrator to node

- uses `workflow_control`
- control messages are written into runtime events
- the node receives them through `workflow_pull`

### Node to runtime

- uses `workflow_update`
- only changed fields should be reported
- every meaningful node change creates runtime events

### Runtime to orchestrator

- uses event-driven wake-up
- if the root orchestrator session is idle, runtime sends a supervision prompt immediately
- if the root session is busy, runtime queues the wake request and flushes it when the root session becomes idle

## Wake Events

The runtime currently wakes the root orchestrator on these semantic events:

- `node.completed`
- `node.failed`
- `node.interrupted`
- `node.updated` with `status=waiting`
- `node.blocked`
- `node.action_limit_reached`
- `node.attempt_limit_reached`
- `checkpoint.pending`
- `checkpoint.failed`
- `node.stalled`

Supporting runtime events:

- `workflow.orchestrator_wake_requested`
- `workflow.orchestrator_wake_queued`
- `workflow.orchestrator_woken`

The wake queue is deduplicated per workflow, node, and reason over a short time window.

## Stall Detection

Runtime periodically checks nodes in `running` or `waiting`.

If a node has not produced fresh activity for long enough, runtime emits `node.stalled`, which can wake the root orchestrator for intervention.

## Web UI

The current Web UI is graph-first.

### Top strip

- root workflow card
- root orchestrator session card
- active node session cards

Completed workflows hide node session cards by default.

### Main canvas

- the workflow graph is the primary surface
- nodes show compact status cards
- active edges are blue
- inactive edges are gray
- running nodes are highlighted

### Right panel

- selected node details
- session binding
- command/pull/update visibility
- `state_json` and `result_json`

### Bottom panel

- recent runtime logs for the selected node

### Completed workflow folding

When the workflow reaches a terminal state:

- the graph is collapsed into a compact plan/result card
- the user can expand it again on demand

### Refresh behavior

The UI updates from:

- workflow event stream
- periodic `workflow_read` polling as a fallback

This prevents occasional graph staleness if an event push is missed.

## Current Limits

- The runtime is event-driven, but not a separate daemon scheduler.
- Wake-up is implemented by re-prompting the root orchestrator session.
- Node sessions are hidden after completion, but not physically deleted.
- Resource locking is not implemented yet.
- Tools sandbox and dynamic agent factory are intentionally deferred.

## Startup

### Normal development

Backend:

```bash
cd packages/opencode
bun run --conditions=browser ./src/index.ts serve --hostname 0.0.0.0 --port 4211
```

Frontend:

```bash
cd packages/app
VITE_OPENCODE_SERVER_HOST=127.0.0.1 \
VITE_OPENCODE_SERVER_PORT=4211 \
bun run dev -- --host 0.0.0.0 --port 4173
```

### Demo

```bash
./script/dev-workflow-demo.sh --no-open --keep
```
