import {createHash} from 'node:crypto';
import {projectRoleRevision} from './project-role-revision.mjs';
import {AccessService} from './service.mjs';
import {AccessError,requireText,requireCollaborationVersion,collaborationMeta,ACP_PROTOCOL_VERSION} from './protocol.mjs';
import {attachmentCapability,requireAttachmentCapability} from './attachment-protocol.mjs';
const deny=()=>{throw new AccessError(-32003,'当前登录没有管理员操作资格');};
const exact=(value,required,optional=[])=>value&&typeof value==='object'&&!Array.isArray(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));

/** Same business/session engine, but no unauthenticated connector identity or personal SSH ticket. */
export class MvpAccessService extends AccessService {
  attach(peer){const c=super.attach(peer);clearTimeout(c.authTimer);c.authTimer=setTimeout(()=>peer.close(),360000);c.authTimer.unref?.();return c;}
  async dispatch(c,method,p){
    const now=Date.now();if(!c.rate||c.rate.until<=now)c.rate={n:0,until:now+60000};
    if(++c.rate.n>600||(c.inFlight??0)>=16)throw new AccessError(-32007,'连接请求过多，请稍后显式查询');
    c.inFlight=(c.inFlight??0)+1;try{return await this.handle(c,method,p);}finally{c.inFlight--;}
  }
  async handle(c,method,p){
    if(c.closed||this.closing)throw new AccessError(-32001,'连接已关闭');
    if(method==='initialize'){
      requireCollaborationVersion(p);if(p.protocolVersion!==ACP_PROTOCOL_VERSION)throw new AccessError(-32011,'双端协议不匹配');
      if(c.initialized)throw new AccessError(-32600,'连接已初始化');
      c.attachmentTransfer=null;if(p.clientCapabilities?.attachmentTransfer!==undefined){requireAttachmentCapability(p.clientCapabilities.attachmentTransfer);if(this.runtime.attachments)c.attachmentTransfer=attachmentCapability();}
      c.initialized=true;return {protocolVersion:ACP_PROTOCOL_VERSION,_meta:collaborationMeta(),serviceId:this.identities.serviceId,agentInfo:{name:'dsh-collaboration-mvp',version:'0.6.0'},authMethods:[{id:'dingtalk-device',name:'电脑钉钉登录'}],agentCapabilities:{loadSession:true,...c.attachmentTransfer?{attachmentTransfer:c.attachmentTransfer}:{},mvpHttps:true}};
    }
    if(!c.initialized)throw new AccessError(-32600,'请先初始化连接');
    if(typeof method!=='string'||!p||typeof p!=='object'||Array.isArray(p))throw new AccessError(-32602,'请求格式不正确');
    if(method==='collaboration/login/start'){if(c.login)throw new AccessError(-32003,'请先退出当前设备再发起新登录');return this.login.start(null,p.deviceId,p.proof);}
    if(method==='collaboration/login/claim')return this.login.claim(null,p);
    if(method==='collaboration/login/authenticate'){
      const login=await this.login.authenticate(null,p);
      if(c.identity&&c.identity.account!==login.account)throw new AccessError(-32003,'连接不能换身份，请退出后新建连接');
      c.login=login;c.identity={account:login.account,serviceId:login.serviceId,name:login.name,administrator:login.administrator};clearTimeout(c.authTimer);
      return {authenticated:true,...login};
    }
    if(method==='collaboration/login/logout'){
      const result=this.login.logout(p);c.login=null;for(const e of this.sessions.values())if(e.connection===c)e.controller?.abort();return result;
    }
    if(method==='collaboration/login/status'){
      try{this.requireBusinessIdentity(c);return {authenticated:true,...c.identity,expiresAt:c.login.expiresAt};}catch{return {authenticated:false,serviceId:this.identities.serviceId};}
    }
    if(method==='collaboration/admin'){
      if(!c.login)deny();await this.login.refresh(c.identity.account);this.requireBusinessIdentity(c);this.identities.requireAdministrator(c.identity.account);
      return this.manage(c.identity.account,p,()=>this.requireBusinessIdentity(c));
    }
    // Legacy connector admission and browser-OAuth endpoints never exist on this service.
    if(method==='collaboration/connect'||method.startsWith('collaboration/communication'))throw new AccessError(-32601,'此MVP不提供该入口');
    return super.dispatch(c,method,p);
  }
  roleRevision(projectId){return projectRoleRevision(this.identities,this.projects,projectId);}
  adminView(account,projectId){
    this.identities.requireAdministrator(account);
    const members=this.identities.db.prepare('SELECT m.account,n.name FROM collaboration_members m LEFT JOIN mvp_member_names n ON n.account=m.account WHERE m.enabled=1 ORDER BY n.name,m.account').all().map(row=>({account:row.account,name:row.name??row.account}));
    const projects=this.projects.list().map(p=>({id:p.id,key:p.key,name:p.name}));
    return {members,projects,...projectId?{project:this.projects.getWithRoles(projectId),revision:this.roleRevision(projectId)}:{}};
  }
  async manage(account,p,guard=()=>{}){
    this.identities.requireAdministrator(account);guard();
    if(!p||typeof p!=='object'||Array.isArray(p))throw new AccessError(-32602,'管理请求格式不正确');
    if(exact(p,['action'],['projectId'])&&p.action==='view')return this.adminView(account,p.projectId);
    if(p.action==='role'&&p.account!==null)await this.login.refresh(p.account);
    const valid=p.action==='create'?exact(p,['action','commandId','key','name'],['background','goal']):p.action==='role'&&exact(p,['action','commandId','projectId','role','account','revision']);
    if(!valid)throw new AccessError(-32602,'仅支持创建项目与角色分配');
    requireText(p.commandId,'管理操作标识',100);
    const bodyHash=createHash('sha256').update(JSON.stringify(p)).digest('hex');
    return this.identities.transaction(()=>{
      this.identities.requireAdministrator(account);guard();
      const previous=this.identities.db.prepare('SELECT * FROM mvp_admin_commands WHERE id=?').get(p.commandId);
      if(previous){if(previous.account!==account||previous.body_hash!==bodyHash)deny();return JSON.parse(previous.result);}
      let result;
      if(p.action==='create'){
        const project=this.projects.create({key:p.key,name:p.name,...Object.hasOwn(p,'background')?{background:p.background}:{},...Object.hasOwn(p,'goal')?{goal:p.goal}:{}});
        result={ok:true,project};this.identities.audit(account,'project-create',project.id);
      }else{
        requireText(p.projectId,'项目',200);requireText(p.role,'职责',100);
        if(p.revision!==this.roleRevision(p.projectId))throw new AccessError(-32007,'角色安排已变化，请刷新后明确重新提交');
        if(p.account!==null)this.identities.requireMember(p.account);
        const previousMember=this.projects.getWithRoles(p.projectId).roles.find(r=>r.role===p.role)?.member;
        this.projects.setMember(p.projectId,p.role,p.account);
        if(previousMember!==p.account)this.identities.db.prepare('INSERT INTO mvp_project_revisions VALUES(?,2) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1').run(p.projectId);
        this.identities.audit(account,'role-assignment',JSON.stringify([p.projectId,p.role,p.account]));
        result={ok:true,project:this.projects.getWithRoles(p.projectId),revision:this.roleRevision(p.projectId)};
      }
      this.identities.db.prepare('INSERT INTO mvp_admin_commands VALUES(?,?,?,?)').run(p.commandId,account,bodyHash,JSON.stringify(result));return result;
    });
  }
}
