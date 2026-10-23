/**
 * Material tools (M2).
 *
 * `material_upload` is a WRITE tool: it changes state but makes no formal decision.
 * `material_list` / `material_read` are READ tools.
 *
 * Two behaviours the descriptions must make obvious to the model, because getting them
 * wrong silently corrupts history:
 *   - re-uploading the same name APPENDS a version, it does not replace anything;
 *   - reading takes a SPECIFIC version and never falls back to the latest.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonObject } from './json.js'
import { runTool } from './result.js'
import type { MaterialService } from '../service/material-service.js'
import type { Material, MaterialVersion, MaterialWithVersions } from '../domain/material.js'

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

function versionToJson(version: MaterialVersion): JsonObject {
  return {
    version: version.version,
    rel_path: version.relPath,
    size: version.size,
    sha256: version.sha256,
    issue: version.issue,
    created_at: version.createdAt,
  }
}

function materialToJson(material: Material): JsonObject {
  return {
    material_id: material.id,
    project_id: material.projectId,
    original_name: material.originalName,
    purpose: material.purpose,
    submitted_by: material.submittedBy,
    role: material.role,
    created_at: material.createdAt,
  }
}

function withVersionsToJson(material: MaterialWithVersions): JsonObject {
  return {
    ...materialToJson(material),
    latest_version: material.latestVersion,
    versions: material.versions.map(versionToJson),
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

export function materialToolDefinitions(service: MaterialService): ToolDefinition[] {
  return [
    defineTool({
      name: 'material_upload',
      description:
        'Upload a local file into a project as an immutable material version. The file is ' +
        'read from an absolute path on this machine. Identical latest bytes reuse the existing ' +
        'version; changed content appends without overwrite. Historical bytes require verified ' +
        'restoration approval, not a model-supplied flag. A different purpose is a different material.',
      parameters: {
        project_id: { type: 'string', required: true },
        target_material_id: { type: 'string', description: 'Explicit existing material target; never infer from similar filenames.' },
        expected_latest_version: { type: 'integer', description: 'Exact version on which the confirmed update was based.' },
        restore_version: { type: 'integer', description: 'Proposal only; raw tool arguments do not grant restoration permission.' },
        source_path: {
          type: 'string',
          required: true,
          description: 'Absolute path of the file to upload.',
        },
        purpose: {
          type: 'string',
          required: true,
          description: 'What this material is for, e.g. "需求说明". Two uploads of the same name with different purposes are different materials.',
        },
        submitted_by: {
          type: 'string',
          required: true,
          description: 'Name of the uploader, recorded as a snapshot.',
        },
        role: {
          type: 'string',
          enum: ROLE_ENUM,
          description: 'Role this material belongs to. Omit for shared (no role).',
        },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          const result = service.upload({
            projectId: args.project_id,
            sourcePath: args.source_path,
            targetMaterialId: args.target_material_id,
            expectedLatestVersion: args.expected_latest_version,
            restoreVersion: args.restore_version,
            purpose: args.purpose,
            submittedBy: args.submitted_by,
            role: args.role,
          })
          return Promise.resolve({
            created_new_material: result.created,
            reused_existing_version: result.deduplicated === true,
            next_time_reference_this: {
              material_id: result.material.id,
              version: result.version.version,
            },
            material: materialToJson(result.material),
            version: versionToJson(result.version),
            stored_at: result.absolutePath,
          })
        }),
      presentCall: (args) => present('Upload material', args.source_path),
    }),

    defineTool({
      name: 'material_list',
      description:
        'List a project\'s materials with all their versions. Use this to find the ' +
        'material_id and version numbers to cite.',
      parameters: {
        project_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          const materials = service.listByProject(args.project_id)
          return Promise.resolve({ materials: materials.map(withVersionsToJson) })
        }),
      presentCall: (args) => present('List materials', args.project_id),
    }),

    defineTool({
      name: 'material_read',
      description:
        'Read the content of ONE SPECIFIC version of a material. You must pass the exact ' +
        'version number; this never substitutes the latest version. If the stored file ' +
        'cannot be read you get a reason instead of content — report that honestly rather ' +
        'than treating the material as empty.',
      parameters: {
        material_id: { type: 'string', required: true },
        version: { type: 'integer', required: true, description: 'Exact version number to read.' },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          const read = service.read({ materialId: args.material_id, version: args.version })
          return Promise.resolve({
            material_id: read.material.id,
            original_name: read.material.originalName,
            purpose: read.material.purpose,
            version: read.version.version,
            sha256: read.version.sha256,
            size: read.version.size,
            content: read.content,
            unreadable_reason: read.issue,
            parser_warnings: [...(read.warnings ?? [])],
          })
        }),
      presentCall: (args) => present('Read material', `${args.material_id} v${args.version}`),
    }),

    defineTool({
      name: 'material_versions',
      description: 'List the versions of one material, oldest first, with their hashes.',
      parameters: {
        material_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          const material = service.getWithVersions(args.material_id)
          return Promise.resolve({
            material_id: material.id,
            original_name: material.originalName,
            purpose: material.purpose,
            latest_version: material.latestVersion,
            versions: material.versions.map(versionToJson),
          })
        }),
      presentCall: (args) => present('List material versions', args.material_id),
    }),
  ]
}

export { ROLE_ENUM }
