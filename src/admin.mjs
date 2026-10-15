import { AccessError,requireText } from './protocol.mjs';

/** Called exclusively by the OS-local administrator CLI, never registered as a model tool/RPC. */
export function administer({identities,projects,configuredAccounts,communication},command,actor='local-administrator'){
  if(!command||typeof command!=='object'||Array.isArray(command))throw new AccessError(-32602,'Administrator command must be a JSON object');
  const allowed={
    bind:['action','account','userId','unionId','administrator'],
    enable:['action','account','enabled'],
    participate:['action','account','projectId','enabled'],
    role:['action','projectId','role','account'],
    create:['action','key','name','background','goal','participants'],
    members:['action'],
    epoch:['action','confirmation'],
    target:['action','id','projectId','kind','account','botId','corpId','clientId','robotCode','route','enabled','publicEnabled'],
    subscription:['action','id','projectId','account','targetId','kinds','enabled'],
    purge:['action','confirmation'],
    communications:['action'],
    inspect:['action','projectId'],
  }[command.action];
  if(!allowed||Object.keys(command).some(k=>!allowed.includes(k)))throw new AccessError(-32602,'Unknown administrator operation or field');
  const account=value=>{requireText(value,'member account',200);if(!Object.hasOwn(configuredAccounts,value))throw new AccessError(-32003,'Account has no administrator-provisioned SSH entry');return value;};
  if(command.action==='bind')return identities.bind({...command,account:account(command.account)},actor);
  if(command.action==='enable'){account(command.account);identities.setEnabled(command.account,command.enabled,actor);return {ok:true};}
  if(command.action==='participate'){account(command.account);identities.participate(command.projectId,command.account,command.enabled,actor);return {ok:true};}
  if(command.action==='role'){
    return identities.transaction(()=>{
      if(command.account!==null){const m=identities.member(account(command.account));const p=identities.db.prepare('SELECT enabled FROM collaboration_participants WHERE project_id=? AND account=?').get(command.projectId,command.account);
        if(!m?.enabled||!p?.enabled)throw new AccessError(-32003,'Role assignment requires an enabled project participant');}
      const previous=projects.getWithRoles(command.projectId).roles.find(r=>r.role===command.role)?.member??null;
      projects.setMember(command.projectId,command.role,command.account);
      if(previous!==command.account)for(const affected of new Set([previous,command.account].filter(Boolean)))identities.db.prepare('UPDATE collaboration_participants SET revision=revision+1 WHERE project_id=? AND account=?').run(command.projectId,affected);
      identities.audit(actor,'role-assignment',JSON.stringify([command.projectId,command.role,command.account]));return {ok:true};
    });
  }
  if(command.action==='create'){
    if(!Array.isArray(command.participants)||!command.participants.length||command.participants.length>200)throw new AccessError(-32602,'Explicit initial project participants required');
    for(const a of command.participants){const m=identities.member(account(a));if(!m?.enabled)throw new AccessError(-32003,'Unknown initial project participant');}
    return identities.transaction(()=>{
      const project=projects.create({key:command.key,name:command.name,background:command.background,goal:command.goal});
      for(const a of new Set(command.participants))identities.participate(project.id,a,true,actor);
      identities.audit(actor,'project-create',project.id);return {ok:true,project};
    });
  }
  if(command.action==='target'){if(command.account)account(command.account);if(!communication)throw new Error('Communication store required');return communication.manageTarget(command,actor);}
  if(command.action==='subscription'){account(command.account);if(!communication)throw new Error('Communication store required');return communication.subscribe(command,actor);}
  if(command.action==='purge'){if(!communication)throw new Error('Communication store required');return communication.purge(command,actor);}
  if(command.action==='communications')return {targets:identities.db.prepare('SELECT id,project_id,kind,account,enabled,public_enabled,revision FROM collaboration_targets ORDER BY id').all(),subscriptions:identities.db.prepare('SELECT id,project_id,account,target_id,kinds,enabled,revision FROM collaboration_subscriptions').all(),inboundCounts:identities.db.prepare('SELECT status,count(*) n FROM collaboration_inbox GROUP BY status').all(),outboundCounts:identities.db.prepare('SELECT status,count(*) n FROM collaboration_outbox GROUP BY status').all(),privateBodiesIncluded:false};
  if(command.action==='inspect'){requireText(command.projectId,'projectId',200);return {project:projects.getWithRoles(command.projectId),participants:identities.db.prepare('SELECT account,enabled,revision FROM collaboration_participants WHERE project_id=? ORDER BY account').all(command.projectId)};}
  if(command.action==='members')return {members:identities.db.prepare('SELECT account,enabled,administrator FROM collaboration_members ORDER BY account').all()};
  if(command.action==='epoch'){
    if(command.confirmation!=='REVOKE_ALL_DEVICE_LOGINS')throw new AccessError(-32602,'Explicit device revocation confirmation required');
    identities.revokeAllDevices(actor);return {ok:true,epoch:identities.epoch,dataDeleted:false};
  }
}
