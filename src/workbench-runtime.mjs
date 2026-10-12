import { mkdirSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { DshRuntime } from './dsh-runtime.mjs';
import { bindWorkbenchIdentity } from './workbench-binding.mjs';
import { openDatabase } from '../business/lib/sqlite/connection.js';
import { SessionIdentityService } from '../business/lib/service/session-identity-service.js';
import { ProjectService } from '../business/lib/service/project-service.js';
import { TaskService } from '../business/lib/service/task-service.js';
import { PlanService } from '../business/lib/service/plan-service.js';
import { MaterialService } from '../business/lib/service/material-service.js';
import { AnalysisService } from '../business/lib/service/analysis-service.js';
import { NoticeService } from '../business/lib/service/notice-service.js';
import { TraceService } from '../business/lib/service/trace-service.js';
import { ResultService } from '../business/lib/service/result-service.js';
import { registerTools } from '../business/lib/tool/register.js';

/** One business database, borrowed host services, tools registered only into authenticated Agent scopes. */
export async function createWorkbenchRuntime(config, ctx) {
  if (!ctx) throw new Error('Host DSH context required');
  if (!isAbsolute(config.workspace ?? '') || !isAbsolute(config.stateRoot ?? '')) throw new Error('Explicit absolute isolated workspace/stateRoot required');
  const workspace = resolve(config.workspace), root = resolve(config.stateRoot);
  mkdirSync(workspace, { recursive: true }); mkdirSync(root, { recursive: true });
  const db = openDatabase({ path: join(root, 'workbench.sqlite') });
  const identities = new SessionIdentityService(db), tasks = new TaskService(db), materials = new MaterialService(db, join(root, 'files'));
  const services = {
    identities, tasks, materials, projects: new ProjectService(db), plans: new PlanService(db, undefined, tasks),
    analyses: new AnalysisService(db, materials), notices: new NoticeService(db), traces: new TraceService(db), results: new ResultService(db),
  };
  const runtime = new DshRuntime({ ctx, provider: config.provider, model: config.model,
    setup: (agentCtx, agent, account) => {
      const transform = bindWorkbenchIdentity(agentCtx, identities, { sessionId: agent.session.id, account, workspace });
      registerTools(agentCtx, services, transform);
    },
  });
  try { await runtime.start(); }
  catch (error) { await runtime.closeAll(); db.close(); throw error; }
  const close = runtime.closeAll.bind(runtime);
  let closing;
  runtime.closeAll = () => closing ??= (async () => { try { await close(); } finally { db.close(); } })();
  return { runtime, workspace, root, services };
}
