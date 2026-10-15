import { AccessError, requireText } from './protocol.mjs';
import { inTransaction } from '../business/lib/sqlite/schema.js';

const unavailable=()=>{throw new AccessError(-32003,'Object is unavailable in this project context');};
const tables={material:['materials','id'],analysis:['analyses','id'],plan:['plans','id'],task:['tasks','id']};
const dshTools=new Set(['session_whoami','project_list','project_get','project_update_details','material_upload','material_list','material_read','material_versions',
  'analysis_begin','analysis_submit','analysis_get','analysis_list','plan_register','plan_revise','plan_confirm','plan_get','plan_history','plan_list',
  'task_list','task_get','task_versions','task_origin','progress_add','progress_list','result_submit','result_list','result_review','result_acceptance_open',
  'result_accept','result_pending','todo_list','notice_list','todo_unread','todo_mark_read','trace']);
const privateImTools=new Set(['session_whoami','project_list','project_get','material_list','todo_list','notice_list','todo_unread']);
const denied=()=>({ok:false,code:'PROJECT_ACCESS_DENIED',message:'This operation or object is unavailable in the current authenticated project context.'});

/** Server-enforced scope. Uses the same SQLite connection as synchronous business services. */
export class ProjectAccess {
  constructor({identities,services,authorize}){this.identities=identities;this.db=identities.db;this.services=services;this.authorize=authorize;}
  scope(principal){
    if(!principal||!['dsh','im-private','im-group'].includes(principal.channel))unavailable();
    this.authorize?.(principal);
    const member=this.identities.requireMember(principal.account);
    if(principal.memberRevision!==undefined&&principal.memberRevision!==member.revision)unavailable();
    if(principal.login)this.identities.requireLogin(principal.login);
    const participant=this.identities.requireProject(principal.account,principal.projectId);
    if((principal.participantRevision!==undefined&&participant.revision!==principal.participantRevision)||(principal.epoch!==undefined&&principal.epoch!==this.identities.epoch))unavailable();
  }
  object(kind,id,principal,seen=new Set()){
    requireText(id,'object id',200);const key=`${kind}:${id}`;if(seen.has(key))return;seen.add(key);
    let row;
    if(kind==='result')row=this.db.prepare('SELECT t.project_id FROM result_versions r JOIN tasks t ON t.id=r.task_id WHERE r.result_id=? LIMIT 1').get(id);
    else {const [table,column]=tables[kind]??[];if(!table)unavailable();row=this.db.prepare(`SELECT project_id FROM ${table} WHERE ${column}=? LIMIT 1`).get(id);}
    if(!row||row.project_id!==principal.projectId)unavailable();
    if(kind==='analysis'){
      const refs=this.db.prepare(`SELECT material_id FROM analysis_scope WHERE analysis_id=? UNION SELECT material_id FROM analysis_requirement_sources WHERE analysis_id=?
        UNION SELECT material_id FROM analysis_reads WHERE analysis_id=? UNION SELECT material_id FROM analysis_uncovered WHERE analysis_id=? AND material_id IS NOT NULL`).all(id,id,id,id);
      for(const ref of refs)this.object('material',ref.material_id,principal,seen);
    }
    if(kind==='plan'){
      for(const p of this.db.prepare('SELECT source_analysis_id FROM plans WHERE id=? AND source_analysis_id IS NOT NULL').all(id))this.object('analysis',p.source_analysis_id,principal,seen);
      for(const t of this.db.prepare('SELECT task_id FROM plan_tasks WHERE plan_id=? AND task_id IS NOT NULL').all(id))this.object('task',t.task_id,principal,seen);
      for(const d of this.db.prepare(`SELECT d.depends_on FROM plan_task_deps d WHERE d.plan_id=? AND NOT EXISTS(
        SELECT 1 FROM plan_tasks p WHERE p.plan_id=d.plan_id AND p.version=d.version AND p.ref=d.depends_on AND p.change='add')`).all(id))this.object('task',d.depends_on,principal,seen);
    }
    if(kind==='task'){
      for(const d of this.db.prepare('SELECT depends_on_task_id FROM task_version_deps WHERE task_id=?').all(id))this.object('task',d.depends_on_task_id,principal,seen);
      for(const p of this.db.prepare('SELECT created_by_plan_id FROM task_versions WHERE task_id=?').all(id))this.object('plan',p.created_by_plan_id,principal,seen);
    }
    if(kind==='result'){
      for(const r of this.db.prepare('SELECT task_id FROM result_versions WHERE result_id=?').all(id))this.object('task',r.task_id,principal,seen);
      for(const a of this.db.prepare('SELECT task_id FROM acceptances WHERE result_id=?').all(id))this.object('task',a.task_id,principal,seen);
      for(const f of this.db.prepare('SELECT rel_path,sha256,size_bytes FROM result_files WHERE result_id=?').all(id)){
        const material=this.db.prepare('SELECT m.id,m.project_id,v.sha256,v.size FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.rel_path=?').get(f.rel_path);
        if(!material||material.project_id!==principal.projectId||material.sha256!==f.sha256||Number(material.size)!==f.size_bytes)unavailable();this.object('material',material.id,principal,seen);
      }
    }
  }
  references(value,principal,seen=new Set()){
    if(Array.isArray(value)){for(const item of value)this.references(item,principal,seen);return;}
    if(!value||typeof value!=='object')return;
    for(const [key,item]of Object.entries(value)){
      if(item!==null&&item!==undefined){
        if(key==='project_id'&&item!==principal.projectId)unavailable();
        const match=key.match(/^(material|analysis|plan|task|result)_id$/);
        if(match)this.object(match[1],item,principal,seen);
        if(key==='object_id'&&value.kind)this.object(value.kind==='plan_confirmation'?'plan':'result',item,principal,seen);
        if(key==='source_analysis_id')this.object('analysis',item,principal,seen);
      }
      this.references(item,principal,seen);
    }
  }
  validateInput(name,args,principal){
    this.scope(principal);
    const allowed=principal.channel==='dsh'?dshTools:principal.channel==='im-private'?privateImTools:new Set(['session_whoami']);
    if(!allowed.has(name))unavailable();
    this.references(args,principal);
    if(name.endsWith('_list')||['project_get','project_update_details','material_upload','analysis_begin','analysis_submit','plan_register','todo_unread','todo_mark_read'].includes(name)){
      if(name!=='project_list'&&args.project_id===undefined&&!['progress_list','result_list'].includes(name))unavailable();
    }
    if(name==='trace')this.object(args.object_type,args.object_id,principal);
    if(name==='todo_mark_read'){
      this.object(args.kind==='plan_confirmation'?'plan':'result',args.object_id,principal);
      if(!this.identities.roles(principal.account,principal.projectId).includes(args.role))unavailable();
    }
    if(name==='plan_register'||name==='plan_revise'){
      const refs=new Set((args.tasks??[]).filter(t=>t.change==='add').map(t=>t.ref));
      for(const task of args.tasks??[])for(const dep of task.depends_on??[])if(!refs.has(dep))this.object('task',dep,principal);
    }
    if(name==='plan_confirm'){
      const plan=this.services.plans.get(args.plan_id),project=this.services.projects.getWithRoles(principal.projectId);
      for(const role of plan.plan.relevantRoles){const account=project.roles.find(r=>r.role===role)?.member;if(account)this.identities.requireProject(account,principal.projectId);}
    }
    if(name==='result_submit'){
      // Result file descriptors reference trusted project material versions, never arbitrary rel_paths.
      for(const file of args.files??[]){
        const stored=this.db.prepare(`SELECT m.id,m.project_id,v.sha256,v.size FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.rel_path=?`).get(file.rel_path);
        if(!stored||stored.project_id!==principal.projectId||stored.sha256!==file.sha256||Number(stored.size)!==file.size_bytes)unavailable();
      }
    }
  }
  ownResult(name,result,principal){
    if(name==='todo_list')return {...result,todos:(result.todos??[]).filter(t=>t.member===principal.account),count:(result.todos??[]).filter(t=>t.member===principal.account).length};
    if(name==='notice_list')return {...result,notices:(result.notices??[]).filter(t=>t.member===principal.account),count:(result.notices??[]).filter(t=>t.member===principal.account).length};
    if(name==='todo_unread'){
      const own=new Set(this.identities.roles(principal.account,principal.projectId)),roles=(result.roles??[]).filter(r=>own.has(r.role));
      return {...result,roles,total_unread:roles.reduce((n,r)=>n+r.unread,0)};
    }
    return result;
  }
  imProjection(name,result){
    if(name==='project_list')return {...result,projects:(result.projects??[]).map(p=>({id:p.id,key:p.key,name:p.name,archived:p.archived}))};
    if(name==='project_get')return {ok:result.ok,project:{project_id:result.project?.id,key:result.project?.key,name:result.project?.name,archived:result.project?.archived},
      active_plans:(result.active_plans??[]).map(p=>({plan_id:p.plan_id,version:p.version,title:p.title,activated_at:p.activated_at}))};
    if(name==='material_list')return {ok:result.ok,materials:(result.materials??[]).map(m=>({material_id:m.material_id,original_name:m.original_name,purpose:m.purpose,latest_version:m.latest_version,
      versions:(m.versions??[]).map(v=>({version:v.version,sha256:v.sha256,size:v.size,created_at:v.created_at}))}))};
    return result;
  }
  allows(principal,name){return (principal.channel==='dsh'?dshTools:principal.channel==='im-private'?privateImTools:new Set(['session_whoami'])).has(name);}
  transform(principal){
    return original=>({...original,execute:async(args,exec)=>{
      try{
        let operation;
        inTransaction(this.db,()=>{
          this.validateInput(original.name,args,principal);
          const own=this.identities.roles(principal.account,principal.projectId);
          if((original.name==='todo_list'||original.name==='notice_list')&&own.length===0){operation=Promise.resolve({ok:true,count:0,[original.name==='todo_list'?'todos':'notices']:[]});return;}
          const filtered=(original.name==='todo_list'||original.name==='notice_list')?{...args,roles:own}:args;
          // Existing business tool bodies call synchronous services before their first await.
          // This write lock covers qualification checks and that synchronous business commit.
          operation=original.execute(filtered,exec);
        });
        let result=await operation;
        this.scope(principal);
        if(principal.channel!=='dsh'&&result?.ok===false)return denied();
        if(result?.ok!==false){
          if(original.name==='project_list')result={...result,projects:(result.projects??[]).filter(p=>p.id===principal.projectId)};
          result=this.ownResult(original.name,result,principal);this.references(result,principal);
          if(principal.channel==='im-private')result=this.imProjection(original.name,result);
        }
        return result;
      }catch{return denied();}
    }});
  }
}
