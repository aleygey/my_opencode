/**
 * Per-experience usage statistics — tracks how often each experience is
 * INJECTED into an agent's context vs. actually USED by the agent.
 *
 * Two counter families:
 *
 *   injected
 *     One bump per (experience, retrieve event). Tier B injections happen
 *     on every user message, Tier A baseline bumps once per session-cache
 *     fill, Tier C bumps when the agent calls `recall_experience`.
 *     Sub-counts let the UI show "47 injected (32 baseline / 12 topical /
 *     3 recalled)" without re-aggregating from the audit log.
 *
 *   used
 *     - cited:    refiner's LLM-as-judge marked the agent's response as
 *                 having applied the experience. Strong signal.
 *     - recalled: agent voluntarily called `recall_experience` and got
 *                 this experience back. Strong signal — the agent itself
 *                 chose to consult it.
 *
 * Storage: a single JSON file at .opencode/refiner-memory/usage-stats.json.
 * Read-merge-write under bun's single-process model is fine; concurrent
 * writes are reduced by serialising bumps through a per-process queue.
 *
 * All callers are fire-and-forget — failures are logged at warn and
 * silently skipped so accounting glitches never block a user turn.
 */

import path from "path"
import { Instance } from "@/project/instance"
import { Filesystem, Log } from "@/util"

const log = Log.create({ service: "refiner.usage" })

export type InjectionTier = "baseline" | "topical" | "recall"
export type UsageKind = "cited" | "recalled"

export type ExperienceUsage = {
  injected: {
    total: number
    by_tier: Record<InjectionTier, number>
    last_at: number
  }
  used: {
    cited: number
    recalled: number
    last_at: number
  }
}

export type UsageStats = Record<string, ExperienceUsage>

const FILENAME = "usage-stats.json"

/**
 * One in-flight write per process. We don't lock the file (single-process
 * bun assumed) but we do queue bumps so fast successive calls aren't
 * racing read-then-write each other.
 */
let pending: Promise<void> = Promise.resolve()

function emptyEntry(): ExperienceUsage {
  return {
    injected: {
      total: 0,
      by_tier: { baseline: 0, topical: 0, recall: 0 },
      last_at: 0,
    },
    used: {
      cited: 0,
      recalled: 0,
      last_at: 0,
    },
  }
}

function statsPath() {
  return path.join(Instance.worktree, ".opencode", "refiner-memory", FILENAME)
}

async function readRaw(): Promise<UsageStats> {
  const fp = statsPath()
  const raw = await Filesystem.readText(fp).catch(() => "")
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Hydrate any missing fields (in case schema grew between runs)
      const out: UsageStats = {}
      for (const [id, val] of Object.entries(parsed)) {
        if (!val || typeof val !== "object") continue
        const v = val as Partial<ExperienceUsage>
        const blank = emptyEntry()
        out[id] = {
          injected: {
            total: v.injected?.total ?? 0,
            by_tier: {
              baseline: v.injected?.by_tier?.baseline ?? 0,
              topical: v.injected?.by_tier?.topical ?? 0,
              recall: v.injected?.by_tier?.recall ?? 0,
            },
            last_at: v.injected?.last_at ?? 0,
          },
          used: {
            cited: v.used?.cited ?? 0,
            recalled: v.used?.recalled ?? 0,
            last_at: v.used?.last_at ?? 0,
          },
        }
        // Normalise: if file was missing fields entirely, blank entry is OK.
        void blank
      }
      return out
    }
  } catch (error) {
    log.warn("usage-stats parse failed; resetting to empty", { error })
  }
  return {}
}

async function writeRaw(stats: UsageStats) {
  const fp = statsPath()
  await Filesystem.write(fp, JSON.stringify(stats, null, 2))
}

/**
 * Mutate the stats file, queued so successive calls don't lose updates.
 * The mutator may run async work but should be quick (just bumping
 * counters in-memory); the disk write happens here.
 */
function mutate(fn: (stats: UsageStats) => void): Promise<void> {
  pending = pending
    .then(async () => {
      try {
        const stats = await readRaw()
        fn(stats)
        await writeRaw(stats)
      } catch (error) {
        log.warn("usage-stats mutate failed", { error })
      }
    })
    .catch(() => undefined)
  return pending
}

/**
 * Bump injection counters for a list of experience ids. Pass the tier
 * (which Retrieve module is doing the injection — baseline / topical /
 * recall). Caller fires-and-forgets.
 */
export async function bumpInjection(expIds: string[], tier: InjectionTier) {
  if (expIds.length === 0) return
  const at = Date.now()
  await mutate((stats) => {
    for (const id of expIds) {
      const entry = stats[id] ?? emptyEntry()
      entry.injected.total += 1
      entry.injected.by_tier[tier] += 1
      entry.injected.last_at = at
      stats[id] = entry
    }
  })
}

/**
 * Bump the "recalled" counter — the agent invoked `recall_experience`
 * and the tool returned this experience. Voluntary consultation = use.
 */
export async function bumpUsageRecalled(expIds: string[]) {
  if (expIds.length === 0) return
  const at = Date.now()
  await mutate((stats) => {
    for (const id of expIds) {
      const entry = stats[id] ?? emptyEntry()
      entry.used.recalled += 1
      entry.used.last_at = at
      stats[id] = entry
    }
  })
}

/**
 * Bump the "cited" counter — refiner's usage judge concluded the agent
 * applied the experience in their last response.
 */
export async function bumpUsageCited(expIds: string[]) {
  if (expIds.length === 0) return
  const at = Date.now()
  await mutate((stats) => {
    for (const id of expIds) {
      const entry = stats[id] ?? emptyEntry()
      entry.used.cited += 1
      entry.used.last_at = at
      stats[id] = entry
    }
  })
}

/** Read the full stats file. Returns {} if the file is missing/corrupt. */
export async function readStats(): Promise<UsageStats> {
  return readRaw()
}

/** Get one experience's stats, with default-zero entry for missing ids. */
export async function readStatsFor(expId: string): Promise<ExperienceUsage> {
  const all = await readRaw()
  return all[expId] ?? emptyEntry()
}
