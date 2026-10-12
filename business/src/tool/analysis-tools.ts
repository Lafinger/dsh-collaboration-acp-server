/**
 * Analysis tools (M3).
 *
 * The two-step shape is deliberate and mirrors ADR-0006:
 *
 *   analysis_begin  — you declare a scope; the SERVER reads it and hands you the content.
 *   analysis_submit — you return the three content kinds, each requirement citing a source.
 *
 * The model never fetches material content itself. That is what makes "only read the scope"
 * a property of the system rather than a promise from the model.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonObject } from './json.js'
import { runTool } from './result.js'
import { DEFAULT_CONTENT_LIMIT_BYTES } from '../domain/analysis.js'
import type { Analysis } from '../domain/analysis.js'
import type { AnalysisService } from '../service/analysis-service.js'

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
}

/**
 * Every scope parameter below is written out inline ON PURPOSE.
 *
 * The parameter-type inference reads the literal shape at the point of declaration. Hoisting
 * `items: { type: 'object', properties: {...} }` into a shared `const` widens `type` to
 * `string` and `required` to `boolean`, the item type collapses, and `execute` receives
 * `JsonValue` instead of `{ material_id: string; version: number }` — producing a wall of
 * type errors at every use site. Do not "DRY" this up. (Verified by experiment.)
 */

function uncoveredToJson(u: Analysis['uncovered'][number]): JsonObject {
  return {
    text: u.text,
    reason: u.reason,
    entry:
      u.entry === null
        ? null
        : { material_id: u.entry.materialId, version: u.entry.version },
  }
}

function analysisToJson(a: Analysis): JsonObject {
  return {
    analysis_id: a.id,
    project_id: a.projectId,
    trigger: a.trigger,
    created_at: a.createdAt,
    scope: a.scope.map((s) => ({ material_id: s.materialId, version: s.version })),
    reads: a.reads.map((r) => ({
      material_id: r.entry.materialId,
      version: r.entry.version,
      original_name: r.originalName,
      sha256: r.sha256,
      size: r.size,
      ok: r.ok,
      reason: r.reason,
      read_at: r.readAt,
    })),
    requirements: a.requirements.map((r) => ({
      text: r.text,
      sources: r.sources.map((s) => ({ material_id: s.materialId, version: s.version })),
    })),
    undecided: [...a.undecided],
    inferences: [...a.inferences],
    uncovered: a.uncovered.map(uncoveredToJson),
  }
}

function present(title: string, rawInput?: unknown) {
  return {
    card: 'generic' as const,
    title,
    kind: 'other' as const,
    ...(rawInput === undefined ? {} : { rawInput }),
  }
}

export function analysisToolDefinitions(service: AnalysisService): ToolDefinition[] {
  return [
    defineTool({
      name: 'analysis_begin',
      description:
        'Start an analysis by declaring exactly which material VERSIONS it may read. The ' +
        'server reads those versions and returns their content. You can only work from what ' +
        'this returns: anything not listed here is not available to you, so list everything ' +
        'you intend to rely on. Use material_list first to see what exists (names, purposes, ' +
        'versions) without reading content. This changes nothing and can be abandoned.',
      parameters: {
        project_id: { type: 'string', required: true },
        scope: {
          type: 'array',
          required: true,
          description:
            'The exact versions this analysis may read. Each item is one fixed version. ' +
            'Content outside this list will NOT be provided.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              material_id: { type: 'string', required: true },
              version: { type: 'integer', required: true },
            },
          },
        },
        trigger: {
          type: 'string',
          required: true,
          description: 'Why this analysis is being requested. Recorded verbatim.',
        },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          const outcome = service.readScope({
            projectId: args.project_id,
            scope: args.scope.map((s) => ({ materialId: s.material_id, version: s.version })),
          })
          return Promise.resolve({
            project_id: outcome.projectId,
            trigger: args.trigger,
            read_count: outcome.contents.length,
            unreadable_count: outcome.uncovered.length,
            materials: outcome.contents.map((c) => ({
              material_id: c.materialId,
              version: c.version,
              original_name: c.originalName,
              sha256: c.sha256,
              size: c.size,
              content: c.content,
            })),
            // Gaps are stated up front so they cannot be overlooked when writing up.
            could_not_read: outcome.uncovered.map(uncoveredToJson),
            limit_bytes_per_file: DEFAULT_CONTENT_LIMIT_BYTES,
          })
        }),
      presentCall: (args) => present('Begin analysis', `${args.scope.length} version(s)`),
    }),

    defineTool({
      name: 'analysis_submit',
      description:
        'Record a completed analysis. Pass the same scope you read. Requirements must each ' +
        'cite the version that states them — a requirement you cannot source belongs in ' +
        'inferences instead. Reading failures found by the server are recorded automatically ' +
        'and are included whether or not you mention them. All three lists may be empty; ' +
        'there is no need to invent an item to fill them.',
      parameters: {
        project_id: { type: 'string', required: true },
        trigger: { type: 'string', required: true },
        scope: {
          type: 'array',
          required: true,
          description: 'Exactly the versions you read via analysis_begin.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              material_id: { type: 'string', required: true },
              version: { type: 'integer', required: true },
            },
          },
        },
        requirements: {
          type: 'array',
          required: true,
          description:
            'Things the material states EXPLICITLY. Each must cite at least one source ' +
            'version from the scope — that citation is what makes it explicit rather than inferred.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              sources: {
                type: 'array',
                required: true,
                description: 'Versions that state this. Must be inside the scope.',
                items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              material_id: { type: 'string', required: true },
              version: { type: 'integer', required: true },
            },
          },
              },
            },
          },
        },
        undecided: {
          type: 'array',
          required: true,
          description:
            'Raised but not settled by the material. Plain statements, no owner, no status.',
          items: { type: 'string' },
        },
        inferences: {
          type: 'array',
          required: true,
          description:
            'Your own conclusions that the material does not directly support. These are ' +
            'advice, never commitments.',
          items: { type: 'string' },
        },
        not_understood: {
          type: 'array',
          required: true,
          description: 'Parts of the content you received but could not make sense of.',
          items: { type: 'string' },
        },
        basis_missing: {
          type: 'array',
          required: true,
          description: 'A basis you needed but that was not supplied by any material.',
          items: { type: 'string' },
        },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          const analysis = service.submit({
            projectId: args.project_id,
            trigger: args.trigger,
            scope: args.scope.map((s) => ({ materialId: s.material_id, version: s.version })),
            requirements: args.requirements.map((r) => ({
              text: r.text,
              sources: r.sources.map((s) => ({ materialId: s.material_id, version: s.version })),
            })),
            undecided: [...args.undecided],
            inferences: [...args.inferences],
            notUnderstood: [...args.not_understood],
            basisMissing: [...args.basis_missing],
          })
          return Promise.resolve(analysisToJson(analysis))
        }),
      presentCall: () => present('Submit analysis'),
    }),

    defineTool({
      name: 'analysis_get',
      description:
        'Read back one stored analysis: its scope, exactly which versions were read, the ' +
        'three content kinds, and the parts that were not covered. Use this to check what an ' +
        'earlier analysis was actually based on.',
      parameters: {
        analysis_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => Promise.resolve(analysisToJson(service.get(args.analysis_id)))),
      presentCall: (args) => present('Get analysis', args.analysis_id),
    }),

    defineTool({
      name: 'analysis_list',
      description: 'List the analyses of a project, oldest first, with their triggers and scope.',
      parameters: {
        project_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() =>
          Promise.resolve({
            analyses: service.listByProject(args.project_id).map(analysisToJson),
          }),
        ),
      presentCall: (args) => present('List analyses', args.project_id),
    }),
  ]
}
