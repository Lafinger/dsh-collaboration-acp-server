import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeSync, renameSync, readFileSync, existsSync, unlinkSync, readdirSync, lstatSync, realpathSync, fsyncSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { AccessError, requireText } from './protocol.mjs';
import { ATTACHMENT_CHUNK_BYTES, validateAttachmentManifest } from './attachment-protocol.mjs';
import { parseAttachment, PARSER_VERSION, rejectGifUpload } from './attachment-parser.mjs';
import {inTransaction} from '../business/lib/sqlite/schema.js';
import {allowsHumanTool,READ_ONLY_TOOLS} from './human-authorization.mjs';
import {currentHumanInstruction,classifyHumanIntent} from './human-intent.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export class AttachmentService {
  constructor({ db, root, materials, projects }) {
    this.db=db;this.root=resolve(root);this.materials=materials;this.projects=projects;this.active=new Map();this.transfers=new Map();
    mkdirSync(this.root,{recursive:true,mode:0o700});
    if(lstatSync(this.root).isSymbolicLink()||realpathSync(this.root)!==this.root)throw new Error('Private attachment root must not be a filesystem link');
    // A new service starts with no live transfers. Delete only verified owned crash-partial leaves.
    for(const name of readdirSync(this.root))if(/^[a-f0-9]{64}\.partial$/.test(name)){const path=resolve(this.root,name);if(relative(this.root,path)!==name||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw new Error('Unsafe crash-partial cleanup target');unlinkSync(path);}
    db.exec(`CREATE TABLE IF NOT EXISTS attachment_receipts (
      receipt_id TEXT PRIMARY KEY, account TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
      handle TEXT NOT NULL, manifest TEXT NOT NULL, filename TEXT NOT NULL, parsed TEXT NOT NULL,
      material_id TEXT, version INTEGER, classification TEXT, created_at TEXT NOT NULL,
      UNIQUE(account,session_id,request_id,handle));
      CREATE TABLE IF NOT EXISTS material_extractions (
      material_id TEXT NOT NULL, version INTEGER NOT NULL, source_sha256 TEXT NOT NULL, parsed TEXT NOT NULL,
      PRIMARY KEY(material_id,version));
      CREATE TABLE IF NOT EXISTS attachment_human_grants (grant_id TEXT PRIMARY KEY, account TEXT NOT NULL,session_id TEXT NOT NULL,project_id TEXT NOT NULL,request_id TEXT NOT NULL,message_id TEXT NOT NULL,text_sha256 TEXT NOT NULL,receipt_id TEXT NOT NULL,action TEXT NOT NULL,scope_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(account,session_id,request_id,receipt_id));
      CREATE TABLE IF NOT EXISTS attachment_restore_proposals (proposal_id TEXT PRIMARY KEY,account TEXT NOT NULL,session_id TEXT NOT NULL,project_id TEXT NOT NULL,receipt_id TEXT NOT NULL,target_material_id TEXT NOT NULL,restore_version INTEGER NOT NULL,expected_latest_version INTEGER NOT NULL,source_request_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','consumed','superseded')));
      CREATE TRIGGER IF NOT EXISTS attachment_grants_no_update BEFORE UPDATE ON attachment_human_grants BEGIN SELECT RAISE(ABORT,'Human grants are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS attachment_grants_no_delete BEFORE DELETE ON attachment_human_grants BEGIN SELECT RAISE(ABORT,'Human grants are immutable'); END;`);
  }
  validateHumanRequest(text,manifests){
    const intent=classifyHumanIntent(text);text=currentHumanInstruction(text);
    if(intent.kind==='clarify'||/(?:不要|别|不必|无需|先不|暂不)[^。！？；\n]{0,8}(?:执行|操作|处理)/u.test(text))throw new AccessError(-32602,'当前消息没有明确授权附件操作');
    const operations=[...text.matchAll(/^附件操作\s*[:：]\s*(上传并归档|仅传输)\s*$/gmu)];
    if(operations.length!==1)throw new AccessError(-32602,'Explicit current human attachment operation line required');
    const projects=[...text.matchAll(/(?:project_id|项目ID|项目id)\s*[:：=]\s*([a-f0-9]{32})(?![a-f0-9])/gu)],project=projects.length===1?projects[0]:undefined;
    for(const item of manifests){if(item.projectId!==project?.[1])throw new AccessError(-32602,'Attachment project must match explicit human project_id');
      if(item.archiveAuthorized!==(operations[0][1]==='上传并归档'))throw new AccessError(-32602,'Human attachment operation does not match archive authorization');this.projects.get(item.projectId);}
  }
  bind(request,signal){
    validateAttachmentManifest(request.manifests);if(this.active.has(String(request.sessionId)))throw new AccessError(-32007,'Attachment request already active');
    const grants=new Map();
    for(const scope of request.receiptScopes??[])grants.set(scope.receiptId,scope);
    for(const scope of request.attachmentScopes??[])if(scope.action==='archive'){const receiptId=hash(Buffer.from(`${request.account}\0${request.sessionId}\0${request.requestId}\0${scope.handle}`));grants.set(receiptId,Object.freeze({receiptId,action:'archive',...request.attachmentTargets?.[scope.handle]}));}
    inTransaction(this.db,()=>{
      const kept=new Set((request.receiptScopes??[]).filter(s=>s.restoreVersion!==undefined).map(s=>s.receiptId));
      for(const pending of this.db.prepare("SELECT proposal_id,receipt_id FROM attachment_restore_proposals WHERE account=? AND session_id=? AND status='pending'").all(request.account,String(request.sessionId)))if(!kept.has(pending.receipt_id))this.db.prepare("UPDATE attachment_restore_proposals SET status='superseded' WHERE proposal_id=?").run(pending.proposal_id);
      for(const [id,scope]of grants){const scopeJson=JSON.stringify(scope),grantId=hash(Buffer.from(`${request.account}\0${request.sessionId}\0${request.requestId}\0${id}`));this.db.prepare('INSERT OR IGNORE INTO attachment_human_grants VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(grantId,request.account,String(request.sessionId),request.projectId,request.requestId,request.messageId,request.textSha256,id,'archive',scopeJson,new Date().toISOString());const saved=this.db.prepare('SELECT * FROM attachment_human_grants WHERE grant_id=?').get(grantId);if(saved.scope_json!==scopeJson||saved.message_id!==request.messageId||saved.text_sha256!==request.textSha256)throw new AccessError(-32013,'Immutable human grant conflicts with this request');}});
    const active={...request,grants,signal};this.active.set(String(request.sessionId),active);return()=>{if(this.active.get(String(request.sessionId))===active)this.active.delete(String(request.sessionId));};
  }
  allows(sessionId,account,name,args){
    const request=this.active.get(String(sessionId));
    if(name==='attachment_transfer')return !!request&&request.account===account&&!request.signal.aborted&&(request.attachmentScopes??[]).some(s=>(args===undefined||s.handle===args.handle)&&['transfer','archive'].includes(s.action));
    if(name==='attachment_archive')return !!request&&request.account===account&&!request.signal.aborted&&(args===undefined?request.grants.size>0:request.grants.has(args.receipt_id));
    return allowsHumanTool(request?.account===account&&!request.signal.aborted?request:undefined,name);
  }
  resolveMaterialTargets(text,manifests,projectId){
    const eligible=manifests.filter(m=>m.archiveAuthorized),command=currentHumanInstruction(text);
    if(!eligible.length||!/(?:作为|追加到)[^，,。！？；;\n]{0,100}(?:新版本|新版)/u.test(command))return Object.freeze({});
    if(eligible.length!==1)throw new AccessError(-32602,'请分别明确每份附件要追加的资料；未猜测整批版本目标。');
    const materials=this.db.prepare('SELECT id,original_name,purpose FROM materials WHERE project_id=?').all(projectId);
    const labels=materials.flatMap(m=>[m.original_name,m.purpose]),instruction=currentHumanInstruction(text,labels);
    const name=/(?:作为|追加到)\s*([^，,。！？；;\n]+?)\s*(?:的)?(?:新版本|新版)/u.exec(instruction)?.[1]?.trim();
    let candidates=materials.filter(m=>m.original_name===name);
    if(candidates.length>1){const purpose=/(?:用途\s*[:：为是]\s*)([^，,。！？；;\n）)]+)/u.exec(instruction)?.[1]?.trim();if(purpose)candidates=candidates.filter(m=>m.purpose===purpose);}
    if(candidates.length!==1)throw new AccessError(-32602,'没有唯一确定的目标资料，请明确资料原名和用途；未按相似文件名或v2字样合并。');
    const target=candidates[0],latest=this.db.prepare('SELECT MAX(version) n FROM material_versions WHERE material_id=?').get(target.id)?.n;
    if(!Number.isSafeInteger(latest)||latest<1)throw new AccessError(-32602,'目标资料没有可核实的当前版本。');
    return Object.freeze({[eligible[0].handle]:Object.freeze({targetMaterialId:target.id,expectedLatestVersion:latest})});
  }
  authorizeMaterialTargets(request,text){
    const receiptManifests=request.receiptScopes.filter(s=>s.restoreVersion===undefined).map(s=>({...JSON.parse(this.receipt(request.sessionId,request.account,s.receiptId).manifest),handle:s.receiptId,archiveAuthorized:true}));
    const bindings=this.resolveMaterialTargets(text,[...request.manifests,...receiptManifests],request.projectId);
    const receiptScopes=request.receiptScopes.map(scope=>{if(scope.restoreVersion!==undefined)return scope;const binding=bindings[scope.receiptId];if(scope.targetMaterialId!==undefined&&scope.targetMaterialId!==binding?.targetMaterialId||scope.expectedLatestVersion!==undefined&&scope.expectedLatestVersion!==binding?.expectedLatestVersion)throw new AccessError(-32013,'目标资料参数并非来自当前真人明确的唯一资料名。');return binding?Object.freeze({...scope,...binding}):scope;});
    return Object.freeze({...request,attachmentTargets:bindings,receiptScopes:Object.freeze(receiptScopes)});
  }
  archiveGrant(sessionId,account,receiptId,proposal){
    const request=this.context(sessionId,account),scope=request.grants?.get(receiptId);
    if(!scope)throw new AccessError(-32013,'当前消息未授权归档这份附件；不能使用先前回合许可。');
    for(const key of ['targetMaterialId','expectedLatestVersion','restoreVersion'])if(proposal[key]!==scope[key])throw new AccessError(-32013,'归档参数超出本次明确授权范围。');
    const persisted=this.db.prepare('SELECT scope_json FROM attachment_human_grants WHERE account=? AND session_id=? AND request_id=? AND receipt_id=?').get(account,String(sessionId),request.requestId,receiptId);
    if(!persisted||persisted.scope_json!==JSON.stringify(scope))throw new AccessError(-32013,'Current immutable human grant unavailable');
    return scope;
  }
  notice(request){if(!request.manifests.length)return '';return '\n\n[协作服务已绑定当前消息的授权附件元数据（不是已读取内容）：'+JSON.stringify(request.manifests)+'。依次用 attachment_transfer、attachment_inspect、attachment_archive；只在 archiveAuthorized=true 时归档，role不确定归共享，未获视觉分析不能宣称看过图片。可使用analysis_begin读取固定资料并整理为对话草稿；只有本轮明确提交分析才可使用analysis_submit正式登记。不得读取其他本地文件、擅自分配人员或确认计划。]';}
  context(sessionId,account){const request=this.active.get(String(sessionId));if(!request||request.account!==account||request.signal.aborted)throw new AccessError(-32013,'Current authorized attachment request unavailable');return request;}
  receipt(sessionId,account,receiptId){
    const row=this.db.prepare('SELECT * FROM attachment_receipts WHERE receipt_id=? AND account=? AND session_id=?').get(receiptId,account,String(sessionId));
    if(row)return row;
    // A handle is not a receipt id. A receipt only exists after attachment_transfer has
    // hash-verified the bytes, so passing a handle here means the transfer step was skipped.
    // Say so instead of the opaque ownership error, which invites blind retries.
    const pending=(this.active.get(String(sessionId))?.manifests??[]).some(item=>item.handle===receiptId);
    if(pending)throw new AccessError(-32013,'这是附件 handle，不是 receipt_id：请先调用 attachment_transfer（handle 原样传入）传输并校验，再用返回的 receipt_id 调用 attachment_inspect。');
    throw new AccessError(-32013,'Attachment receipt is not owned by this account/session');
  }
  async transfer(sessionId,account,handle,toolSignal,authorize){
    const request=this.context(sessionId,account),manifest=request.manifests.find(item=>item.handle===handle);
    if(!manifest)throw new AccessError(-32013,'Attachment handle not authorized for current request');
    const receiptId=hash(Buffer.from(`${account}\0${sessionId}\0${request.requestId}\0${handle}`));
    const previous=this.db.prepare('SELECT * FROM attachment_receipts WHERE receipt_id=?').get(receiptId);
    if(previous)return this.summary(previous);
    if(this.transfers.has(receiptId))return this.transfers.get(receiptId);
    const signal=toolSignal?AbortSignal.any([request.signal,toolSignal]):request.signal;
    const task=this.receive({...request,signal,authorize},manifest,receiptId).finally(()=>this.transfers.delete(receiptId));this.transfers.set(receiptId,task);return task;
  }
  async receive(request,manifest,receiptId){
    const target=join(this.root,receiptId+'.bin'),temp=join(this.root,receiptId+'.partial');let fd,committed=false;
    try{
      fd=openSync(temp,'wx',0o600);let offset=0;const digest=createHash('sha256');
      while(offset<manifest.bytes){
        if(request.signal.aborted)throw new AccessError(-32010,'Attachment transfer cancelled');
        const chunk=await request.read({sessionId:request.sessionId,requestId:request.requestId,handle:manifest.handle,offset,maxBytes:Math.min(ATTACHMENT_CHUNK_BYTES,manifest.bytes-offset)});
        if(typeof chunk?.data!=='string'||chunk.data.length>Math.ceil(ATTACHMENT_CHUNK_BYTES/3)*4)throw new AccessError(-32602,'Attachment chunk too large');
        const bytes=Buffer.from(chunk.data,'base64');
        if(bytes.toString('base64')!==chunk.data||chunk.offset!==offset||chunk.bytes!==bytes.length||!bytes.length||bytes.length>ATTACHMENT_CHUNK_BYTES||offset+bytes.length>manifest.bytes||chunk.eof!==(offset+bytes.length===manifest.bytes))throw new AccessError(-32602,'Invalid attachment chunk offset/encoding/length');
        let written=0;while(written<bytes.length)written+=writeSync(fd,bytes,written,bytes.length-written);digest.update(bytes);offset+=bytes.length;
      }
      fsyncSync(fd);closeSync(fd);fd=undefined;if(digest.digest('hex')!==manifest.sha256)throw new AccessError(-32602,'Attachment sha256 mismatch');
      const bytes=readFileSync(temp);rejectGifUpload(bytes,manifest.name);let parsed;
      try{parsed=await parseAttachment(bytes,manifest.name);}catch(error){parsed={kind:'unparsed',content:null,warnings:[error.message],originalSha256:manifest.sha256,textSha256:null,parserVersion:PARSER_VERSION,visualAnalysis:'not-performed',parseError:true};}
      if(request.signal.aborted)throw new AccessError(-32010,'Attachment transfer cancelled');
      inTransaction(this.db,()=>{
      request.authorize?.();renameSync(temp,target);
      this.db.prepare('INSERT INTO attachment_receipts(receipt_id,account,session_id,request_id,handle,manifest,filename,parsed,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(receiptId,request.account,request.sessionId,request.requestId,manifest.handle,JSON.stringify(manifest),receiptId+'.bin',JSON.stringify(parsed),new Date().toISOString());
      });
      committed=true;request.onOperation?.({kind:'attachment_transfer',receipt_id:receiptId,name:manifest.name});return this.summary(this.receipt(request.sessionId,request.account,receiptId));
    }finally{
      if(fd!==undefined)closeSync(fd);
      // Both paths are deterministic leaves of this service-owned root, never tool-supplied paths.
      for(const path of [temp,...(!committed?[target]:[])]){const rel=relative(this.root,resolve(path));if(!rel||rel.startsWith('..')||rel.includes('/')||rel.includes('\\'))throw new Error('Unsafe attachment cleanup target');if(existsSync(path))unlinkSync(path);}
    }
  }
  summary(row){const manifest=JSON.parse(row.manifest),parsed=JSON.parse(row.parsed),request=this.active.get(String(row.session_id)),grant=request?.account===row.account&&!request.signal.aborted?request.grants?.get(row.receipt_id):undefined;return {ok:true,archive_authorized_now:!!grant,...(grant?{current_archive_scope:{action:'archive',...(grant.targetMaterialId===undefined?{}:{target_material_id:grant.targetMaterialId}),...(grant.expectedLatestVersion===undefined?{}:{expected_latest_version:grant.expectedLatestVersion}),...(grant.restoreVersion===undefined?{}:{restore_version:grant.restoreVersion})}}:{}),receipt_id:row.receipt_id,name:manifest.name,bytes:manifest.bytes,sha256:manifest.sha256,project_id:manifest.projectId,archive_authorized:manifest.archiveAuthorized,source_kind:manifest.sourceKind,parse_status:parsed.parseError?'unparsed':parsed.content===null?'no-text':'text-extracted',parser_version:parsed.parserVersion,warnings:parsed.warnings,material_id:row.material_id??null,version:row.version??null};}
  list(sessionId,account,projectId){
    const candidate=this.active.get(String(sessionId)),request=candidate?.account===account&&!candidate.signal.aborted?candidate:undefined;
    const authorized_attachments=(request?.manifests??[]).filter(m=>!projectId||m.projectId===projectId).map(m=>({handle:m.handle,name:m.name,bytes:m.bytes,sha256:m.sha256,action:m.archiveAuthorized?'archive':'transfer'}));
    const receipts=this.db.prepare('SELECT * FROM attachment_receipts WHERE account=? AND session_id=? ORDER BY created_at DESC LIMIT 100').all(account,String(sessionId)).filter(row=>!projectId||JSON.parse(row.manifest).projectId===projectId).map(row=>{const grant=request?.grants.get(row.receipt_id);return {...this.summary(row),archive_authorized_now:!!grant,...(grant?{current_archive_scope:{action:'archive',...(grant.targetMaterialId===undefined?{}:{target_material_id:grant.targetMaterialId}),...(grant.expectedLatestVersion===undefined?{}:{expected_latest_version:grant.expectedLatestVersion}),...(grant.restoreVersion===undefined?{}:{restore_version:grant.restoreVersion})}}:{})};});
    return {ok:true,receipts,authorized_attachments,limit:100,next_step:authorized_attachments.length&&!receipts.length?'authorized_attachments 里的 handle 还不是 receipt：先对每个 handle 调用 attachment_transfer，拿到返回的 receipt_id 后再调用 attachment_inspect。':receipts.length?'receipts 里已有的 receipt_id 可直接用于 attachment_inspect。':'没有待处理的附件。'};
  }
  pendingRestores(sessionId,account,projectId){
    return this.db.prepare("SELECT p.*,r.manifest FROM attachment_restore_proposals p JOIN attachment_receipts r ON r.receipt_id=p.receipt_id AND r.account=p.account AND r.session_id=p.session_id WHERE p.account=? AND p.session_id=? AND p.project_id=? AND p.status='pending' AND p.expires_at>? AND r.material_id IS NULL AND (SELECT MAX(version) FROM material_versions WHERE material_id=p.target_material_id)=p.expected_latest_version ORDER BY p.created_at DESC LIMIT 100").all(account,String(sessionId),projectId,Date.now()).map(p=>({receiptId:p.receipt_id,name:JSON.parse(p.manifest).name,targetMaterialId:p.target_material_id,restoreVersion:p.restore_version,expectedLatestVersion:p.expected_latest_version}));
  }
  rememberRestore(request,receiptId,manifest,details){
    if(!details||!Number.isSafeInteger(details.historicalVersion)||!Number.isSafeInteger(details.latestVersion))throw new AccessError(-32602,'Historical confirmation evidence unavailable');
    const original=this.db.prepare('SELECT v.sha256 FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.material_id=? AND v.version=? AND m.project_id=?').get(details.materialId,details.historicalVersion,manifest.projectId);
    const latest=this.db.prepare('SELECT MAX(version) n FROM material_versions WHERE material_id=?').get(details.materialId)?.n;
    if(original?.sha256!==manifest.sha256||latest!==details.latestVersion)throw new AccessError(-32602,'Historical confirmation evidence changed');
    const id=hash(Buffer.from(`${request.account}\0${request.sessionId}\0${request.requestId}\0${receiptId}\0${details.materialId}\0${details.historicalVersion}\0${details.latestVersion}`)),now=Date.now();
    this.db.prepare('INSERT OR IGNORE INTO attachment_restore_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,request.account,String(request.sessionId),manifest.projectId,receiptId,details.materialId,details.historicalVersion,details.latestVersion,request.requestId,now,now+15*60*1000,'pending');
    request.onOperation?.({kind:'restore_confirmation_required',receipt_id:receiptId,name:manifest.name,material_id:details.materialId,restoreVersion:details.historicalVersion,expectedLatestVersion:details.latestVersion});
  }
  listForClient(sessionId,account,projectId){const pending=new Map(this.pendingRestores(sessionId,account,projectId).map(p=>[p.receiptId,p]));const rows=this.db.prepare('SELECT * FROM attachment_receipts WHERE account=? AND session_id=? ORDER BY created_at DESC LIMIT 100').all(account,String(sessionId));return {ok:true,receipts:rows.filter(row=>!projectId||JSON.parse(row.manifest).projectId===projectId).map(row=>{const m=JSON.parse(row.manifest);return {receiptId:row.receipt_id,name:m.name,projectId:m.projectId,requestId:row.request_id,archived:!!row.material_id,archiveAuthorized:m.archiveAuthorized,...(pending.has(row.receipt_id)?{pendingRestore:{targetMaterialId:pending.get(row.receipt_id).targetMaterialId,restoreVersion:pending.get(row.receipt_id).restoreVersion,expectedLatestVersion:pending.get(row.receipt_id).expectedLatestVersion}}:{}),...(row.material_id?{materialId:row.material_id,version:row.version}:{})};}),limit:100};}
  inspect(sessionId,account,receiptId){const row=this.receipt(sessionId,account,receiptId),manifest=JSON.parse(row.manifest),parsed=JSON.parse(row.parsed);const bytes=readFileSync(join(this.root,row.filename));if(hash(bytes)!==manifest.sha256||bytes.length!==manifest.bytes||parsed.originalSha256!==manifest.sha256||(parsed.content!==null&&hash(Buffer.from(parsed.content))!==parsed.textSha256))throw new AccessError(-32602,'Attachment original/parsed integrity mismatch');return {...this.summary(row),parsed};}
  archive(sessionId,account,{receiptId,purpose,role,reason,targetMaterialId,expectedLatestVersion,restoreVersion},authorize){
    const grant=this.archiveGrant(sessionId,account,receiptId,{targetMaterialId,expectedLatestVersion,restoreVersion});
    const row=this.receipt(sessionId,account,receiptId),manifest=JSON.parse(row.manifest),parsed=JSON.parse(row.parsed);
    // Durable authorized receipt may be explicitly consumed after reconnect, but never in another session/account/project.
    const request=this.context(sessionId,account);if(manifest.projectId!==request.projectId)throw new AccessError(-32013,'Attachment project differs from current human grant');
    if(row.material_id){request.onOperation?.({kind:'material_archive',receipt_id:receiptId,name:manifest.name,material_id:row.material_id,version:row.version,already_archived:true});return {...this.summary(row),already_archived:true,classification:JSON.parse(row.classification)};}
    this.inspect(sessionId,account,receiptId);
    requireText(purpose,'material purpose',200);requireText(reason,'classification reason',2000);
    // Exact identity only: a model-generated purpose is not authority to create a second material.
    const candidates=this.db.prepare('SELECT id,purpose FROM materials WHERE project_id=? AND original_name=?').all(manifest.projectId,manifest.name.trim());
    const instruction=currentHumanInstruction(request.humanText??''),dataText=currentHumanInstruction(request.humanText??'',[purpose,...candidates.map(m=>m.purpose)]);
    const explicitPurpose=/(?:用途|用作|用于|作为|另存|另建|单独保存)/u.test(instruction)&&dataText.includes(purpose);
    const separate=/(?:另存|另建|不同用途|换用途|更换用途|单独保存|单独归档)/u.test(instruction);
    if(targetMaterialId){const target=this.db.prepare('SELECT purpose FROM materials WHERE id=? AND project_id=?').get(targetMaterialId,manifest.projectId);if(!target)throw new AccessError(-32013,'目标资料不属于当前项目。');purpose=target.purpose;}
    else if(candidates.length===1&&!separate){if(explicitPurpose&&purpose!==candidates[0].purpose)throw new AccessError(-32602,'这份同名资料已有其他用途，请确认追加原资料还是另存为不同用途。');purpose=candidates[0].purpose;}
    else if(candidates.length>0&&!(explicitPurpose&&(separate||candidates.some(m=>m.purpose===purpose))))throw new AccessError(-32602,'同名资料的用途尚不明确，请指定要追加的资料或明确另存用途。');
    if(role!==undefined&&!['pm','product','design','scenemodel','sceneart','data','frontend','backend','ue'].includes(role))throw new AccessError(-32602,'Role must be an allowed role or omitted for shared');
    const path=join(this.root,row.filename),bytes=readFileSync(path);if(bytes.length!==manifest.bytes||hash(bytes)!==manifest.sha256)throw new AccessError(-32602,'Received original integrity mismatch');
    let classification={purpose,role:role??null,reason,source_kind:manifest.sourceKind,visual_analysis:parsed.visualAnalysis};
    let result;try{result=this.materials.upload({projectId:manifest.projectId,sourcePath:path,originalName:manifest.name,purpose,submittedBy:account,role,targetMaterialId,expectedLatestVersion,restoreVersion},result=>{
      authorize?.();
      classification.role=result.material.role??null;
      if(result.deduplicated){const prior=this.db.prepare('SELECT classification FROM attachment_receipts WHERE material_id=? AND version=? AND classification IS NOT NULL ORDER BY created_at LIMIT 1').get(result.material.id,result.version.version);if(prior)classification=JSON.parse(prior.classification);}
      const extraction=this.db.prepare('SELECT source_sha256 FROM material_extractions WHERE material_id=? AND version=?').get(result.material.id,result.version.version);
      if(extraction&&extraction.source_sha256!==manifest.sha256)throw new AccessError(-32602,'Existing extraction digest mismatch');
      if(!extraction)this.db.prepare('INSERT INTO material_extractions VALUES(?,?,?,?)').run(result.material.id,result.version.version,manifest.sha256,JSON.stringify(parsed));
      this.db.prepare('UPDATE attachment_receipts SET material_id=?,version=?,classification=? WHERE receipt_id=?').run(result.material.id,result.version.version,JSON.stringify(classification),row.receipt_id);
      this.db.prepare("UPDATE attachment_restore_proposals SET status='consumed' WHERE account=? AND session_id=? AND receipt_id=? AND status='pending'").run(account,String(sessionId),receiptId);
    },grant.restoreVersion===undefined?undefined:{restore:{materialId:grant.targetMaterialId,version:grant.restoreVersion,expectedLatestVersion:grant.expectedLatestVersion}});
    }catch(error){if(error.code==='MATERIAL_RESTORE_CONFIRMATION_REQUIRED'&&grant.restoreVersion===undefined)this.rememberRestore(request,receiptId,manifest,error.details);throw error;}
    request.onOperation?.({kind:'material_archive',receipt_id:receiptId,name:manifest.name,material_id:result.material.id,version:result.version.version,...(grant.restoreVersion===undefined?{}:{restoreVersion:grant.restoreVersion}),deduplicated:!!result.deduplicated,already_archived:false});
    return {...this.summary(this.receipt(sessionId,account,receiptId)),already_archived:false,deduplicated:!!result.deduplicated,classification,stored_at:result.absolutePath,next_time_reference_this:{material_id:result.material.id,version:result.version.version}};
  }
  materialContent(material,version){
    const row=this.db.prepare('SELECT * FROM material_extractions WHERE material_id=? AND version=?').get(material.id,version.version);if(!row)return undefined;
    if(row.source_sha256!==version.sha256)return {content:null,issue:'Parsed content source digest does not match immutable material version',warnings:[]};
    const path=this.materials.absolutePathOf(version.relPath);
    try { if (!existsSync(path) || hash(readFileSync(path)) !== version.sha256) return {content:null,issue:'Original material integrity mismatch or missing file',warnings:[]}; }
    catch { return {content:null,issue:'Original material could not be read for integrity verification',warnings:[]}; }
    const parsed=JSON.parse(row.parsed),warnings=parsed.warnings??[];
    if(parsed.content!==null && hash(Buffer.from(parsed.content))!==parsed.textSha256) return {content:null,issue:'Parsed text digest mismatch',warnings:[]};
    return {content:parsed.content,issue:parsed.content===null?(warnings.join('; ')||'No text available for this material'):null,warnings};
  }
}
