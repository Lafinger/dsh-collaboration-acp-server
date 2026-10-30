import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeSync, renameSync, readFileSync, existsSync, unlinkSync, readdirSync, lstatSync, realpathSync, fsyncSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { AccessError, requireText } from './protocol.mjs';
import { ATTACHMENT_CHUNK_BYTES, validateAttachmentManifest } from './attachment-protocol.mjs';
import { parseAttachment, PARSER_VERSION, rejectGifUpload } from './attachment-parser.mjs';
import {inTransaction} from '../business/lib/sqlite/schema.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
export class AttachmentService {
  constructor({ db, root, materials, projects }) {
    this.db=db;this.root=resolve(root);this.materials=materials;this.projects=projects;this.turns=new Map();
    mkdirSync(this.root,{recursive:true,mode:0o700});
    if(lstatSync(this.root).isSymbolicLink()||realpathSync(this.root)!==this.root)throw new Error('Private attachment root must not be a filesystem link');
    // A new service starts with no live uploads. Delete only verified owned crash-partial leaves.
    for(const name of readdirSync(this.root))if(/^[a-f0-9]{64}\.partial$/.test(name)){const path=resolve(this.root,name);if(relative(this.root,path)!==name||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw new Error('Unsafe crash-partial cleanup target');unlinkSync(path);}
    // Session-scoped attachment inventory: bytes are ingested at prompt time; the model reads
    // or archives through tools. Old receipt/grant tables are historical and stay untouched.
    db.exec(`CREATE TABLE IF NOT EXISTS session_attachments (
      attachment_id TEXT PRIMARY KEY, account TEXT NOT NULL, session_id TEXT NOT NULL, handle TEXT NOT NULL,
      request_id TEXT NOT NULL, project_id TEXT NOT NULL,
      manifest TEXT NOT NULL, filename TEXT NOT NULL, parsed TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(account,session_id,handle));
      CREATE TABLE IF NOT EXISTS material_extractions (
      material_id TEXT NOT NULL, version INTEGER NOT NULL, source_sha256 TEXT NOT NULL, parsed TEXT NOT NULL,
      PRIMARY KEY(material_id,version));`);
  }
  /** Per-turn context keyed by session: the running prompt owns progress messages and the session-bound project. */
  beginTurn(request,signal){
    const key=String(request.sessionId);
    if(this.turns.has(key))throw new AccessError(-32007,'A prompt is already running');
    const turn={...request,signal};this.turns.set(key,turn);
    return()=>{if(this.turns.get(key)===turn)this.turns.delete(key);};
  }
  turnOf(sessionId,account){const turn=this.turns.get(String(sessionId));return turn&&turn.account===account&&!turn.signal.aborted?turn:undefined;}
  /** Pull and persist bytes for every manifest item before the turn starts. Idempotent per
   * (account,session,handle); a sha256 change replaces the stored original. */
  async ingest(request){
    const signal=request.signal??new AbortController().signal;
    validateAttachmentManifest(request.manifests);
    for(const manifest of request.manifests)this.projects.get(manifest.projectId);
    for(const manifest of request.manifests)await this.store({...request,signal},manifest);
  }
  async store(request,manifest){
    const attachmentId=hash(Buffer.from(`${request.account}\0${request.sessionId}\0${manifest.handle}`));
    const existing=this.db.prepare('SELECT * FROM session_attachments WHERE attachment_id=?').get(attachmentId);
    if(existing&&JSON.parse(existing.manifest).sha256===manifest.sha256)return existing;
    const temp=join(this.root,`${manifest.handle}.partial`),target=join(this.root,`${attachmentId}.bin`);
    let fd,committed=false;
    try{
      fd=openSync(temp,'wx',0o600);let offset=0;const digest=createHash('sha256');
      while(offset<manifest.bytes){
        if(request.signal.aborted)throw new AccessError(-32010,'Attachment upload cancelled');
        const chunk=await request.read({sessionId:request.sessionId,requestId:request.requestId,handle:manifest.handle,offset,maxBytes:Math.min(ATTACHMENT_CHUNK_BYTES,manifest.bytes-offset)});
        if(typeof chunk?.data!=='string'||chunk.data.length>Math.ceil(ATTACHMENT_CHUNK_BYTES/3)*4)throw new AccessError(-32602,'Attachment chunk too large');
        const bytes=Buffer.from(chunk.data,'base64');
        if(bytes.toString('base64')!==chunk.data||chunk.offset!==offset||chunk.bytes!==bytes.length||!bytes.length||bytes.length>ATTACHMENT_CHUNK_BYTES||offset+bytes.length>manifest.bytes||chunk.eof!==(offset+bytes.length===manifest.bytes))throw new AccessError(-32602,'Invalid attachment chunk offset/encoding/length');
        let written=0;while(written<bytes.length)written+=writeSync(fd,bytes,written,bytes.length-written);digest.update(bytes);offset+=bytes.length;
      }
      fsyncSync(fd);closeSync(fd);fd=undefined;
      const bytes=readFileSync(temp);
      if(digest.digest('hex')!==manifest.sha256||bytes.length!==manifest.bytes)throw new AccessError(-32602,'Attachment sha256 mismatch');
      rejectGifUpload(bytes,manifest.name);
      let parsed;
      try{parsed=await parseAttachment(bytes,manifest.name);}catch(error){parsed={kind:'unparsed',content:null,warnings:[error.message],originalSha256:manifest.sha256,textSha256:null,parserVersion:PARSER_VERSION,visualAnalysis:'not-performed',parseError:true};}
      if(request.signal.aborted)throw new AccessError(-32010,'Attachment upload cancelled');
      if(existing)this.remove(existing);
      inTransaction(this.db,()=>{
        this.db.prepare('INSERT INTO session_attachments(attachment_id,account,session_id,handle,request_id,project_id,manifest,filename,parsed,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(attachmentId,request.account,String(request.sessionId),manifest.handle,request.requestId,manifest.projectId,JSON.stringify(manifest),`${attachmentId}.bin`,JSON.stringify(parsed),new Date().toISOString());
      });
      renameSync(temp,target);committed=true;
      return this.row(attachmentId);
    }finally{
      if(fd!==undefined)closeSync(fd);
      for(const path of [temp,...(!committed&&!existing?[target]:[])]){
        if(!existsSync(path))continue;
        const rel=relative(this.root,resolve(path));if(!rel||rel.startsWith('..')||rel.includes('/')||rel.includes('\\'))throw new Error('Unsafe attachment cleanup target');unlinkSync(path);
      }
    }
  }
  remove(row){const path=join(this.root,row.filename);const rel=relative(this.root,resolve(path));if(!rel||rel.startsWith('..')||rel.includes('/')||rel.includes('\\')||lstatSync(path).isSymbolicLink())throw new Error('Unsafe attachment removal target');if(existsSync(path))unlinkSync(path);this.db.prepare('DELETE FROM session_attachments WHERE attachment_id=?').run(row.attachment_id);}
  row(attachmentId){return this.db.prepare('SELECT * FROM session_attachments WHERE attachment_id=?').get(attachmentId);}
  owned(sessionId,account,handle){
    if(typeof handle!=='string'||!/^[a-f0-9]{64}$/.test(handle))throw new AccessError(-32602,'Invalid attachment handle');
    const row=this.db.prepare('SELECT * FROM session_attachments WHERE attachment_id=? AND account=? AND session_id=?').get(hash(Buffer.from(`${account}\0${String(sessionId)}\0${handle}`)),account,String(sessionId));
    if(!row)throw new AccessError(-32013,'Attachment is not owned by this account/session; use a handle from the message attachment list');
    return row;
  }
  /** Attachment tools admit by session ownership; guards often call without args, the
   * per-call authorize hook re-validates the concrete handle at execution time. */
  allows(sessionId,account,name,args){
    if(name==='attachment_read'||name==='attachment_archive')return args?.handle===undefined?true:this.admits(sessionId,account,args.handle);
    return undefined;
  }
  admits(sessionId,account,handle){
    try{this.owned(sessionId,account,handle);return true;}catch{return false;}
  }
  async read(sessionId,account,handle){
    const row=this.owned(sessionId,account,handle),manifest=JSON.parse(row.manifest),parsed=JSON.parse(row.parsed);
    const bytes=readFileSync(join(this.root,row.filename));
    if(bytes.length!==manifest.bytes||hash(bytes)!==manifest.sha256)throw new AccessError(-32013,'Stored attachment integrity mismatch; re-attach the file');
    if(parsed.kind==='image')return this.vision?this.vision.inspect(sessionId,account,handle):{ok:true,handle,name:manifest.name,bytes:manifest.bytes,sha256:manifest.sha256,project_id:manifest.projectId,kind:'image',content:null,visualAnalysis:parsed.visualAnalysis};
    if(parsed.content===null)return {ok:true,handle,name:manifest.name,bytes:manifest.bytes,sha256:manifest.sha256,project_id:manifest.projectId,kind:'unparsed',content:null,warnings:parsed.warnings};
    if(Buffer.byteLength(parsed.content)>256*1024)throw new AccessError(-32602,'Attachment text exceeds the inline read limit; archive it and read through material tools');
    return {ok:true,handle,name:manifest.name,bytes:manifest.bytes,sha256:manifest.sha256,project_id:manifest.projectId,kind:'text',content:parsed.content};
  }
  /** Archive the stored original into the session-bound project as a material version.
   * Name defaults to the original filename; repeats create new versions via material rules. */
  archive(sessionId,account,{handle,purpose,role},authorize){
    const row=this.owned(sessionId,account,handle),manifest=JSON.parse(row.manifest),parsed=JSON.parse(row.parsed);
    const projectId=this.turnOf(sessionId,account)?.projectId??manifest.projectId;
    if(manifest.projectId!==projectId)throw new AccessError(-32013,'Attachment project differs from the session-bound project; cross-project archive is refused');
    requireText(purpose,'material purpose',200);
    if(role!==undefined&&!['pm','product','design','scenemodel','sceneart','data','frontend','backend','ue'].includes(role))throw new AccessError(-32602,'Role must be an allowed role or omitted for shared');
    const path=join(this.root,row.filename),bytes=readFileSync(path);
    if(bytes.length!==manifest.bytes||hash(bytes)!==manifest.sha256)throw new AccessError(-32013,'Received original integrity mismatch');
    const classification={purpose,role:role??null,source_kind:manifest.sourceKind,visual_analysis:parsed.visualAnalysis};
    const result=this.materials.upload({projectId:manifest.projectId,sourcePath:path,originalName:manifest.name,purpose,submittedBy:account,role},commit=>{
      authorize?.();
      const extraction=this.db.prepare('SELECT source_sha256 FROM material_extractions WHERE material_id=? AND version=?').get(commit.material.id,commit.version.version);
      if(extraction&&extraction.source_sha256!==manifest.sha256)throw new AccessError(-32602,'Existing extraction digest mismatch');
      if(!extraction)this.db.prepare('INSERT INTO material_extractions VALUES(?,?,?,?)').run(commit.material.id,commit.version.version,manifest.sha256,JSON.stringify(parsed));
    });
    if(result.deduplicated){classification.role=result.material.role??classification.role??null;}
    this.turnOf(sessionId,account)?.onOperation?.({kind:'material_archive',attachment_id:row.attachment_id,name:manifest.name,material_id:result.material.id,version:result.version.version,deduplicated:!!result.deduplicated});
    return {ok:true,handle,attachment_id:row.attachment_id,material_id:result.material.id,version:result.version.version,name:manifest.name,deduplicated:!!result.deduplicated,classification};
  }
  listForClient(sessionId,account,projectId){
    const rows=this.db.prepare('SELECT * FROM session_attachments WHERE account=? AND session_id=? ORDER BY created_at DESC LIMIT 100').all(account,String(sessionId));
    return {ok:true,attachments:rows.filter(row=>!projectId||row.project_id===projectId).map(row=>{const m=JSON.parse(row.manifest);return {attachmentId:m.handle,name:m.name,projectId:row.project_id,requestId:row.request_id};}),limit:100};
  }
  /** Session-persisted inventory injected into each human message so the model can name handles. */
  inventory(sessionId,account){
    return this.db.prepare('SELECT handle,manifest FROM session_attachments WHERE account=? AND session_id=? ORDER BY created_at LIMIT 100').all(account,String(sessionId)).map(row=>({handle:row.handle,name:JSON.parse(row.manifest).name}));
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
