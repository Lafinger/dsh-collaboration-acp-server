/**
 * Tools for todos and notifications (M6).
 *
 * Four tools, and ONE thing they all have in common: none of them can close a todo.
 * A todo closes only when the corresponding decision is submitted through its own tool
 * (plan_confirm, result_review, result_accept). Marking something read is not a decision —
 * that is MVP-030, and a tool that closed a todo would break it.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Services } from './register.js'
import type { JsonObject } from './json.js'
import { runTool } from './result.js'
import type { ItemKind, Todo, Notice, SlotRef } from '../domain/notice.js'
import type { RoleId } from '../domain/roles.js'

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

const KIND_ENUM = [
  'plan_confirmation',
  'result_review',
  'result_acceptance',
  'result_rejected',
  'task_completed',
] as const

function todoToJson(t: Todo): JsonObject {
  return {
    kind: t.kind,
    role: t.role,
    // A vacant role still sees its todos — nobody else can decide for it — but owes no unread.
    member: t.member,
    vacant: t.member === null,
    object_id: t.objectId,
    version: t.version,
    task_id: t.taskId,
    summary: t.summary,
    created_at: t.createdAt,
    read: t.read,
  }
}

function noticeToJson(n: Notice): JsonObject {
  return {
    kind: n.kind,
    role: n.role,
    member: n.member,
    vacant: n.member === null,
    object_id: n.objectId,
    version: n.version,
    task_id: n.taskId,
    summary: n.summary,
    detail: n.detail,
    created_at: n.createdAt,
    read: n.read,
  }
}

export function noticeToolDefinitions(services: Services): readonly ToolDefinition[] {
  return [
    defineTool({
      name: 'todo_list',
      description:
        'List what needs a decision: plan confirmations, result reviews and result ' +
        'acceptances. Each entry names the role that must act and the object/version it is ' +
        'about. Todos are DERIVED from undecided slots — there is no separate todo list to ' +
        'get out of sync. A todo is closed ONLY by submitting the corresponding decision ' +
        '(plan_confirm / result_review / result_accept); marking it read does not close it.',
      parameters: {
        project_id: { type: 'string', required: true },
        roles: {
          type: 'array',
          description: 'Only these roles. Omit for every role.',
          items: { type: 'string', enum: ROLE_ENUM },
        },
        kinds: {
          type: 'array',
          description: 'Only these kinds. Omit for all todo kinds.',
          items: { type: 'string', enum: KIND_ENUM },
        },
        unread_only: {
          type: 'boolean',
          description: 'Only items this role has not read yet.',
        },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return runTool(() => {
          const todos = services.notices.todos({
            projectId: args.project_id,
            // Spread conditionally: with exactOptionalPropertyTypes, an absent key and an
            // explicit `undefined` are different types, and the filter treats "absent" as
            // "no filter".
            ...(args.roles === undefined ? {} : { roles: args.roles as readonly RoleId[] }),
            ...(args.kinds === undefined ? {} : { kinds: args.kinds as readonly ItemKind[] }),
            ...(args.unread_only === undefined ? {} : { unreadOnly: args.unread_only }),
          })
          return {
            ok: true,
            count: todos.length,
            todos: todos.map(todoToJson),
            note: 'Reading a todo does not close it. Submit the matching decision.',
          }
        })
      },
    }),

    defineTool({
      name: 'notice_list',
      description:
        'List notifications: things that already happened and need no decision. Reading one ' +
        'produces no business decision whatsoever. Notifications are never "owed", so they ' +
        'never appear in an unread count.',
      parameters: {
        project_id: { type: 'string', required: true },
        roles: {
          type: 'array',
          description: 'Only these roles. Omit for every role.',
          items: { type: 'string', enum: ROLE_ENUM },
        },
        kinds: {
          type: 'array',
          description: 'Only these kinds. Omit for all notice kinds.',
          items: { type: 'string', enum: KIND_ENUM },
        },
        unread_only: { type: 'boolean', description: 'Only unread items.' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return runTool(() => {
          const list = services.notices.list({
            projectId: args.project_id,
            ...(args.roles === undefined ? {} : { roles: args.roles as readonly RoleId[] }),
            ...(args.kinds === undefined ? {} : { kinds: args.kinds as readonly ItemKind[] }),
            ...(args.unread_only === undefined ? {} : { unreadOnly: args.unread_only }),
          })
          return { ok: true, count: list.length, notices: list.map(noticeToJson) }
        })
      },
    }),

    defineTool({
      name: 'todo_unread',
      description:
        'How much each role currently owes, per role. A VACANT role still lists its todos ' +
        'but reports unread 0 — there is nobody to be behind. Only todos count: a ' +
        'notification is never owed.',
      parameters: {
        project_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return runTool(() => {
          const counts = services.notices.unread(args.project_id)
          return {
            ok: true,
            roles: counts.map((c) => ({
              role: c.role,
              pending: c.pending,
              read: c.read,
              unread: c.unread,
            })),
            total_unread: counts.reduce((sum, c) => sum + c.unread, 0),
          }
        })
      },
    }),

    defineTool({
      name: 'todo_mark_read',
      description:
        'Mark a todo or notification as READ for its role. Read means only that it was seen: ' +
        'it does NOT mean agreed, completed, accepted or resolved, and it changes NO ' +
        'business state. A read todo also does not disappear — only the matching decision ' +
        'closes it. Reading the same item twice does not count twice.',
      parameters: {
        project_id: { type: 'string', required: true },
        kind: {
          type: 'string',
          required: true,
          enum: KIND_ENUM,
          description: 'Which kind of item this address refers to.',
        },
        object_id: {
          type: 'string',
          required: true,
          description: 'Plan id or result id, depending on the kind.',
        },
        version: { type: 'number', required: true, description: 'Plan version or result version.' },
        role: {
          type: 'string',
          required: true,
          enum: ROLE_ENUM,
          description: 'The role the slot belongs to. Reads are recorded per role slot.',
        },
        task_id: {
          type: 'string',
          description: 'For result_acceptance only: the downstream task that decides.',
        },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        return runTool(() => {
          const ref: SlotRef = {
            kind: args.kind as ItemKind,
            projectId: args.project_id,
            objectId: args.object_id,
            version: args.version,
            role: args.role as RoleId,
            taskId: args.task_id ?? null,
          }
          const { changed } = services.notices.markRead(ref)
          return {
            ok: true,
            changed,
            note:
              changed
                ? 'Recorded. This decided nothing.'
                : 'Already read; reading twice counts once.',
          }
        })
      },
    }),
  ]
}
