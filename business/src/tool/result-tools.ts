/**
 * Tools for progress, results and acceptance (M5 result layer).
 *
 * Eight tools. Note what is deliberately absent: there is no tool that completes a task.
 * Completion is a consequence of `result_review` with outcome `complete`, and giving it a
 * separate verb would let an agent complete a task without a reviewed submission (MVP-025).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Services } from './register.js'
import type { JsonObject } from './json.js'
import { runTool } from './result.js'
import type { ResultVersionRecord } from '../domain/result.js'

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
}

const ROLE_ENUM = [
  'pm',
  'product',
  'design',
  'scenemodel',
  'sceneart',
  'data',
  'frontend',
  'backend',
  'ue',
] as const

function resultToJson(r: ResultVersionRecord, services: Services): JsonObject {
  const review = services.results.reviewOf(r.resultId, r.version)
  const acceptances = services.results.acceptancesOf(r.resultId, r.version)
  return {
    result_id: r.resultId,
    version: r.version,
    task_id: r.taskId,
    // The task version in force when this was submitted, so "what was asked at the time"
    // stays answerable after a later revision.
    task_version: r.taskVersion,
    summary: r.summary,
    self_check: r.selfCheck,
    submitted_by: r.submittedBy,
    created_at: r.createdAt,
    files: r.files.map((f) => ({
      original_name: f.originalName,
      rel_path: f.relPath,
      sha256: f.sha256,
      size_bytes: f.sizeBytes,
    })),
    review:
      review === null
        ? null
        : {
            role: review.role,
            outcome: review.outcome,
            reason: review.reason,
            submitted_by: review.submittedBy,
            decided_at: review.decidedAt,
          },
    acceptances: acceptances.map((a) => ({
      task_id: a.taskId,
      outcome: a.outcome,
      reason: a.reason,
      decided_at: a.decidedAt,
    })),
  }
}

export function resultToolDefinitions(
  services: Services,
  declaredMemberOf: (exec: unknown) => string | null = () => null,
): readonly ToolDefinition[] {
  return [
    defineTool({
      name: 'progress_add',
      description:
        'Record a progress note on a task. Saving progress NEVER completes the task and ' +
        'advances nothing — it is a record of what is being done. The note is stamped with ' +
        'the task version in force, so progress written before and after a revision stay ' +
        'distinguishable. Call it as often as needed.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'The task id (stable across versions).' },
        note: { type: 'string', required: true, description: 'What has been done or is being done.' },
        submitted_by: {
          type: 'string',
          required: true,
          description: 'Who is recording this (a name, recorded as-is).',
        },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return runTool(() => {
          const e = services.results.addProgress({
            taskId: args.task_id,
            note: args.note,
            submittedBy: args.submitted_by,
          })
          return {
            id: e.id,
            task_id: e.taskId,
            task_version: e.taskVersion,
            note: e.note,
            submitted_by: e.submittedBy,
            created_at: e.createdAt,
            completed: false,
            note_that_progress_completes_nothing:
              'Saving progress never completes a task. Only a review can do that.',
          }
        })
      },
    }),

    defineTool({
      name: 'progress_list',
      description:
        'List every progress note on a task, oldest first, each showing the task version it ' +
        'was written against.',
      parameters: {
        task_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return runTool(() => {
          const list = services.results.progressOf(args.task_id)
          return {
            count: list.length,
            progress: list.map((p) => ({
              id: p.id,
              task_version: p.taskVersion,
              note: p.note,
              submitted_by: p.submittedBy,
              created_at: p.createdAt,
            })),
          }
        })
      },
    }),

    defineTool({
      name: 'result_submit',
      description:
        'Submit a result for a task: the explanation, the files and the self-check TOGETHER ' +
        'form one immutable result version. IMPORTANT: submitting does NOT complete the task ' +
        '— only the owning role\'s review can do that. Submitting again creates a new ' +
        'version; earlier versions are never changed or removed. The submission records the ' +
        'task version in force, which is what makes "what was asked at the time" answerable ' +
        'later.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'The task id (stable across versions).' },
        summary: { type: 'string', required: true, description: 'What is being handed in.' },
        self_check: {
          type: 'string',
          required: true,
          description: "The submitter's own check that it is complete.",
        },
        submitted_by: {
          type: 'string',
          required: true,
          description: 'Who is submitting (recorded as-is).',
        },
        files: {
          type: 'array',
          description: 'Files belonging to THIS version. Bytes live in the material store.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              rel_path: { type: 'string', required: true, description: 'Path relative to the file root.' },
              original_name: { type: 'string', required: true },
              sha256: { type: 'string', required: true },
              size_bytes: { type: 'number', required: true },
            },
          },
        },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return runTool(() => {
          const r = services.results.submit({
            taskId: args.task_id,
            summary: args.summary,
            selfCheck: args.self_check,
            submittedBy: args.submitted_by,
            files: (args.files ?? []).map((f) => ({
              relPath: f.rel_path,
              originalName: f.original_name,
              sha256: f.sha256,
              sizeBytes: f.size_bytes,
            })),
          })
          return {
            result_id: r.resultId,
            version: r.version,
            task_id: r.taskId,
            task_version: r.taskVersion,
            file_count: r.files.length,
            completed: false,
            note: 'Submitted, NOT completed. The owning role must review it.',
          }
        })
      },
    }),

    defineTool({
      name: 'result_list',
      description:
        "List a task's result versions, oldest first, with each one's review decision and " +
        'each downstream acceptance. Returned versions are still listed: a return keeps the ' +
        'submission, because it is the basis for the correction.',
      parameters: {
        task_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return runTool(() => {
          const list = services.results.resultsOf(args.task_id)
          return {
            count: list.length,
            results: list.map((r) => resultToJson(r, services)),
          }
        })
      },
    }),

    defineTool({
      name: 'result_review',
      description:
        'The owning ROLE reviews one result version. outcome="complete" records the task as ' +
        'completed — this is the ONLY way a task is completed. outcome="return" sends it ' +
        'back and REQUIRES a reason; a return records no completion and does not discard the ' +
        'submission. Reviewing is per role, and a result can be reviewed only once.',
      parameters: {
        result_id: { type: 'string', required: true },
        version: { type: 'number', required: true, description: 'Which result version to review.' },
        outcome: {
          type: 'string',
          required: true,
          enum: ['complete', 'return'],
          description: 'complete records the task done; return sends it back for correction.',
        },
        role: {
          type: 'string',
          required: true,
          enum: ROLE_ENUM,
          description: 'The reviewing role. Must be the role that owns the task.',
        },
        reason: { type: 'string', description: 'REQUIRED when outcome is "return".' },
        submitted_by: {
          type: 'string',
          required: true,
          description: 'Who is deciding (recorded as-is).',
        },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        return runTool(() => {
          services.results.review({
            resultId: args.result_id,
            version: args.version,
            outcome: args.outcome,
            role: args.role,
            reason: args.reason ?? null,
            submittedBy: args.submitted_by,
            // From the SESSION, never from args: the eligibility check must not be satisfiable by
            // the caller naming whoever happens to hold the role (ADR-0014).
            declaredMember: declaredMemberOf(exec),
          })
          return {
            result_id: args.result_id,
            version: args.version,
            outcome: args.outcome,
            task_completed: args.outcome === 'complete',
          }
        })
      },
    }),

    defineTool({
      name: 'result_acceptance_open',
      description:
        'Open acceptance slots for a result version. Only tasks that DECLARED this task as ' +
        'a required input get a slot — completion never stirs unrelated tasks. Accepting is ' +
        'never automatic: opening a slot leaves it undecided.',
      parameters: {
        result_id: { type: 'string', required: true },
        version: { type: 'number', required: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return runTool(() => {
          const ids = services.results.openAcceptances(args.result_id, args.version)
          return { ok: true, opened_for: [...ids], count: ids.length }
        })
      },
    }),

    defineTool({
      name: 'result_accept',
      description:
        'A downstream task decides on one specific result version. outcome="accept" or ' +
        '"reject"; rejecting REQUIRES a reason. Acceptance is an INDEPENDENT decision — an ' +
        'upstream completion does not accept on anyone\'s behalf. Rejecting records the ' +
        'reason and does NOTHING else: it creates no task, no plan and no issue, and it does ' +
        'not undo the upstream completion. If a correction is wanted, the upstream must go ' +
        'through the plan path itself.',
      parameters: {
        result_id: { type: 'string', required: true },
        version: { type: 'number', required: true },
        task_id: {
          type: 'string',
          required: true,
          description: 'The DOWNSTREAM task making the decision.',
        },
        outcome: {
          type: 'string',
          required: true,
          enum: ['accept', 'reject'],
          description: 'reject creates nothing and does not undo the upstream completion.',
        },
        reason: { type: 'string', description: 'REQUIRED when outcome is "reject".' },
        submitted_by: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        return runTool(() => {
          const a = services.results.decide({
            resultId: args.result_id,
            version: args.version,
            taskId: args.task_id,
            outcome: args.outcome,
            reason: args.reason ?? null,
            submittedBy: args.submitted_by,
            declaredMember: declaredMemberOf(exec),
          })
          return {
            task_id: a.taskId,
            outcome: a.outcome,
            reason: a.reason,
            decided_at: a.decidedAt,
          }
        })
      },
    }),

    defineTool({
      name: 'result_pending',
      description:
        'List what a task still has to decide: acceptance slots opened for it that are still ' +
        'undecided, and its own result versions still awaiting review.',
      parameters: {
        task_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return runTool(() => {
          const pendingAcceptances = services.results
            .acceptancesByTask(args.task_id)
            .filter((a) => a.outcome === null)
          const awaitingReview = services.results
            .resultsOf(args.task_id)
            .map((r) => ({ result: r, review: services.results.reviewOf(r.resultId, r.version) }))
            .filter((x) => x.review !== null && x.review.outcome === null)
          return {
            pending_acceptances: pendingAcceptances.map((a) => ({
              result_id: a.resultId,
              version: a.resultVersion,
            })),
            awaiting_review: awaitingReview.map((x) => ({
              result_id: x.result.resultId,
              version: x.result.version,
              summary: x.result.summary,
            })),
          }
        })
      },
    }),
  ]
}
