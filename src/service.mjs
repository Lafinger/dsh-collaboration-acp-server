import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import { AccessError, requireText, textPrompt, ACP_PROTOCOL_VERSION, collaborationMeta, requireCollaborationVersion } from './protocol.mjs';
import { attachmentCapability, requireAttachmentCapability } from './attachment-protocol.mjs';
import { humanAuthorizationCapability, prepareHumanRequest } from './human-authorization.mjs';

export class AccessService {
  constructor({ authority, store, runtime, cwd, login, identities, projects,communication }) {
    this.authority = authority; this.store = store; this.runtime = runtime; this.cwd = resolve(cwd);
    this.login=login;this.identities=identities;this.projects=projects;this.communication=communication;
    this.connections = new Set(); this.sessions = new Map(); this.closing = false;
    this.onAuthorizationChange=({account,projectId})=>{for(const e of this.sessions.values())if((!account||e.connection?.identity?.account===account)&&(!projectId||e.principal?.projectId===projectId))e.controller?.abort();};
    this.onLoginRevoked=({loginId})=>{for(const c of this.connections)if(c.login?.loginId===loginId){c.login=null;for(const e of this.sessions.values())if(e.connection===c)e.controller?.abort();}};
    identities?.on('authorization-change',this.onAuthorizationChange);identities?.on('login-revoked',this.onLoginRevoked);
    this.authorizationMonitor=identities?setInterval(()=>{for(const e of this.sessions.values())if(e.controller)try{this.requireQualification(e.connection,e.id);}catch{e.controller.abort();}},1000):null;
    this.authorizationMonitor?.unref?.();
  }
  attach(peer) {
    const connection = { peer, identity: null, initialized: false, closed: false, id: randomUUID() };
    connection.authTimer = setTimeout(() => peer.close(), 10000);
    connection.authTimer.unref?.();
    this.connections.add(connection);
    peer.on('message', message => {
      void this.dispatch(connection, message.method, message.params ?? {}).then(
        result => peer.result(message.id, result), error => peer.error(message.id, error),
      ).catch(() => peer.close());
    });
    peer.on('disconnected', () => { void this.disconnect(connection); });
    return connection;
  }
  requireIdentity(c) {
    if (c.closed || this.closing) throw new AccessError(-32001, 'Connection closed');
    if (!c.identity) throw new AccessError(-32003, 'Authenticated connector required');
    return c.identity;
  }
  requireBusinessIdentity(c) {
    const identity=this.requireIdentity(c);
    if(this.login){if(!c.login)throw new AccessError(-32003,'DingTalk device login required');this.identities.requireLogin(c.login);}
    return identity;
  }
  requireScope(c,id) {
    const scope=this.store.scope(id);
    if(this.login){
      if(!scope?.project_id)throw new AccessError(-32004,'Legacy unscoped conversation is read-only; start a project-bound conversation');
      const participant=this.identities.requireProject(this.requireBusinessIdentity(c).account,scope.project_id);
      if(scope.epoch!==this.identities.epoch||scope.participant_revision!==participant.revision||scope.member_revision!==this.identities.requireMember(c.identity.account).revision)throw new AccessError(-32004,'Conversation qualification changed; start a new project context');
    }
    return scope;
  }
  requireQualification(c,id) {
    // Stable qualification only. The organization re-verification lease is a freshness signal enforced
    // where business commits happen; it is not a revocation. Treating a lapsed lease as one aborted
    // turns that were still legitimately authorized, which surfaced to callers as a silent cancel.
    // Real revocations still trip here: account disablement, organization subject change, member or
    // participant revision, epoch rollover, login revocation and expiry.
    const scope=this.store.scope(id);
    if(this.login){
      if(!scope?.project_id)throw new AccessError(-32004,'Legacy unscoped conversation is read-only; start a project-bound conversation');
      const identity=this.requireIdentity(c);
      if(!c.login)throw new AccessError(-32003,'DingTalk device login required');
      this.identities.requireLoginLink(c.login);
      const participant=this.identities.requireProjectLink(identity.account,scope.project_id);
      if(scope.epoch!==this.identities.epoch||scope.participant_revision!==participant.revision||scope.member_revision!==this.identities.requireMemberLink(identity.account).revision)throw new AccessError(-32004,'Conversation qualification changed; start a new project context');
    }
    return scope;
  }
  requireSession(c, id) {
    this.store.requireOwner(id, this.requireBusinessIdentity(c).account);
    this.requireScope(c,id);
    const entry = this.sessions.get(id);
    if (!entry || entry.connection !== c) throw new AccessError(-32006, 'Restore this session before using it');
    return entry;
  }
  async dispatch(c, method, p) {
    if (method === 'collaboration/connect') {
      if (c.closed || c.identity || this.closing) throw new AccessError(-32003, 'Connection already bound or closed');
      requireCollaborationVersion(p);
      c.identity = this.authority.verify(p.ticket); clearTimeout(c.authTimer);
      return { ...c.identity, connectionId: c.id, runtimePid: process.pid, _meta: collaborationMeta() };
    }
    const identity = this.requireIdentity(c);
    if (method === 'initialize') {
      c.initialized = false;
      requireCollaborationVersion(p);
      if (p.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AccessError(-32011, 'Unsupported ACP-shaped base protocol version');
      c.attachmentTransfer = null;
      if (p.clientCapabilities?.attachmentTransfer !== undefined) { requireAttachmentCapability(p.clientCapabilities.attachmentTransfer); c.attachmentTransfer = attachmentCapability(); }
      c.humanAuthorization = null;
      if (p.clientCapabilities?.humanAuthorization !== undefined) { if(p.clientCapabilities.humanAuthorization?.version!==3)throw new AccessError(-32012,'Unsupported human authorization capability'); c.humanAuthorization=humanAuthorizationCapability(); }
      c.initialized = true;
      return { protocolVersion: ACP_PROTOCOL_VERSION, _meta: collaborationMeta(), agentInfo: { name: 'dsh-collaboration-acp-server', version },
        agentCapabilities: { ...(c.humanAuthorization ? {humanAuthorization:humanAuthorizationCapability()}:{}), loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} }, promptCapabilities: { image: false }, ...(c.attachmentTransfer && this.runtime.attachments ? { attachmentTransfer: attachmentCapability() } : {}) }, authMethods: this.login?[{id:'dingtalk-device',name:'钉钉扫码认证',description:'SSH transport identity alone does not authorize business access'}]:[] };

    }
    if (!c.initialized) throw new AccessError(-32600, 'Initialize first');
    if(this.login){
      if(method==='collaboration/login/start')return this.login.start(identity.account,p.deviceId,p.proof);
      if(method==='collaboration/login/claim')return this.login.claim(identity.account,p);
      if(method==='collaboration/login/authenticate'){
        c.login=await this.login.authenticate(identity.account,p);return {authenticated:true,...c.login};
      }
      if(method==='collaboration/login/logout'){
        if(p.token!==undefined)this.identities.revokeDevice(p.token,identity.account,p.deviceId);
        else if(c.login)this.identities.revokeLogin(c.login.loginId);c.login=null;return {authenticated:false};
      }
      if(method==='collaboration/login/status'){
        // Idle polling has to renew the organization re-verification lease. The client keeps this call
        // on a timer, so this is the one renewal opportunity that exists while a long turn is running;
        // renewing only on business writes let the lease expire underneath the turn. A fresh cache
        // needs nothing, so only a stale lease reaches the verifier.
        if(c.login&&(this.identities.member(identity.account)?.verified_until??0)<=this.identities.now())try{await this.login.refresh(identity.account);}catch{}
        try{this.requireBusinessIdentity(c);return {authenticated:true,account:identity.account,expiresAt:c.login.expiresAt,serviceId:identity.serviceId};}
        catch{return {authenticated:false,serviceId:identity.serviceId};}
      }
      if(c.login)await this.login.refresh(identity.account);
      this.requireBusinessIdentity(c);
    }
    if (method === 'collaboration/whoami') return { ...identity, runtimePid: process.pid, ...(this.login?{identitySource:'dingtalk',expiresAt:c.login.expiresAt}:{}) };
    if(method==='collaboration/projects'&&this.login)return {projects:this.identities.projects(identity.account).map(id=>this.projects.get(id))};
    if(this.communication&&method==='collaboration/communications'){
      const projectId=requireText(p.projectId,'projectId',200);return this.communication.store.history(identity.account,projectId,p.requestId);
    }
    if(this.communication&&method==='collaboration/communication/request'){
      const result=this.communication.store.create({account:identity.account,projectId:p.projectId,targetId:p.targetId,visibility:p.visibility,body:p.body,sourceId:requireText(p.requestId,'stable communication requestId',200)+':'+identity.account});this.communication.schedule();return result;
    }
    if(this.communication&&method==='collaboration/communication/reply'){
      const result=this.communication.store.reply({account:identity.account,projectId:p.projectId,requestId:p.requestId,body:p.body,sourceId:requireText(p.replyId,'stable communication replyId',200)+':'+identity.account});this.communication.schedule();return result;
    }
    if (method === 'collaboration/attachments/receipts') {
      const entry=this.requireSession(c,requireText(p.sessionId,'sessionId',200));
      if(!this.runtime.attachments)throw new AccessError(-32012,'Attachment receipts unavailable');
      const projectId=entry.principal?.projectId??this.store.scope(entry.id)?.project_id;
      if(!projectId)throw new AccessError(-32004,'旧会话没有项目范围，请开启项目会话后核对附件。');
      return this.runtime.attachments.listForClient(entry.id,identity.account,projectId);
    }
    if (method === 'session/new') {
      const id = randomUUID();let scope={};
      if(this.login){const projectId=requireText(p.projectId,'projectId',200),participant=this.identities.requireProject(identity.account,projectId);scope={projectId,participantRevision:participant.revision,memberRevision:this.identities.requireMember(identity.account).revision,epoch:this.identities.epoch};}
      if(!this.login&&p.projectId!==undefined){const projectId=requireText(p.projectId,'projectId',200);(this.projects??this.runtime.attachments?.projects)?.get(projectId);scope={projectId};}
      this.store.create(id, identity.account,scope);
      return this.open(c, id, false);
    }
    if (method === 'session/load' || method === 'session/resume') {
      requireText(p.sessionId, 'sessionId', 200); this.store.requireOwner(p.sessionId, identity.account);this.requireScope(c,p.sessionId);
      const prior = this.sessions.get(p.sessionId);
      if (prior?.connection) throw new AccessError(-32007, 'Session already attached; shared editing is not supported');
      if (prior?.drain) await prior.drain;
      if (prior && !prior.handle) throw new AccessError(-32007, 'Session activation is draining; try restoring later');
      this.requireIdentity(c);
      return this.open(c, p.sessionId, true);
    }
    if (method === 'session/list') return { sessions: this.store.list(identity.account).filter(row=>{if(!this.login||!row.projectId)return true;try{this.requireScope(c,row.sessionId);return true;}catch{return false;}}), nextCursor: null };
    if (method === 'collaboration/history') {
      this.store.requireOwner(p.sessionId, identity.account);
      if(this.store.scope(p.sessionId)?.project_id)this.requireScope(c,p.sessionId);
      if (p.after !== undefined && (!Number.isSafeInteger(p.after) || p.after < 0)) throw new AccessError(-32602, 'Invalid history cursor');
      return { events: this.store.events(p.sessionId, p.after ?? 0), status: this.store.status(p.sessionId) };
    }
    if (method === 'session/prompt') return this.prompt(c, p);
    if (method === 'session/cancel') { this.requireSession(c, p.sessionId).controller?.abort(); return {}; }
    if (method === 'session/close') { const e = this.requireSession(c, p.sessionId); await this.detach(e); return {}; }
    // No client-supplied MCP, mode/permission switching, filesystem, or terminal callbacks.
    throw new AccessError(-32601, `Unsupported prototype method: ${method}`);
  }
  async open(c, id, resume) {
    this.requireBusinessIdentity(c);const scope=this.requireScope(c,id);
    const principal=this.login?{account:c.identity.account,projectId:scope.project_id,channel:'dsh',login:c.login,participantRevision:scope.participant_revision,memberRevision:scope.member_revision,epoch:scope.epoch}:undefined;
    if (this.sessions.has(id)) throw new AccessError(-32007, 'Session is opening or draining');
    const e = { id, principal,connection: c, controller: null, running: null, drain: null, handle: null, activation: null };
    this.sessions.set(id, e);
    try {
      e.activation = this.runtime.open({ id, owner: c.identity.account, cwd: this.cwd, resume,principal });
      e.handle = await e.activation;
      if (c.closed || this.closing) { await this.detach(e); throw new AccessError(-32001, 'Connection closed during session activation'); }
      return { sessionId: id, cwd: this.cwd, _meta: { owner: c.identity.account, serviceId: c.identity.serviceId, status: this.store.status(id) } };
    } catch (error) {
      if (this.sessions.get(id) === e) this.sessions.delete(id);
      throw new AccessError(-32008, resume ? 'Session restore failed; no replacement session or history replay was performed' : 'Session creation failed', { cause: error.message });
    }
  }
  publish(e, update) {
    if(this.login&&e.connection){this.requireBusinessIdentity(e.connection);this.requireScope(e.connection,e.id);}
    const record = this.store.append(e.id, update);
    if (e.connection && !e.connection.closed && !e.connection.peer.closed) {
      try { e.connection.peer.notify('session/update', { sessionId: e.id, update, _meta: { sequence: record.seq } }); }
      catch { e.connection.peer.close(); }
    }
  }
  async prompt(c, p) {
    let e,text,requestId,manifests,humanRequest;
    const operationResults=[];
    try {
    e = this.requireSession(c, p.sessionId);
    if (e.running) throw new AccessError(-32007, 'A prompt is already running');
    text = textPrompt(p.prompt); requestId = requireText(p._meta?.requestId, 'requestId', 200);
    if(p._meta?.humanAuthorization!==undefined&&!c.humanAuthorization)throw new AccessError(-32012,'请先协商人类授权v3能力，再发送本次操作。');
    manifests = p._meta?.attachments;
    if (manifests !== undefined) {
      requireAttachmentCapability(c.attachmentTransfer);
      if (!this.runtime.attachments) throw new AccessError(-32012, 'Attachment transfer unavailable');
      if(this.login)for(const manifest of manifests)if(manifest.projectId!==e.principal.projectId)throw new AccessError(-32003,'Attachment project differs from the authenticated conversation');
    }
    const projectId=e.principal?.projectId??this.store.scope(e.id)?.project_id??manifests?.[0]?.projectId;
    // Bytes are pulled and persisted before the turn starts; a failure here rejects the prompt.
    if(manifests?.length){
      const controller=new AbortController();
      await this.runtime.attachments.ingest({sessionId:e.id,account:c.identity.account,requestId,projectId,manifests,read:params=>c.peer.request('collaboration/attachment/read',params,{timeoutMs:30000}),signal:controller.signal});
    }
    humanRequest=prepareHumanRequest({text,authorization:p._meta?.humanAuthorization,required:!!c.humanAuthorization,projectId,manifests:manifests??[],sessionId:e.id,account:c.identity.account,requestId});
    } catch(error) {
      const id=p._meta?.requestId,sessionId=p.sessionId;
      const ownedPrior=typeof sessionId==='string'&&typeof id==='string'&&this.store.owner(sessionId)===c.identity.account&&this.store.db.prepare('SELECT state FROM access_requests WHERE session_id=? AND request_id=?').get(sessionId,id);
      if(c.humanAuthorization?.version===3&&typeof id==='string'&&id.trim()&&id.length<=200&&!ownedPrior)throw new AccessError(error instanceof AccessError?error.code:-32602,error instanceof AccessError?error.message:'当前消息未通过校验，业务操作尚未开始。',{requestId:id,executionState:'not_started'});
      throw error;
    }
    this.store.begin(e.id, requestId); e.controller = new AbortController();
    // Mark running before publication, which can itself discover a disconnected/stalled consumer.
    e.running = Promise.resolve().then(() => {
      this.publish(e, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
      if (e.controller.signal.aborted) return { stopReason: 'cancelled' };
      return this.runtime.prompt(e.handle, text, e.controller.signal, update => this.publish(e, update), {...humanRequest,onOperation:result=>{
              if(operationResults.some(old=>old.kind===result.kind&&old.attachment_id===result.attachment_id))return;
              const record=Object.freeze({...result});operationResults.push(record);
              const name=`《${record.name}》`;
              const human=record.deduplicated?`${name}与已归档的第${record.version}版内容相同，未新增版本。`:`已将${name}归档为第${record.version}版。`;
              this.publish(e,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:human+'\n'},_meta:{requestId,operationResult:record}});
            },
        read: params => c.peer.request('collaboration/attachment/read', params, { timeoutMs: 30000 }),
      });
    });
    try {
      const result = await e.running;
      const reason = e.controller.signal.aborted ? 'cancelled' : result.stopReason;
      this.store.settle(e.id, requestId, reason === 'end_turn' ? 'completed' : reason);
      return { stopReason: reason };
    } catch (error) {
      this.store.settle(e.id, requestId, e.controller.signal.aborted ? 'cancelled' : 'unknown');
      if (e.controller.signal.aborted) return { stopReason: 'cancelled' };
      throw new AccessError(-32009, 'Prompt failed; some operations may already have committed. No automatic retry.', { cause: error.message,requestId,operationResults });
    } finally { e.running = null; e.controller = null; }
  }
  detach(e) {
    if (e.drain) return e.drain;
    e.connection = null; e.controller?.abort();
    e.drain = (async () => {
      try { await e.running; } catch { /* original prompt owns its result */ }
      if (e.handle) await this.runtime.close(e.handle);
    })().finally(() => { if (this.sessions.get(e.id) === e) this.sessions.delete(e.id); });
    return e.drain;
  }
  async disconnect(c) {
    if (c.closed) return;
    c.closed = true; clearTimeout(c.authTimer); this.connections.delete(c);
    const entries = [...this.sessions.values()].filter(e => e.connection === c);
    // Opens without handles finish their own activation cleanup; they are not claimable by another connection.
    for (const e of entries) if (!e.handle) e.connection = null;
    await Promise.allSettled(entries.filter(e => e.handle).map(e => this.detach(e)));
  }
  async close() {
    this.closing = true;
    clearInterval(this.authorizationMonitor);this.identities?.off('authorization-change',this.onAuthorizationChange);this.identities?.off('login-revoked',this.onLoginRevoked);
    for (const c of this.connections) c.peer.close();
    const entries = [...this.sessions.values()];
    await Promise.allSettled(entries.map(async e => {
      if (!e.handle && e.activation) { try { await e.activation; } catch { return; } }
      if (e.handle) await this.detach(e);
    }));
    await this.runtime.closeAll?.();
  }
}
