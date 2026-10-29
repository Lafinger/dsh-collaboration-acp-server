import test from 'node:test';import assert from 'node:assert/strict';
import {zipSync,strToU8}from'fflate';import sharp from'sharp';
import {mkdtempSync,readdirSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';
import {prepareHumanRequest}from'../src/human-authorization.mjs';
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
function fixture(t){const root=mkdtempSync(join(tmpdir(),'collab-receipts-')),db=openDatabase({path:join(root,'business.sqlite')}),projects=new ProjectService(db),materials=new MaterialService(db,join(root,'files')),service=new AttachmentService({db,root:join(root,'attachments'),projects,materials});materials.contentProvider=service.materialContent.bind(service);const project=projects.create({key:'ATTACH-FIXTURE',name:'test fixture'});t.after(()=>db.close());return{root,db,projects,materials,service,project,analyses:new AnalysisService(db,materials)};}
function request(f,data,{archiveAuthorized=true}={}){const controller=new AbortController(),manifest={handle:'b'.repeat(64),name:'requirements.docx',bytes:data.length,sha256:hash(data),projectId:f.project.id,archiveAuthorized,sourceKind:'file-attachment'},request={sessionId:'alice-session',requestId:'request1',account:'alice',manifests:[manifest],read:async({offset,maxBytes})=>{const bytes=data.subarray(offset,offset+maxBytes);return{offset,data:bytes.toString('base64'),bytes:bytes.length,eof:offset+bytes.length===data.length};}};const text=archiveAuthorized?'附件操作: 上传并归档\nproject_id: '+f.project.id:'附件操作: 仅传输\nproject_id: '+f.project.id;return{manifest,request:{...request,...prepareHumanRequest({text,projectId:f.project.id,manifests:[manifest],sessionId:request.sessionId,account:request.account,requestId:request.requestId})},controller};}
test('chunk transfer immutable receipt, exact authorized project, idempotent archive, fixed-version parsed analysis and objective gaps',async t=>{
 const f=fixture(t),data=docx(xml),r=request(f,data);f.service.validateHumanRequest('附件操作: 上传并归档\nproject_id: '+f.project.id,r.request.manifests);const release=f.service.bind(r.request,r.controller.signal);
 const receipt=await f.service.transfer('alice-session','alice',r.manifest.handle);assert.equal(receipt.sha256,hash(data));assert.deepEqual(await f.service.transfer('alice-session','alice',r.manifest.handle),receipt);
 assert.throws(()=>f.service.inspect('bob-session','bob',receipt.receipt_id));assert.throws(()=>f.service.inspect('other','alice',receipt.receipt_id));
 const inspected=f.service.inspect('alice-session','alice',receipt.receipt_id);assert.match(inspected.parsed.content,/需求/);
 const archive=f.service.archive('alice-session','alice',{receiptId:receipt.receipt_id,purpose:'需求输入',role:'product',reason:'Requirement body text; image unexamined'});assert.equal(archive.version,1);assert.match(archive.stored_at,/product/);
 release();const text='把刚才那份归档',againRequest=prepareHumanRequest({text,projectId:f.project.id,sessionId:'alice-session',account:'alice',requestId:'again',authorization:{version:2,messageId:'again-human',textSha256:hash(Buffer.from(text)),projectId:f.project.id,attachmentScopes:[],receiptScopes:[{receiptId:receipt.receipt_id,action:'archive'}]},receipt:id=>f.service.receipt('alice-session','alice',id)}),releaseAgain=f.service.bind(againRequest,new AbortController().signal);const again=f.service.archive('alice-session','alice',{receiptId:receipt.receipt_id,purpose:'different',role:'pm',reason:'repeat'});releaseAgain();assert.equal(again.already_archived,true);assert.equal(f.materials.listByProject(f.project.id)[0].versions.length,1);
 const outcome=f.analyses.readScope({projectId:f.project.id,scope:[{materialId:archive.material_id,version:1}]});assert.match(outcome.contents[0].content,/需求/);assert.ok(outcome.uncovered.some(u=>u.text.includes('images')));assert.equal(outcome.contents[0].sha256,hash(data));
 assert.throws(()=>f.service.context('alice-session','alice'));assert.equal(f.db.prepare('SELECT count(*) n FROM attachment_receipts').get().n,1);
 const current=f.materials.listByProject(f.project.id)[0];
 const second=f.materials.upload({projectId:f.project.id,sourcePath:archive.stored_at,originalName:current.originalName,purpose:current.purpose,submittedBy:'alice',role:'pm'});assert.equal(second.material.role,'product');assert.match(second.version.relPath,/product/);
});
test('qualification recheck at transfer/archive commit rolls back disk and SQLite before any receipt or formal material survives',async t=>{
 const f=fixture(t),data=docx(xml),r=request(f,data);const release=f.service.bind(r.request,r.controller.signal);
 await assert.rejects(f.service.transfer('alice-session','alice',r.manifest.handle,undefined,()=>{throw new Error('revoked-before-transfer-commit');}),/revoked-before-transfer-commit/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM attachment_receipts').get().n,0);assert.deepEqual(readdirSync(join(f.root,'attachments')),[]);
 const receipt=await f.service.transfer('alice-session','alice',r.manifest.handle);
 assert.throws(()=>f.service.archive('alice-session','alice',{receiptId:receipt.receipt_id,purpose:'must roll back',reason:'fixture'},()=>{throw new Error('revoked-before-archive-commit');}),/revoked-before-archive-commit/);release();
 assert.equal(f.materials.listByProject(f.project.id).length,0);assert.equal(f.service.list('alice-session','alice').receipts[0].material_id,null);
});

test('corrupt chunk/digest and cancellation remove service-owned staging, transfer-only cannot archive',async t=>{
 const f=fixture(t),data=docx(xml),r=request(f,data);r.request.read=async()=>({offset:1,data:'eA==',bytes:1,eof:true});let release=f.service.bind(r.request,r.controller.signal);await assert.rejects(f.service.transfer('alice-session','alice',r.manifest.handle));release();assert.deepEqual(readdirSync(join(f.root,'attachments')),[]);
 const mismatch=request(f,data);mismatch.request.requestId='digest-mismatch';mismatch.manifest.sha256='0'.repeat(64);release=f.service.bind(mismatch.request,mismatch.controller.signal);await assert.rejects(f.service.transfer('alice-session','alice',mismatch.manifest.handle),/sha256/);release();assert.deepEqual(readdirSync(join(f.root,'attachments')),[]);
 const cancelled=request(f,data);cancelled.request.requestId='cancelled';const read=cancelled.request.read;cancelled.request.read=async params=>{cancelled.controller.abort();return read(params);};release=f.service.bind(cancelled.request,cancelled.controller.signal);await assert.rejects(f.service.transfer('alice-session','alice',cancelled.manifest.handle),/cancelled/);release();assert.deepEqual(readdirSync(join(f.root,'attachments')),[]);
 const transferOnly=request(f,data,{archiveAuthorized:false});release=f.service.bind(transferOnly.request,transferOnly.controller.signal);const receipt=await f.service.transfer('alice-session','alice',transferOnly.manifest.handle);release();assert.throws(()=>f.service.archive('alice-session','alice',{receiptId:receipt.receipt_id,purpose:'test',reason:'test'}));
 assert.equal(f.service.list('alice-session','alice').receipts.length,1);assert.equal(f.service.list('alice-session','bob').receipts.length,0);
});

test('a handle passed as receipt_id is refused with actionable guidance, not an opaque ownership error',async t=>{
 // Live incident: attachment_receipts returned authorized_attachments[0].handle and the model
 // passed it straight to attachment_inspect as receipt_id, then retried the same value ~10x
 // because the error only said "not owned by this account/session".
 const f=fixture(t),data=docx(xml),r=request(f,data);const release=f.service.bind(r.request,r.controller.signal);
 const listing=f.service.list('alice-session','alice');
 assert.equal(listing.receipts.length,0);
 assert.equal(listing.authorized_attachments.length,1);
 assert.equal(listing.authorized_attachments[0].handle,r.manifest.handle);
 assert.match(listing.next_step,/attachment_transfer/);
 // handle != receipt_id: passing the handle must explain the missing transfer step.
 assert.throws(()=>f.service.inspect('alice-session','alice',r.manifest.handle),error=>
   error.code===-32013&&/handle/.test(error.message)&&/attachment_transfer/.test(error.message));
 // After a real transfer the handle is still not a receipt id, but a receipt now exists.
 const receipt=await f.service.transfer('alice-session','alice',r.manifest.handle);
 assert.notEqual(receipt.receipt_id,r.manifest.handle);
 const inspected=f.service.inspect('alice-session','alice',receipt.receipt_id);
 assert.match(inspected.parsed.content,/需求 & evidence/);
 // An unknown id (never authorized) keeps the original conservative message.
 assert.throws(()=>f.service.inspect('alice-session','alice','f'.repeat(64)),error=>
   error.code===-32013&&/not owned/.test(error.message));
 release();
});
