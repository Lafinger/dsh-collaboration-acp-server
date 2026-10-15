import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeSync, renameSync, readFileSync, existsSync, unlinkSync, readdirSync, lstatSync, realpathSync, fsyncSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { AccessError, requireText } from './protocol.mjs';
import { ATTACHMENT_CHUNK_BYTES, validateAttachmentManifest } from './attachment-protocol.mjs';
import { parseAttachment, PARSER_VERSION } from './attachment-parser.mjs';
import {inTransaction} from '../business/lib/sqlite/schema.js';
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
      PRIMARY KEY(material_id,version));`);
  }
  validateHumanRequest(text,manifests){
    const operations=[...text.matchAll(/^附件操作\s*[:：]\s*(上传并归档|仅传输)\s*$/gmu)];
    if(operations.length!==1)throw new AccessError(-32602,'Explicit current human attachment operation line required');
    const projects=[...text.matchAll(/(?:project_id|项目ID|项目id)\s*[:：=]\s*([a-f0-9]{32})(?![a-f0-9])/gu)],project=projects.length===1?projects[0]:undefined;
    for(const item of manifests){if(item.projectId!==project?.[1])throw new AccessError(-32602,'Attachment project must match explicit human project_id');
      if(item.archiveAuthorized!==(operations[0][1]==='上传并归档'))throw new AccessError(-32602,'Human attachment operation does not match archive authorization');this.projects.get(item.projectId);}
  }
  bind(request,signal){validateAttachmentManifest(request.manifests);if(this.active.has(request.sessionId))throw new AccessError(-32007,'Attachment request already active');this.active.set(request.sessionId,{...request,signal});return()=>this.active.delete(request.sessionId);}
  notice(request){return '\n\n[协作服务已绑定当前消息的授权附件元数据（不是已读取内容）：'+JSON.stringify(request.manifests)+'。依次用 attachment_transfer、attachment_inspect、attachment_archive；只在 archiveAuthorized=true 时归档，role不确定归共享，未获视觉分析不能宣称看过图片。固定资料版本后使用analysis_begin/analysis_submit。不得读取其他本地文件、擅自分配人员或确认计划。]';}
  context(sessionId,account){const request=this.active.get(String(sessionId));if(!request||request.account!==account||request.signal.aborted)throw new AccessError(-32013,'Current authorized attachment request unavailable');return request;}
  receipt(sessionId,account,receiptId){
    const row=this.db.prepare('SELECT * FROM attachment_receipts WHERE receipt_id=? AND account=? AND session_id=?').get(receiptId,account,String(sessionId));
    if(!row)throw new AccessError(-32013,'Attachment receipt is not owned by this account/session');return row;
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
      const bytes=readFileSync(temp);let parsed;
      try{parsed=await parseAttachment(bytes,manifest.name);}catch(error){parsed={kind:'unparsed',content:null,warnings:[error.message],originalSha256:manifest.sha256,textSha256:null,parserVersion:PARSER_VERSION,visualAnalysis:'not-performed',parseError:true};}
      if(request.signal.aborted)throw new AccessError(-32010,'Attachment transfer cancelled');
      inTransaction(this.db,()=>{
      request.authorize?.();renameSync(temp,target);
      this.db.prepare('INSERT INTO attachment_receipts(receipt_id,account,session_id,request_id,handle,manifest,filename,parsed,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(receiptId,request.account,request.sessionId,request.requestId,manifest.handle,JSON.stringify(manifest),receiptId+'.bin',JSON.stringify(parsed),new Date().toISOString());
      });
      committed=true;return this.summary(this.receipt(request.sessionId,request.account,receiptId));
    }finally{
      if(fd!==undefined)closeSync(fd);
      // Both paths are deterministic leaves of this service-owned root, never tool-supplied paths.
      for(const path of [temp,...(!committed?[target]:[])]){const rel=relative(this.root,resolve(path));if(!rel||rel.startsWith('..')||rel.includes('/')||rel.includes('\\'))throw new Error('Unsafe attachment cleanup target');if(existsSync(path))unlinkSync(path);}
    }
  }
  summary(row){const manifest=JSON.parse(row.manifest),parsed=JSON.parse(row.parsed);return {ok:true,receipt_id:row.receipt_id,name:manifest.name,bytes:manifest.bytes,sha256:manifest.sha256,project_id:manifest.projectId,archive_authorized:manifest.archiveAuthorized,source_kind:manifest.sourceKind,parse_status:parsed.parseError?'unparsed':parsed.content===null?'no-text':'text-extracted',parser_version:parsed.parserVersion,warnings:parsed.warnings,material_id:row.material_id??null,version:row.version??null};}
  list(sessionId,account){return {ok:true,receipts:this.db.prepare('SELECT * FROM attachment_receipts WHERE account=? AND session_id=? ORDER BY created_at DESC LIMIT 100').all(account,String(sessionId)).map(row=>this.summary(row)),limit:100};}
  inspect(sessionId,account,receiptId){const row=this.receipt(sessionId,account,receiptId),manifest=JSON.parse(row.manifest),parsed=JSON.parse(row.parsed);const bytes=readFileSync(join(this.root,row.filename));if(hash(bytes)!==manifest.sha256||bytes.length!==manifest.bytes||parsed.originalSha256!==manifest.sha256||(parsed.content!==null&&hash(Buffer.from(parsed.content))!==parsed.textSha256))throw new AccessError(-32602,'Attachment original/parsed integrity mismatch');return {...this.summary(row),parsed};}
  archive(sessionId,account,{receiptId,purpose,role,reason},authorize){
    const row=this.receipt(sessionId,account,receiptId),manifest=JSON.parse(row.manifest),parsed=JSON.parse(row.parsed);
    // Durable authorized receipt may be explicitly consumed after reconnect, but never in another session/account/project.
    if(!manifest.archiveAuthorized)throw new AccessError(-32013,'Human authorized transfer only, not material archive');
    if(row.material_id)return {...this.summary(row),already_archived:true,classification:JSON.parse(row.classification)};
    this.inspect(sessionId,account,receiptId);
    requireText(purpose,'material purpose',200);requireText(reason,'classification reason',2000);
    if(role!==undefined&&!['pm','product','design','scenemodel','sceneart','data','frontend','backend','ue'].includes(role))throw new AccessError(-32602,'Role must be an allowed role or omitted for shared');
    const path=join(this.root,row.filename),bytes=readFileSync(path);if(bytes.length!==manifest.bytes||hash(bytes)!==manifest.sha256)throw new AccessError(-32602,'Received original integrity mismatch');
    const classification={purpose,role:role??null,reason,source_kind:manifest.sourceKind,visual_analysis:parsed.visualAnalysis};
    const result=this.materials.upload({projectId:manifest.projectId,sourcePath:path,originalName:manifest.name,purpose,submittedBy:account,role},result=>{
      authorize?.();classification.role=result.material.role;
      this.db.prepare('INSERT INTO material_extractions VALUES(?,?,?,?)').run(result.material.id,result.version.version,manifest.sha256,JSON.stringify(parsed));
      this.db.prepare('UPDATE attachment_receipts SET material_id=?,version=?,classification=? WHERE receipt_id=?').run(result.material.id,result.version.version,JSON.stringify(classification),row.receipt_id);
    });
    return {...this.summary(this.receipt(sessionId,account,receiptId)),already_archived:false,classification,stored_at:result.absolutePath,next_time_reference_this:{material_id:result.material.id,version:result.version.version}};
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
