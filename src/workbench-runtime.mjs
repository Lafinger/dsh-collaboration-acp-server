import { mkdirSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { FixtureModel } from './fixture-model.mjs';

export async function createWorkbenchRuntime(config) {
  if (!isAbsolute(config.workspace ?? '') || !isAbsolute(config.stateRoot ?? '')) throw new Error('Explicit absolute isolated workspace/stateRoot required');
  const workspace = resolve(config.workspace), root = resolve(config.stateRoot);
  mkdirSync(workspace, { recursive: true }); mkdirSync(root, { recursive: true });
  const db = openDatabase({ path: join(root, 'workbench.sqlite') });
  const identities = new SessionIdentityService(db), tasks = new TaskService(db), materials = new MaterialService(db, join(root, 'files'));
  const services = {
    identities, tasks, materials, projects: new ProjectService(db), plans: new PlanService(db, undefined, tasks),
    analyses: new AnalysisService(db, materials), notices: new NoticeService(db), traces: new TraceService(db), results: new ResultService(db),
  };
  let adapter, provider, model;
  if (config.fixture === true) { adapter = new FixtureModel(); provider = 'workbench-fixture'; model = 'fixture'; }
  else {
    if (!isAbsolute(config.adapterModule ?? '') || !config.provider || !config.model) { db.close(); throw new Error('Real model requires deployment-owned adapterModule/provider/model; no default paid call'); }
    const module = await import(pathToFileURL(config.adapterModule).href);
    adapter = await module.createAdapter(config.adapterConfig ?? {}); provider = config.provider; model = config.model;
  }
  const runtime = new DshRuntime({ provider, model, adapter, persistenceRoot: join(root, 'sessions'),
    setup: (agentCtx, agent, account) => bindWorkbenchIdentity(agentCtx, identities, { sessionId: agent.session.id, account }),
  });
  try { await runtime.start(); registerTools(runtime.ctx, services); }
  catch (error) { await runtime.closeAll(); db.close(); throw error; }
  const close = runtime.closeAll.bind(runtime);
  let closed = false;
  runtime.closeAll = async () => { if (closed) return; closed = true; await close(); db.close(); };
  return { runtime, workspace, root };
}
