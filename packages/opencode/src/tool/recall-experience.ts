import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./recall-experience.txt"

/**
 * Tier C — agent-on-demand experience recall.
 *
 * Wraps `Retrieve.recall` and renders its structured output as a YAML-ish
 * block the agent can scan top-down. Lazy-imports the retrieve module
 * (same pattern the experimental routes use) so the tool registry doesn't
 * pull retrieve's heavy graph traversal eagerly at startup.
 */

const Parameters = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Free-text description of what you're trying to do or learn. Be specific — 'how to push to gerrit' is better than 'git stuff'.",
    ),
  max: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(5)
    .describe(
      "Maximum number of seed matches to return (preconditions are auto-added on top, not counted toward this cap).",
    ),
})

function renderEntry(p: {
  experience_id: string
  kind: string
  title: string
  abstract: string
  statement?: string
  trigger_condition?: string
  source: string
  reason?: string
}): string {
  const tag =
    p.source === "seed" || p.source === "heuristic"
      ? "match"
      : p.source === "expand:requires"
        ? "precondition"
        : p.source === "expand:refines"
          ? "refinement"
          : p.source

  const lines: string[] = []
  lines.push(`— [${tag}] ${p.title}`)
  lines.push(`  kind: ${p.kind}`)
  if (p.statement) lines.push(`  rule: ${p.statement}`)
  lines.push(`  detail: ${p.abstract}`)
  if (p.trigger_condition) lines.push(`  when: ${p.trigger_condition}`)
  if (p.reason) lines.push(`  relevance: ${p.reason}`)
  lines.push(`  id: ${p.experience_id}`)
  return lines.join("\n")
}

export const RecallExperienceTool = Tool.define(
  "recall_experience",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Lazy import — see retrieve module note about bun --compile loader.
          const { Retrieve } = yield* Effect.promise(() => import("../retrieve"))

          const result = yield* Effect.tryPromise({
            try: () =>
              Retrieve.recall({
                sessionID: ctx.sessionID,
                agentName: ctx.agent,
                query: params.query,
                max: params.max,
              }),
            catch: (e) => new Error(`recall_experience failed: ${String(e)}`),
          })

          if (result.experiences.length === 0) {
            return {
              title: `recall: no match for "${params.query.slice(0, 40)}"`,
              metadata: {
                query: params.query,
                matched: 0,
                preconditions: 0,
              },
              output:
                "<recall_experience>\n" +
                "No captured experience matches this query. Proceed using general best practices and consider whether this would be worth capturing as a future experience.\n" +
                "</recall_experience>",
            }
          }

          const body = [
            `<recall_experience query="${params.query.replace(/"/g, "'")}">`,
            `matched: ${result.matched_count}`,
            `preconditions_added: ${result.preconditions_added}`,
            "",
            ...result.experiences.map(renderEntry),
            "</recall_experience>",
          ].join("\n")

          return {
            title: `recall: ${result.matched_count} match(es), ${result.preconditions_added} precondition(s)`,
            metadata: {
              query: params.query,
              matched: result.matched_count,
              preconditions: result.preconditions_added,
              experience_ids: result.experiences.map((e) => e.experience_id),
            },
            output: body,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
