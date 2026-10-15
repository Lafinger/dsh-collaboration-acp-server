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
import { IdentityStore } from './identity-store.mjs';
import { LoginService } from './login-service.mjs';
import { DingTalkIdentityProvider } from './dingtalk-identity.mjs';
import { ProjectAccess } from './project-access.mjs';
import { CommunicationBridge } from './communication-bridge.mjs';
import {acquireMaintenanceLock} from './maintenance-lock.mjs';
import {VisionAccess} from './vision.mjs';

/** One business database, borrowed host services, tools registered only into authenticated Agent scopes. */
export async function createCollaborationRuntime(config, ctx) {
  if (!ctx) throw new Error('Host DSH context required');
  if (!isAbsolute(config.workspace ?? '') || !isAbsolute(config.stateRoot ?? '')) throw new Error('Explicit absolute isolated workspace/stateRoot required');
  const workspace = resolve(config.workspace), root = resolve(config.stateRoot);
  mkdirSync(workspace, { recursive: true }); mkdirSync(root, { recursive: true,mode:0o700 });
  const maintenance=await acquireMaintenanceLock(root);let db;
  try{db = openDatabase({ path: join(root, 'collaboration.sqlite') });}catch(error){await maintenance.release();throw error;}
  let runtime,communication;
  try{
  const identities = new SessionIdentityService(db), tasks = new TaskService(db), materials = new MaterialService(db, join(root, 'files'));
  const services = {
    identities, tasks, materials, projects: new ProjectService(db), plans: new PlanService(db, undefined, tasks),
    analyses: new AnalysisService(db, materials), notices: new NoticeService(db), traces: new TraceService(db), results: new ResultService(db),
  };
  const security=config.dingtalk?new IdentityStore({db,serviceId:config.serviceId,...config.dingtalk}):null;
  const login=security?new LoginService({identities:security,provider:new DingTalkIdentityProvider(config.dingtalk),publicOrigin:config.dingtalk.publicOrigin}):null;
  login?.expireInterrupted();
  const access=security?new ProjectAccess({identities:security,services}):null;
  const attachments = new AttachmentService({ db, root: join(root, 'attachments'), materials, projects: services.projects });
  materials.contentProvider = attachments.materialContent.bind(attachments);
  const vision=new VisionAccess({ctx,attachments,access});
  runtime = new DshRuntime({ ctx, provider: config.provider, model: config.model,
    setup: (agentCtx, agent, account,principal) => {
      if(security&&!principal)throw new Error('Authenticated project principal required');
      const identityTransform = bindCollaborationIdentity(agentCtx, identities, { sessionId: agent.session.id, account, workspace,identitySource:security?'dingtalk':'authenticated_connector' });
      const accessTransform=access?.transform(principal);
      registerTools(agentCtx, services,original=>accessTransform?accessTransform(identityTransform(original)):identityTransform(original));
      const authorize=access?(_name,args)=>{
        access.scope(principal);
        if(principal.channel!=='dsh')throw new Error('IM attachments unavailable');
        if(args.receipt_id){const row=attachments.receipt(agent.session.id,account,args.receipt_id);if(JSON.parse(row.manifest).projectId!==principal.projectId)throw new Error('Attachment project mismatch');}
      }:undefined;
      if(!principal||principal.channel==='dsh')registerAttachmentTools(agentCtx, attachments, { sessionId: agent.session.id, account,authorize,vision });
      agentCtx.on('agent/request',async(payload,next)=>{if(payload.agent!==agent)return next();await vision.prepare(agent,account,principal,payload.signal);return next();});
      if(access){
        agentCtx.on('system-prompt/assemble',async(_a,_c,next)=>{const assembly=await next();return {...assembly,tools:assembly.tools.filter(t=>access.allows(principal,t.name)||principal.channel==='dsh'&&t.name.startsWith('attachment_'))};});
        agentCtx.tools.guard(exec=>{try{access.scope(principal);if(!access.allows(principal,exec.name)&&!(principal.channel==='dsh'&&exec.name.startsWith('attachment_')))return 'Tool unavailable in this authenticated channel';return undefined;}catch{return 'Authenticated member, device or project qualification unavailable';}});
      }
      const attachmentTurnTools = new Set(['session_whoami','project_list','project_get','material_list','material_read','material_versions','analysis_begin','analysis_submit','analysis_get','analysis_list','task_list','task_get','task_versions','task_origin','plan_get','plan_history','plan_list','trace','attachment_transfer','attachment_inspect','attachment_archive','attachment_receipts']);
      agentCtx.tools.guard(exec => !attachments.active.has(String(agent.session.id)) || attachmentTurnTools.has(exec.name) ? undefined : 'Attachment turns may only transfer, inspect, archive and analyze; no member assignment, plan approval or other business writes');
    },
  });
  runtime.attachments = attachments;
  runtime.vision = vision;
  await runtime.start();
  communication=security?new CommunicationBridge({identities:security,login,access,services,runtime,workspace,retentionDays:config.dingtalk.communicationRetentionDays}):null;
  await communication?.registerExistingLogs();
  const close = runtime.closeAll.bind(runtime);
  let closing;
  runtime.closeAll = () => closing ??= (async () => { try { try{await communication?.close();}finally{await close();} } finally { try{db.close();}finally{await maintenance.release();} } })();
  return { runtime, workspace, root, services, attachments,security,login,access,communication };
  }catch(error){try{try{await communication?.close();}finally{await runtime?.closeAll();}}finally{try{if(db.isOpen)db.close();}finally{await maintenance.release();}}throw error;}
}
