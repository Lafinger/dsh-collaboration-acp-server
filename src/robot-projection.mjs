import {projectRoleRevision} from './project-role-revision.mjs';
import {robotMetadataHash} from './robot-store.mjs';

export class RobotContextError extends Error{constructor(kind='stale-context'){super('Decision context unavailable');this.name='RobotContextError';this.kind=kind;}}
const unavailable=kind=>{throw new RobotContextError(kind);};
const compare=(a,b)=>a<b?-1:a>b?1:0;

/** Reads original saved facts only. A snapshot is NOT permission to execute a decision.
 * The executor must refresh original organization qualifications and revalidate under its write lock.
 */
export class RobotProjection{
  constructor({security,services,pilotAccounts}){this.security=security;this.db=security.db;this.services=services;this.pilots=new Set(pilotAccounts);}
  member(account){
    const member=this.security.member(account);
    if(!this.pilots.has(account)||!member||member.enabled!==1||member.corp_id!==this.security.corpId||member.client_id!==this.security.clientId)unavailable('member-unavailable');return member;
  }
  describe(address,account){
    const {projectId,kind,objectId,version,role}=address;
    if(!['plan_confirmation','result_review','result_acceptance','task_assignment'].includes(kind)||!Number.isSafeInteger(version)||version<1)unavailable();
    const member=this.member(account),project=this.services.projects.getWithRoles(projectId);
    if(project.archivedAt!==null||project.roles.find(row=>row.role===role)?.member!==account)unavailable();
    const versions=new Map(),taskCache=new Map();let taskId=null,taskVersion=null,upstreamTaskId=null,upstreamTaskVersion=null,peers=[],slot=null,display,pending=false,ownPlanEffects=null;
    const addTask=id=>{
      if(versions.has(id))return taskCache.get(id);
      if(versions.size>=1000)unavailable('context-too-large');
      const task=this.services.tasks.get(id);
      if(task.task.projectId!==projectId||task.task.cancelledAt!==null&&!(ownPlanEffects!==null&&task.task.cancelledByPlanId===ownPlanEffects))unavailable();
      versions.set(id,task.task.currentVersion);taskCache.set(id,task);
      for(const row of this.db.prepare('SELECT depends_on_task_id FROM task_version_deps WHERE task_id=? AND version=? ORDER BY position').all(id,task.task.currentVersion))addTask(row.depends_on_task_id);
      return task;
    };
    if(kind==='plan_confirmation'){
      const view=this.services.plans.get(objectId),plan=view.plan;
      if(plan.projectId!==projectId||plan.version!==version||['suspended','superseded'].includes(view.gate.kind))unavailable();
      slot=view.slots.find(row=>row.role===role&&row.voidedAt===null);if(!slot)unavailable();
      if(plan.activatedAt!==null)ownPlanEffects=plan.id;
      const additions=new Set(plan.tasks.filter(row=>row.change==='add').map(row=>row.ref));
      for(const proposal of plan.tasks){
        if(proposal.taskId){const target=addTask(proposal.taskId);if(plan.activatedAt===null&&(target.task.completedAt!==null||target.task.cancelledAt!==null))unavailable();}
        for(const dependency of proposal.dependsOn)if(!additions.has(dependency))addTask(dependency);
      }
      peers=plan.relevantRoles.map(peerRole=>{const peer=project.roles.find(row=>row.role===peerRole)?.member??null;return [peerRole,peer,peer===null?null:this.memberForPlan(peer).revision];}).sort((a,b)=>compare(a[0],b[0]));
      pending=slot.outcome===null&&plan.activatedAt===null;display={project,plan,slot};
    }else if(kind==='task_assignment'){
      const task=addTask(objectId);if(task.task.role!==role||task.task.currentVersion!==version)unavailable();
      taskId=objectId;taskVersion=version;pending=task.task.completedAt===null;display={project,task};
    }else{
      const row=this.db.prepare('SELECT task_id FROM result_versions WHERE result_id=? AND version=?').get(objectId,version);if(!row)unavailable();
      const upstream=addTask(row.task_id),results=this.services.results.resultsOf(row.task_id),result=results.find(item=>item.resultId===objectId&&item.version===version);
      if(!result||results.some(item=>item.version>version)||result.taskVersion!==upstream.task.currentVersion)unavailable();
      if(kind==='result_review'){
        slot=this.services.results.reviewOf(objectId,version);if(!slot||slot.role!==role||upstream.task.role!==role||address.taskId!==upstream.task.id)unavailable();
        taskId=upstream.task.id;taskVersion=upstream.task.currentVersion;pending=slot.outcome===null&&upstream.task.completedAt===null;display={project,task:upstream,result,slot};
      }else{
        const downstream=addTask(address.taskId);if(downstream.task.role!==role||downstream.task.id===upstream.task.id)unavailable();
        if(!this.db.prepare('SELECT 1 FROM task_version_deps WHERE task_id=? AND version=? AND depends_on_task_id=?').get(downstream.task.id,downstream.task.currentVersion,upstream.task.id))unavailable();
        slot=this.services.results.acceptancesOf(objectId,version).find(item=>item.taskId===downstream.task.id);if(!slot)unavailable();
        taskId=downstream.task.id;taskVersion=downstream.task.currentVersion;upstreamTaskId=upstream.task.id;upstreamTaskVersion=result.taskVersion;
        pending=slot.outcome===null&&downstream.task.completedAt===null;display={project,task:downstream,upstream,result,slot,review:this.services.results.reviewOf(objectId,version)};
      }
    }
    const binding={account,recipientUserId:member.user_id,memberRevision:member.revision,epoch:this.security.epoch,projectId,role,roleRevision:projectRoleRevision(this.security,this.services.projects,projectId),kind,objectId,version,taskId,taskVersion,upstreamTaskId,upstreamTaskVersion,peers,taskVersions:[...versions.entries()].sort((a,b)=>compare(a[0],b[0]))};
    return {account,binding,display,pending,outcome:slot?.outcome??null,decidedBy:slot?.submittedBy??null};
  }
  memberForPlan(account){const member=this.security.member(account);if(!member||member.enabled!==1||member.corp_id!==this.security.corpId||member.client_id!==this.security.clientId)unavailable('member-unavailable');return member;}
  validate(reference){
    if(!reference||reference.invalidated_at!==null)unavailable();
    const current=this.describe(reference.binding,reference.account),before=reference.binding;
    // Activation can legitimately apply this exact plan's proposed task changes. The immutable
    // pre-decision guards stay fixed; only its own authoritative activation ledger explains a move.
    if(before.kind==='plan_confirmation'&&current.display.plan.activatedAt!==null){
      if(robotMetadataHash({...before,taskVersions:[]})!==robotMetadataHash({...current.binding,taskVersions:[]}))unavailable();
      const effects=this.services.tasks.outcomesOf(before.objectId,before.version),byTask=new Map(effects.map(row=>[row.taskId,row]));
      for(const [id,oldVersion] of before.taskVersions){
        const task=this.services.tasks.get(id).task,effect=byTask.get(id),expected=effect?.change==='modify'?oldVersion+1:oldVersion;
        if(task.projectId!==before.projectId||task.currentVersion!==expected||effect&&effect.taskVersion!==expected||task.cancelledAt!==null&&!(effect?.change==='cancel'&&task.cancelledByPlanId===before.objectId))unavailable();
      }
      for(const effect of effects){const task=this.services.tasks.get(effect.taskId).task;if(task.currentVersion!==effect.taskVersion||task.cancelledAt!==null&&!(effect.change==='cancel'&&task.cancelledByPlanId===before.objectId))unavailable();}
    }else if(robotMetadataHash(before)!==robotMetadataHash(current.binding))unavailable();
    return current;
  }
  candidates(){
    const candidates=[];
    const add=(address,account)=>{if(!this.pilots.has(account))return;try{const value=this.describe(address,account);if(value.pending)candidates.push(value);}catch(error){if(!(error instanceof RobotContextError))throw error;}};
    for(const project of this.services.projects.list()){
      for(const todo of this.services.notices.todos({projectId:project.id}))if(todo.member)add(todo,todo.member);
      const roles=new Map(this.services.projects.getWithRoles(project.id).roles.map(row=>[row.role,row.member]));
      for(const {task} of this.services.tasks.listByProject(project.id))if(task.cancelledAt===null&&task.completedAt===null){const account=roles.get(task.role);if(account)add({kind:'task_assignment',projectId:project.id,objectId:task.id,version:task.currentVersion,role:task.role,taskId:task.id},account);}
    }
    return candidates;
  }
}
