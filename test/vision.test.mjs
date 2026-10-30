import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import {SessionStore,Session} from '@deepseek-ai/dsh-session';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {LocalAttachmentStore} from '@deepseek-ai/dsh-attachment-local';
import sharp from 'sharp';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {MaterialService} from '../business/lib/service/material-service.js';
import {AttachmentService} from '../src/attachment-service.mjs';
import {VisionAccess,normalizeVisionImage} from '../src/vision.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'visual-policy-')),ctx=new Context();ctx.plugin(SessionStore);ctx.plugin(LocalAttachmentStore,{dshHome:join(root,'home'),normalizedImageMaxDimension:2048,normalizedImageMaxBytes:1048576});await Promise.all([...ctx.registry.values()].flatMap(r=>[...r.fibers]).map(f=>f.await()));
 const db=openDatabase({path:join(root,'test.sqlite')}),projects=new ProjectService(db),materials=new MaterialService(db,join(root,'files')),attachments=new AttachmentService({db,root:join(root,'receipts'),projects,materials}),project=projects.create({key:'V',name:'Synthetic'});let revoked=false;
 const access={scope(p){if(revoked||p.account!=='alice'||p.projectId!==project.id)throw Error('Revoked');}};const vision=new VisionAccess({ctx,attachments,access}),principal={account:'alice',projectId:project.id,channel:'dsh'};
 t.after(async()=>{db.close();await ctx.fiber.dispose();});return {root,ctx,db,project,attachments,vision,principal,revoke(){revoked=true;}};
}
async function receive(f,bytes){
 const manifest={handle:'a'.repeat(64),name:'picture.png',bytes:bytes.length,sha256:hash(bytes),projectId:f.project.id,sourceKind:'file-attachment'};
 await f.attachments.ingest({sessionId:'s',requestId:'r',account:'alice',projectId:f.project.id,manifests:[manifest],read:async({offset,maxBytes})=>{const b=bytes.subarray(offset,offset+maxBytes);return {offset,data:b.toString('base64'),bytes:b.length,eof:offset+b.length===bytes.length};}});
 return {handle:manifest.handle};
}
test('vision copy is proportional, byte-bounded, single-frame and cannot silently accept GIF',async()=>{
 const data=await sharp({create:{width:3000,height:1500,channels:3,background:'#f00'}}).png().toBuffer(),normalized=await normalizeVisionImage(data,'picture.png');assert.equal(normalized.width,2048);assert.equal(normalized.height,1024);assert.ok(normalized.data.length<=1048576);assert.equal(normalized.mediaType,'image/webp');
 const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');await assert.rejects(normalizeVisionImage(gif,'x.png'),/GIF/);
});
test('vision reads only attachments explicitly named by handle in the current human message; every retained pixel is reauthorized',async t=>{
 const f=await fixture(t),data=await sharp({create:{width:20,height:10,channels:3,background:'#00f'}}).png().toBuffer(),r=await receive(f,data);let end=f.vision.begin('s','alice',f.principal,'Inspect image '+r.handle);
 const result=await f.vision.inspect('s','alice',r.handle);assert.ok(result.image.attachmentId.startsWith('sha256:'));assert.equal(result.visual_analysis,'not-yet-confirmed');end();
 end=f.vision.begin('s','alice',f.principal,'Read old images');await assert.rejects(f.vision.inspect('s','alice',r.handle),/Explicitly name/);end();
 end=f.vision.begin('s','alice',f.principal,'Read image '+r.handle);
 assert.deepEqual((await f.vision.inspect('s','alice',r.handle)).image,result.image);await assert.rejects(f.vision.inspect('other','alice',r.handle));end();
 const session=f.ctx.sessions.create('s');session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'image',attachment:result.image}]}),{surfaceOp:'append'});
 const allowed=await f.vision.prepare({session},'alice',f.principal,new AbortController().signal);assert.ok(allowed.retainedBase64Bytes>0);f.revoke();await assert.rejects(f.vision.prepare({session},'alice',f.principal,new AbortController().signal),/Revoked/);
});
test('history budget logs permanent offload, preserves model-visible omission and cannot reuse refs across sessions',async t=>{
 const f=await fixture(t),bytes=await sharp({create:{width:20,height:10,channels:3,background:'#0f0'}}).png().toBuffer(),r=await receive(f,bytes),end=f.vision.begin('s','alice',f.principal,'selected '+r.handle);const result=await f.vision.inspect('s','alice',r.handle);end();
 const session=f.ctx.sessions.create('s');session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'image',attachment:result.image},{type:'image',attachment:result.image}]}),{surfaceOp:'append'});
 const outcome=await f.vision.prepare({session},'alice',f.principal,new AbortController().signal,{historyBytes:1});assert.equal(outcome.offloaded,2);assert.equal(outcome.retainedBase64Bytes,0);assert.equal(session.deriveMessages()[0].content.filter(b=>b.offloaded).length,2);
 const restored=Session.create('s',session.snapshotEvents(),session.header,0,f.ctx.sessions.messageProjections);assert.equal(restored.deriveMessages()[0].content.filter(b=>b.offloaded).length,2);
 const other=f.ctx.sessions.create('other');other.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'image',attachment:result.image}]}),{surfaceOp:'append'});await assert.rejects(f.vision.prepare({session:other},'alice',f.principal,new AbortController().signal),/outside this authenticated/);
});
