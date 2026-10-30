import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAttachment} from '../src/attachment-parser.mjs';
import {AttachmentService} from '../src/attachment-service.mjs';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {MaterialService} from '../business/lib/service/material-service.js';
import {mkdtempSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
test('server refuses GIF and renamed GIF at parser and transfer commit boundary',async t=>{
 for(const name of ['x.gif','x.png','x.txt'])await assert.rejects(parseAttachment(gif,name),/GIF.*not allowed/);
 const root=mkdtempSync(join(tmpdir(),'server-gif-')),db=openDatabase({path:join(root,'test.sqlite')});t.after(()=>db.close());const projects=new ProjectService(db),materials=new MaterialService(db,join(root,'files')),service=new AttachmentService({db,root:join(root,'attachments'),projects,materials}),project=projects.create({key:'GIF',name:'Synthetic test'});
 const manifest={handle:'a'.repeat(64),sha256:createHash('sha256').update(gif).digest('hex'),bytes:gif.length,name:'renamed.txt',sourceKind:'file-attachment',projectId:project.id};
 await assert.rejects(service.ingest({sessionId:'s',account:'a',requestId:'r',projectId:project.id,manifests:[manifest],read:async({offset,maxBytes})=>{const data=gif.subarray(offset,offset+maxBytes);return {offset,bytes:data.length,data:data.toString('base64'),eof:offset+data.length===gif.length};}}),/GIF.*not allowed/);assert.equal(db.prepare('SELECT count(*) n FROM session_attachments').get().n,0);assert.deepEqual(readdirSync(join(root,'attachments')),[]);
});
