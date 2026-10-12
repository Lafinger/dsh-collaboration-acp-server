/**
 * Tool registration.
 *
 * `ctx.inject(['tools'], cb)` runs `cb` once the tools service is available, and re-runs
 * it if that service is replaced — so registration must be idempotent per fiber, which the
 * container guarantees by disposing the previous fiber.
 *
 * The callback receives its OWN context; using the outer one would skip the injection
 * guarantee entirely.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { analysisToolDefinitions } from './analysis-tools.js'
import { materialToolDefinitions } from './material-tools.js'
import { noticeToolDefinitions } from './notice-tools.js'
import { planToolDefinitions } from './plan-tools.js'
import { projectToolDefinitions } from './project-tools.js'
import { resultToolDefinitions } from './result-tools.js'
import { sessionIdOf } from './session-id.js'
import { sessionToolDefinitions } from './session-tools.js'
import { taskToolDefinitions } from './task-tools.js'
import { traceToolDefinitions } from './trace-tools.js'
import type { AnalysisService } from '../service/analysis-service.js'
import type { MaterialService } from '../service/material-service.js'
import type { NoticeService } from '../service/notice-service.js'
import type { PlanService } from '../service/plan-service.js'
import type { ProjectService } from '../service/project-service.js'
import type { ResultService } from '../service/result-service.js'
import type { SessionIdentityService } from '../service/session-identity-service.js'
import type { TaskService } from '../service/task-service.js'
import type { TraceService } from '../service/trace-service.js'

export interface Services {
  readonly projects: ProjectService
  readonly materials: MaterialService
  readonly analyses: AnalysisService
  readonly plans: PlanService
  readonly tasks: TaskService
  readonly results: ResultService
  readonly notices: NoticeService
  readonly traces: TraceService
  readonly identities: SessionIdentityService
}

export function registerTools(ctx: Context, services: Services, transform?: (definition: ToolDefinition) => ToolDefinition): void {
  const register = (toolCtx: Context): void => {
    const tools = toolCtx.get('tools')
    if (tools === undefined) return

    /*
     * Who this session has declared itself to be (ADR-0014).
     *
     * Read from the SESSION on every call rather than accepted as a tool argument: the whole
     * point of the eligibility check is that a caller cannot satisfy it by naming whoever holds
     * the role. A null result means "not declared", which the services report as such.
     */
    const declaredMemberOf = (exec: unknown): string | null => {
      const sessionId = sessionIdOf(exec as Parameters<typeof sessionIdOf>[0])
      return sessionId === null ? null : services.identities.current(sessionId)
    }

    const definitions = [
      ...projectToolDefinitions(services.projects, services.plans),
      ...materialToolDefinitions(services.materials),
      ...analysisToolDefinitions(services.analyses),
      ...planToolDefinitions(services.plans, declaredMemberOf),
      ...taskToolDefinitions(services.tasks, services.projects),
      ...resultToolDefinitions(services, declaredMemberOf),
      ...noticeToolDefinitions(services),
      ...traceToolDefinitions(services),
      ...sessionToolDefinitions(services.identities, sessionIdOf),
    ]

    for (const definition of definitions) {
      tools.register(transform ? transform(definition) : definition)
    }
  }
  // Pre-publication Agent setup needs registrations immediately, before identity shadows.
  // The caller context owns the scoped effects; delayed injection remains for legacy business tests.
  if (ctx.get('tools') !== undefined) register(ctx)
  else ctx.inject(['tools'], register)
}
