/**
 * Project collaboration business module — plugin entry point.
 *
 * One plugin, one SQLite database, no UI and no permission model (see docs/adr/).
 * All writes flow tool → service → sqlite; there is no other write path.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { openDatabase } from './sqlite/connection.js'
import { AnalysisService } from './service/analysis-service.js'
import { MaterialService } from './service/material-service.js'
import { NoticeService } from './service/notice-service.js'
import { TraceService } from './service/trace-service.js'
import { ProjectService } from './service/project-service.js'
import { PlanService } from './service/plan-service.js'
import { ResultService } from './service/result-service.js'
import { SessionIdentityService } from './service/session-identity-service.js'
import { TaskService } from './service/task-service.js'
import { registerTools } from './tool/register.js'

export const name = 'project-collaboration'

export interface Config {
  /** SQLite file, relative to the session's working directory. */
  readonly databasePath: string
  /** Root directory for uploaded materials and produced results. */
  readonly fileRoot: string
}

export const Config: z<Config> = z.object({
  databasePath: z.string().default('.dsh/collaboration.sqlite'),
  fileRoot: z.string().default('.dsh/collaboration-files'),
})

export function apply(ctx: Context, config: Config): void {
  const db = openDatabase({ path: config.databasePath })

  // Close the connection when the plugin unloads, so reloads do not leak handles
  // (and do not leave a WAL file locked on Windows).
  ctx.effect(() => () => {
    db.close()
  })

  const materials = new MaterialService(db, config.fileRoot)
  // The task service is constructed BEFORE the plan service because activation resolves the
  // plan's proposals through it (ADR-0009). Without this wiring a plan would activate and
  // silently create nothing.
  const tasks = new TaskService(db)
  const services = {
    projects: new ProjectService(db),
    materials,
    analyses: new AnalysisService(db, materials),
    plans: new PlanService(db, undefined, tasks),
    tasks,
    results: new ResultService(db),
    notices: new NoticeService(db),
    traces: new TraceService(db),
    identities: new SessionIdentityService(db),
  }

  ctx.logger?.info?.(
    'project-collaboration ready: database=%s fileRoot=%s',
    config.databasePath,
    config.fileRoot,
  )

  registerTools(ctx, services)
}
