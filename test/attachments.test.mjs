import test from 'node:test';import assert from 'node:assert/strict';
import {zipSync,strToU8}from'fflate';import sharp from'sharp';
import {mkdtempSync,readdirSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';
import {parseAttachment}from'../src/attachment-parser.mjs';import{AttachmentService}from'../src/attachment-service.mjs';
import{openDatabase}from'../business/lib/sqlite/connection.js';import{ProjectService}from'../business/lib/service/project-service.js';import{MaterialService}from'../business/lib/service/material-service.js';import{AnalysisService}from'../business/lib/service/analysis-service.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function docx(xml,extras={}){return Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types/>'),'word/document.xml':strToU8(xml),...extras}));}
const xml='<w:document xmlns:w="test"><w:body><w:p><w:r><w:t>需求 &amp; evidence</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing/></w:r></w:p></w:body></w:document>';
test('DOCX extracts body/table text and image gaps; UTF-8 is strict; active/invalid ZIP XML refused',async()=>{
 const parsed=await parseAttachment(docx(xml),'requirements.docx');assert.match(parsed.content,/需求 & evidence/);assert.match(parsed.content,/cell/);assert.ok(parsed.warnings.some(w=>w.includes('images')));
 await assert.rejects(parseAttachment(Buffer.from([0xff,0xfe]),'invalid.txt'));
 await assert.rejects(parseAttachment(Buffer.from('not zip'),'invalid.docx'));
 await assert.rejects(parseAttachment(docx(xml,{'word/vbaProject.bin':strToU8('macro')}),'invalid.docx'));
 await assert.rejects(parseAttachment(docx('<!DOCTYPE w [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+xml),'unsafe.docx'));
 await assert.rejects(parseAttachment(Buffer.from('unsupported'),'file.pdf'));
 const corrupted=docx(xml);const local=corrupted.indexOf(Buffer.from('word/document.xml'));corrupted[local+Buffer.byteLength('word/document.xml')+3]^=1;await assert.rejects(parseAttachment(corrupted,'crc-bad.docx'));
 await assert.rejects(parseAttachment(docx(xml,{'word/media/bomb.bin':new Uint8Array(9*1024*1024)}),'bomb.docx'));
 const forged=docx('<w:document xmlns:w="test"><w:body>'+('<w:p><w:r><w:t>data</w:t></w:r></w:p>'.repeat(500))+'</w:body></w:document>');let central=0;while((central=forged.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]),central))>=0){const n=forged.readUInt16LE(central+28),name=forged.subarray(central+46,central+46+n).toString();if(name==='word/document.xml'){forged.writeUInt32LE(1,central+24);break;}central++;}await assert.rejects(parseAttachment(forged,'forged-size.docx'));
 const wpsStyle=docx(xml,{'word\\theme/':new Uint8Array(),'word\\media/':new Uint8Array(),'word\\_rels/':new Uint8Array()});assert.match((await parseAttachment(wpsStyle,'wps-style.docx')).content,/需求/);
 await assert.rejects(parseAttachment(docx(xml,{'word\\evil.xml':strToU8('<x/>')}),'backslash-file.docx'));
 await assert.rejects(parseAttachment(docx(xml,{'word\\..\\evil/':new Uint8Array()}),'unsafe-directory.docx'));
});
test('PNG/JPEG/WebP detected and decoded; unsupported visual content not claimed',async()=>{
 for(const [format,extension]of[['png','png'],['jpeg','jpg'],['webp','webp']]){const bytes=await sharp({create:{width:3,height:2,channels:3,background:'#ffffff'}}).toFormat(format).toBuffer();const parsed=await parseAttachment(bytes,'sample.'+extension);assert.equal(parsed.kind,'image');assert.equal(parsed.content,null);assert.equal(parsed.visualAnalysis,'not-performed');assert.equal(parsed.width,3);await assert.rejects(parseAttachment(bytes,'wrong.'+(extension==='png'?'jpg':'png')));}
});
function fixture(t){const root=mkdtempSync(join(tmpdir(),'collab-attachments-')),db=openDatabase({path:join(root,'business.sqlite')}),projects=new ProjectService(db),materials=new MaterialService(db,join(root,'files')),service=new AttachmentService({db,root:join(root,'attachments'),projects,materials});materials.contentProvider=service.materialContent.bind(service);const project=projects.create({key:'ATTACH-FIXTURE',name:'test fixture'});t.after(()=>db.close());return{root,db,projects,materials,service,project,analyses:new AnalysisService(db,materials)};}
function ingestRequest(f,data,{handle='b'.repeat(64),name='requirements.docx'}={}){
 const manifest={handle,name,bytes:data.length,sha256:hash(data),projectId:f.project.id,sourceKind:'file-attachment'};
 return {manifest,request:{sessionId:'alice-session',requestId:'request1',account:'alice',projectId:f.project.id,manifests:[manifest],read:async({offset,maxBytes})=>{const bytes=data.subarray(offset,offset+maxBytes);return{offset,data:bytes.toString('base64'),bytes:bytes.length,eof:offset+bytes.length===data.length};}}};
}
async function ingest(f,part){await f.service.ingest(part.request);}
test('ingest stores bytes with hash verification, read returns full content, archive creates a material version and repeats create versions',async t=>{
 const f=fixture(t),data=docx(xml),part=ingestRequest(f,data);
 await ingest(f,part);
 // Ownership: another account/session cannot read or archive.
 await assert.rejects(f.service.read('bob-session','bob',part.manifest.handle),/not owned/);
 await assert.rejects(f.service.read('other','alice',part.manifest.handle),/not owned/);
 const read=await f.service.read('alice-session','alice',part.manifest.handle);
 assert.equal(read.ok,true);assert.equal(read.kind,'text');assert.match(read.content,/需求/);assert.equal(read.sha256,hash(data));
 const release=f.service.beginTurn({sessionId:'alice-session',account:'alice',projectId:f.project.id,requestId:'turn1',manifests:[part.manifest],onOperation:()=>{}},new AbortController().signal);
 const archive=f.service.archive('alice-session','alice',{handle:part.manifest.handle,purpose:'需求输入',role:'product'});
 assert.equal(archive.version,1);assert.equal(archive.material_id,f.materials.listByProject(f.project.id)[0].id);
 release();
 // Repeat archive in a later turn creates a new version of the same material.
 const release2=f.service.beginTurn({sessionId:'alice-session',account:'alice',projectId:f.project.id,requestId:'turn2',manifests:[part.manifest],onOperation:()=>{}},new AbortController().signal);
 const again=f.service.archive('alice-session','alice',{handle:part.manifest.handle,purpose:'需求输入',role:'product'});
 release2();
 assert.equal(again.version,1);assert.equal(again.deduplicated,true,'identical bytes deduplicate, no new version');assert.equal(again.material_id,archive.material_id);
 assert.equal(f.materials.listByProject(f.project.id)[0].versions.length,1);
 const outcome=f.analyses.readScope({projectId:f.project.id,scope:[{materialId:archive.material_id,version:1}]});
 assert.match(outcome.contents[0].content,/需求/);assert.equal(outcome.contents[0].sha256,hash(data));
 // Cross-project archive is refused.
 const other=f.projects.create({key:'ATTACH-OTHER',name:'other project'});
 const release3=f.service.beginTurn({sessionId:'alice-session',account:'alice',projectId:other.id,requestId:'turn3',manifests:[part.manifest],onOperation:()=>{}},new AbortController().signal);
 assert.throws(()=>f.service.archive('alice-session','alice',{handle:part.manifest.handle,purpose:'需求输入'}),/differs from the session-bound project/);
 release3();
});
test('qualification recheck at archive commit rolls back material row and file; parsed evidence survives only in the stored attachment',async t=>{
 const f=fixture(t),data=docx(xml),part=ingestRequest(f,data);
 await ingest(f,part);
 const release=f.service.beginTurn({sessionId:'alice-session',account:'alice',projectId:f.project.id,requestId:'turn1',manifests:[part.manifest],onOperation:()=>{}},new AbortController().signal);
 assert.throws(()=>f.service.archive('alice-session','alice',{handle:part.manifest.handle,purpose:'must roll back',role:'product'},()=>{throw new Error('revoked-before-archive-commit');}),/revoked-before-archive-commit/);
 release();
 assert.equal(f.materials.listByProject(f.project.id).length,0);
 // The stored attachment itself is intact and readable after the failed archive.
 const read=await f.service.read('alice-session','alice',part.manifest.handle);assert.match(read.content,/需求/);
});
test('corrupt chunk/digest and cancellation remove service-owned staging; re-ingest with same sha256 is idempotent',async t=>{
 const f=fixture(t),data=docx(xml),part=ingestRequest(f,data);
 const bad={...part,request:{...part.request,read:async()=>({offset:1,data:'eA==',bytes:1,eof:true})}};
 await assert.rejects(f.service.ingest(bad.request));assert.deepEqual(readdirSync(join(f.root,'attachments')),[]);
 const mismatch=ingestRequest(f,data);mismatch.request={...mismatch.request,requestId:'digest-mismatch',manifests:[{...mismatch.manifest,sha256:'0'.repeat(64)}]};
 await assert.rejects(f.service.ingest(mismatch.request),/sha256/);assert.deepEqual(readdirSync(join(f.root,'attachments')),[]);
 const cancelled=ingestRequest(f,data);cancelled.request={...cancelled.request,requestId:'cancelled'};const read=cancelled.request.read;const controller=new AbortController();cancelled.request.read=async params=>{controller.abort();return read(params);};
 await assert.rejects(f.service.ingest({...cancelled.request,signal:controller.signal}),/cancelled/);assert.deepEqual(readdirSync(join(f.root,'attachments')),[]);
 await ingest(f,part);
 const first=f.service.listForClient('alice-session','alice',f.project.id).attachments;
 await ingest(f,{...part,request:{...part.request,requestId:'request2'}});
 assert.deepEqual(f.service.listForClient('alice-session','alice',f.project.id).attachments,first,'same sha256 re-ingest keeps one row');
 assert.equal(f.db.prepare('SELECT count(*) n FROM session_attachments').get().n,1);
 assert.equal(f.service.listForClient('alice-session','bob',f.project.id).attachments.length,0);
});
test('an unknown handle is refused with ownership guidance, not a crash',async t=>{
 const f=fixture(t);
 await assert.rejects(()=>f.service.read('alice-session','alice','f'.repeat(64)),error=>error.code===-32013&&/not owned/.test(error.message));
 assert.throws(()=>f.service.archive('alice-session','alice',{handle:'f'.repeat(64),purpose:'x'}),/not owned/);
 await assert.rejects(()=>f.service.read('alice-session','alice','short'),/Invalid attachment handle/);
});
