import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {IdentityStore} from '../src/identity-store.mjs';
import {CommunicationStore} from '../src/communication-store.mjs';
import {administer} from '../src/admin.mjs';

test('OS-local administration explicitly provisions members/project/role/target/subscription and never auto reads private bodies',()=>{
  const db=openDatabase({path:':memory:'});try{
    const identities=new IdentityStore({db,serviceId:'s',corpId:'corp',clientId:'app'}),projects=new ProjectService(db),communication=new CommunicationStore({identities});
    const act=command=>administer({identities,projects,communication,configuredAccounts:{alice:'secret',bob:'secret2'}},command);
    assert.throws(()=>act({action:'bind',account:'unknown',userId:'u',unionId:'union'}));
    act({action:'bind',account:'alice',userId:'alice',unionId:'alice',administrator:true});act({action:'bind',account:'bob',userId:'bob',unionId:'bob'});
    assert.throws(()=>act({action:'create',key:'A',name:'A',participants:[]}));
    const {project}=act({action:'create',key:'A',name:'A',participants:['alice']});
    assert.throws(()=>act({action:'role',projectId:project.id,role:'product',account:'bob'}));act({action:'role',projectId:project.id,role:'product',account:'alice'});
    act({action:'target',id:'alice-private',projectId:project.id,kind:'private',account:'alice',botId:'bot',corpId:'corp',clientId:'app',robotCode:'code',route:{userId:'alice'}});
    act({action:'subscription',id:'alice-todos',projectId:project.id,account:'alice',targetId:'alice-private',kinds:['todo','communication'],enabled:true});
    assert.equal(act({action:'communications'}).privateBodiesIncluded,false);assert.equal(act({action:'inspect',projectId:project.id}).participants.length,1);
    db.prepare("INSERT INTO collaboration_inbox(id,bot_id,message_id,transport_id,sender_user_id,conversation_id,conversation_type,created_at,received_at,epoch,body,status,reason,account,project_id,member_revision,participant_revision) VALUES('inbox','bot','msg','wire','alice','c','private',1,1,?,'private body','processing',NULL,'alice',?,1,1)").run(identities.epoch,project.id);
    new CommunicationStore({identities,recover:false});assert.equal(db.prepare("SELECT status FROM collaboration_inbox WHERE id='inbox'").get().status,'processing');
    assert.throws(()=>act({action:'epoch',confirmation:'not-confirmed'}));assert.equal(act({action:'epoch',confirmation:'REVOKE_ALL_DEVICE_LOGINS'}).dataDeleted,false);
    assert.ok(db.prepare('SELECT count(*) n FROM collaboration_security_audit').get().n>=7);
  }finally{db.close();}
});
