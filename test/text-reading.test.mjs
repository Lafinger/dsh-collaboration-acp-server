import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {parseAttachment,PARSER_VERSION} from '../src/attachment-parser.mjs';
import {AttachmentService} from '../src/attachment-service.mjs';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {MaterialService} from '../business/lib/service/material-service.js';
import {AnalysisService} from '../business/lib/service/analysis-service.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'collab-text-')),db=openDatabase({path:join(root,'db.sqlite')});
 const projects=new ProjectService(db),materials=new MaterialService(db,join(root,'files'));
 const service=new AttachmentService({db,root:join(root,'attachments'),projects,materials});
 materials.contentProvider=service.materialContent.bind(service);
 const project=projects.create({key:'TEXT',name:'Text fixture'});t.after(()=>db.close());
 return {root,db,projects,materials,service,project,analyses:new AnalysisService(db,materials)};
}
async function ingest(f,bytes,name='index.html',handle='a'.repeat(64)){
 const manifest={handle,name,bytes:bytes.length,sha256:hash(bytes),projectId:f.project.id,sourceKind:'file-attachment'};
 await f.service.ingest({sessionId:'s',requestId:'r',account:'alice',manifests:[manifest],read:async({offset,maxBytes})=>{const data=bytes.subarray(offset,offset+maxBytes);return {offset,bytes:data.length,data:data.toString('base64'),eof:offset+data.length===bytes.length};}});
 return manifest;
}
const read=(f,m)=>f.service.read('s','alice',m.handle);
const archive=(f,m)=>f.service.archive('s','alice',{handle:m.handle,purpose:'source'});
const ref=a=>({materialId:a.material_id,version:a.version});
function oldFailure(sha){return {kind:'unparsed',content:null,warnings:['Supported attachments: DOCX, UTF-8 MD/TXT'],originalSha256:sha,textSha256:null,parserVersion:'collaboration-attachment-parser/1.1.0',visualAnalysis:'not-performed',parseError:true};}
function legacyAttachment(f,m){f.db.prepare('UPDATE session_attachments SET parsed=? WHERE handle=?').run(JSON.stringify(oldFailure(m.sha256)),m.handle);}
function legacyMaterial(f,a,sha){f.db.prepare('UPDATE material_extractions SET parsed=? WHERE material_id=? AND version=?').run(JSON.stringify(oldFailure(sha)),a.material_id,a.version);}
function makeDocx(text){return Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types/>'),'word/document.xml':strToU8('<w:document xmlns:w="test"><w:body><w:p><w:r><w:t>'+text+'</w:t></w:r></w:p></w:body></w:document>')}));}

test('source text is suffix-independent, preserves scripts literally and decodes BOM UTF-16',async()=>{
 const source='<!doctype html>\n<script>globalThis.__must_not_execute__ = true;</script>\n中文\tEND';
 for(const name of ['index.html','x.css','x.js','x.json','x.xml','x.log','README','x.pdf'])assert.equal((await parseAttachment(Buffer.from(source),name)).content,source);
 assert.equal(globalThis.__must_not_execute__,undefined);
 const le=Buffer.from(source,'utf16le'),be=Buffer.from(le).swap16();
 for(const bytes of [Buffer.from('\uFEFF'+source),Buffer.concat([Buffer.from([0xff,0xfe]),le]),Buffer.concat([Buffer.from([0xfe,0xff]),be])])assert.equal((await parseAttachment(bytes,'index.html')).content,source);
 for(const bytes of [Buffer.from([0x61,0,0x62]),Buffer.from([1,2,3]),Buffer.from([0xff]),Buffer.from('a\u0085b'),Buffer.from([0xff,0xfe,0x61])])await assert.rejects(parseAttachment(bytes,'forged.txt'));
});

test('large plain text and DOCX return complete content across attachment, material and analysis reads',async t=>{
 const f=fixture(t),source='a'.repeat(300*1024)+'完整末尾-END';
 for(const [name,bytes] of [['index.html',Buffer.from(source)],['large.docx',makeDocx(source)]]){
  const m=await ingest(f,bytes,name,name==='index.html'?'a'.repeat(64):'b'.repeat(64));
  assert.equal((await read(f,m)).content,source);
  const a=archive(f,m);assert.equal(f.materials.read(ref(a)).content,source);
  const outcome=f.analyses.readScope({projectId:f.project.id,scope:[ref(a)]});
  assert.equal(outcome.contents[0].content,source);assert.equal(outcome.reads[0].ok,true);
  assert.ok(!outcome.uncovered.some(g=>g.reason==='too_large'));
 }
});

test('legacy failures reparse lazily without re-upload, new versions or historical analysis rewrites',async t=>{
 const f=fixture(t),source='<html>historical source</html>',m=await ingest(f,Buffer.from(source));
 legacyAttachment(f,m);
 // Archiving before a read preserves the old derived result; the next material read repairs it.
 const a=archive(f,m);legacyMaterial(f,a,m.sha256);
 const before=f.materials.getWithVersions(a.material_id),original=readFileSync(f.materials.absolutePathOf(before.versions[0].relPath));
 const history=f.analyses.submit({projectId:f.project.id,trigger:'fixture',scope:[ref(a)],requirements:[],undecided:[],inferences:[],notUnderstood:[],basisMissing:[]});
 legacyMaterial(f,a,m.sha256);
 const persisted=f.db.prepare('SELECT * FROM analyses').all();
 assert.equal((await read(f,m)).content,source);
 assert.equal(f.materials.read(ref(a)).content,source);
 assert.equal(JSON.parse(f.db.prepare('SELECT parsed FROM session_attachments').get().parsed).parserVersion,PARSER_VERSION);
 assert.equal(JSON.parse(f.db.prepare('SELECT parsed FROM material_extractions').get().parsed).parserVersion,PARSER_VERSION);
 assert.deepEqual(f.materials.getWithVersions(a.material_id),before);
 assert.deepEqual(readFileSync(f.materials.absolutePathOf(before.versions[0].relPath)),original);
 assert.deepEqual(f.db.prepare('SELECT * FROM analyses').all(),persisted);
 assert.equal(f.analyses.get(history.id).id,history.id);
 // Re-archive dedup must not perpetuate a legacy failure.
 legacyMaterial(f,a,m.sha256);const again=archive(f,m);assert.equal(again.deduplicated,true);assert.equal(again.version,1);
 assert.equal(f.materials.read(ref(a)).content,source);
});

test('direct material with no extraction uses the same parser and caches derived content only',t=>{
 const f=fixture(t),path=join(f.root,'index.html'),source='<html>直接资料-END</html>';writeFileSync(path,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(source,'utf16le')]));
 const a=f.materials.upload({projectId:f.project.id,sourcePath:path,purpose:'direct',submittedBy:'alice'}),r={materialId:a.material.id,version:1};
 assert.equal(f.db.prepare('SELECT count(*) n FROM material_extractions').get().n,0);
 assert.equal(f.materials.read(r).content,source);
 assert.equal(f.analyses.readScope({projectId:f.project.id,scope:[r]}).contents[0].content,source);
 assert.equal(f.materials.getWithVersions(a.material.id).latestVersion,1);
});

test('an explicit companion does not clear an unreadable original or implicitly expand analysis scope',async t=>{
 const f=fixture(t),binary=await ingest(f,Buffer.from([0,1,2,3]),'package.bin'),description=await ingest(f,Buffer.from('This description is not proof that the binary works.'),'说明.md','b'.repeat(64));
 assert.equal((await read(f,binary)).content,null);assert.match((await read(f,description)).content,/not proof/);
 const a=archive(f,binary),b=archive(f,description);
 const single=f.analyses.readScope({projectId:f.project.id,scope:[ref(a)]});assert.equal(single.contents.length,0);assert.equal(single.reads.length,1);
 const both=f.analyses.readScope({projectId:f.project.id,scope:[ref(a),ref(b)]});assert.equal(both.contents.length,1);assert.equal(both.contents[0].materialId,b.material_id);assert.equal(both.reads[0].ok,false);assert.ok(both.uncovered.some(g=>g.reason==='unreadable'&&g.entry.materialId===a.material_id));
});

test('lazy refresh refuses corrupt or missing originals and corrupt parsed evidence',async t=>{
 const f=fixture(t),m=await ingest(f,Buffer.from('<html>intact</html>')),a=archive(f,m),r=ref(a);
 const v=f.materials.getWithVersions(a.material_id).versions[0],path=f.materials.absolutePathOf(v.relPath);
 legacyMaterial(f,a,m.sha256);writeFileSync(path,'changed');assert.equal(f.materials.read(r).content,null);
 unlinkSync(path);assert.equal(f.materials.read(r).content,null);
 const row=f.db.prepare('SELECT * FROM session_attachments').get(),parsed=JSON.parse(row.parsed);parsed.content='forged';f.db.prepare('UPDATE session_attachments SET parsed=?').run(JSON.stringify(parsed));await assert.rejects(read(f,m),/Parsed text digest/);
});
