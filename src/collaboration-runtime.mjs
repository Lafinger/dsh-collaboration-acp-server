import { mkdirSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { DshRuntime } from './dsh-runtime.mjs';
import { bindCollaborationIdentity } from './collaboration-binding.mjs';
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
import { AttachmentService } from './attachment-service.mjs';
import { registerAttachmentTools } from './attachment-tools.mjs';

/** One business database, borrowed host services, tools registered only into authenticated Agent scopes. */
export async function createCollaborationRuntime(config, ctx) {
  if (!ctx) throw new Error('Host DSH context required');
  if (!isAbsolute(config.workspace ?? '') || !isAbsolute(config.stateRoot ?? '')) throw new Error('Explicit absolute isolated workspace/stateRoot required');
  const workspace = resolve(config.workspace), root = resolve(config.stateRoot);
  mkdirSync(workspace, { recursive: true }); mkdirSync(root, { recursive: true });
  const db = openDatabase({ path: join(root, 'collaboration.sqlite') });
  const identities = new SessionIdentityService(db), tasks = new TaskService(db), materials = new MaterialService(db, join(root, 'files'));
  const services = {
    identities, tasks, materials, projects: new ProjectService(db), plans: new PlanService(db, undefined, tasks),
    analyses: new AnalysisService(db, materials), notices: new NoticeService(db), traces: new TraceService(db), results: new ResultService(db),
  };
  const attachments = new AttachmentService({ db, root: join(root, 'attachments'), materials, projects: services.projects });
  materials.contentProvider = attachments.materialContent.bind(attachments);
  const runtime = new DshRuntime({ ctx, provider: config.provider, model: config.model,
    setup: (agentCtx, agent, account) => {
      const transform = bindCollaborationIdentity(agentCtx, identities, { sessionId: agent.session.id, account, workspace });
      registerTools(agentCtx, services, transform);
      registerAttachmentTools(agentCtx, attachments, { sessionId: agent.session.id, account });
      const attachmentTurnTools = new Set(['session_whoami','project_list','project_get','material_list','material_read','material_versions','analysis_begin','analysis_submit','analysis_get','analysis_list','task_list','task_get','task_versions','task_origin','plan_get','plan_history','plan_list','trace','attachment_transfer','attachment_inspect','attachment_archive','attachment_receipts']);
      agentCtx.tools.guard(exec => !attachments.active.has(String(agent.session.id)) || attachmentTurnTools.has(exec.name) ? undefined : 'Attachment turns may only transfer, inspect, archive and analyze; no member assignment, plan approval or other business writes');
    },
  });
  runtime.attachments = attachments;
  try { await runtime.start(); }
  catch (error) { await runtime.closeAll(); db.close(); throw error; }
  const close = runtime.closeAll.bind(runtime);
  let closing;
  runtime.closeAll = () => closing ??= (async () => { try { await close(); } finally { db.close(); } })();
  return { runtime, workspace, root, services, attachments };
}
