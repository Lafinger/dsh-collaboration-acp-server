import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {MvpIdentityStore} from '../src/mvp-identities.mjs';
import {LoginService} from '../src/login-service.mjs';
import {MvpAccessService} from '../src/mvp-service.mjs';
import {projectRoleRevision} from '../src/project-role-revision.mjs';
const official=(userId,name='同名成员')=>({corpId:'corp',userId,unionId:'union-'+userId,internal:true,name});
function fixture(t){
 const db=openDatabase({path:':memory:'});let time=1800000000000;
 const identities=new MvpIdentityStore({db,serviceId:'mvp',corpId:'corp',clientId:'app',administratorUserId:'boss',now:()=>time});
 const admin=identities.enroll(official('boss','管理员')),a=identities.enroll(official('a')),b=identities.enroll(official('b'));
 const profiles=new Map([['boss',official('boss','管理员')],['a',official('a')],['b',official('b')]]),calls=[];
 const provider={async verifyMember(member){calls.push(member.user_id);const value=profiles.get(member.user_id);if(value instanceof Error)throw value;return value;}};
 const login=new LoginService({identities,provider,publicOrigin:'https://org.example',now:()=>time}),projects=new ProjectService(db);
 const service=new MvpAccessService({identities,login,projects,runtime:{},cwd:process.cwd(),store:{}});
 t.after(()=>{clearInterval(service.authorizationMonitor);db.close();});
 const project=projects.create({key:'P',name:'合成项目'});
 return {db,identities,admin,a,b,login,profiles,calls,projects,service,project,advance:ms=>time+=ms};
}
test('manual roster refresh updates trusted names, never merges same names, and preserves role version and all historical ownership',async t=>{
 const f=fixture(t);f.projects.setMember(f.project.id,'frontend',f.a.account);
 const before=projectRoleRevision(f.identities,f.projects,f.project.id),member=f.identities.member(f.a.account);
 f.profiles.set('a',official('a','新姓名'));
 const view=await f.service.manage(f.admin.account,{action:'view',projectId:f.project.id});
 assert.equal(f.calls.length,3);assert.deepEqual(new Set(f.calls),new Set(['boss','a','b']));
 assert.equal(view.sync.status,'complete');assert.equal(view.members.length,3);
 assert.equal(view.members.find(m=>m.account===f.a.account).name,'新姓名');
 assert.equal(view.project.roles.find(r=>r.role==='frontend').memberProfile.name,'新姓名');
 assert.equal(view.revision,before);assert.equal(f.identities.member(f.a.account).revision,member.revision);
 assert.equal(new Set(view.members.map(m=>m.disambiguator)).size,3);
});
test('confirmed organization removal is nonassignable; retained role is readable; temporary outage is unknown not removed',async t=>{
 const f=fixture(t);f.projects.setMember(f.project.id,'frontend',f.a.account);
 const token=f.identities.issueLogin(f.a.account,'device'),revision=f.service.roleRevision(f.project.id);
 f.profiles.set('a',Object.assign(new Error('synthetic removal'),{qualificationRevoked:true}));f.profiles.set('b',new Error('synthetic outage'));
 const view=await f.service.manage(f.admin.account,{action:'view',projectId:f.project.id});
 const gone=view.members.find(m=>m.account===f.a.account),unknown=view.members.find(m=>m.account===f.b.account);
 assert.equal(gone.qualification,'revoked');assert.equal(gone.assignable,false);assert.equal(unknown.qualification,'unknown');assert.equal(unknown.assignable,false);
 assert.equal(view.sync.status,'partial');assert.equal(view.project.roles.find(r=>r.role==='frontend').member,f.a.account);
 assert.equal(view.project.roles.find(r=>r.role==='frontend').roleNeedsReassignment,true);
 assert.equal(view.project.roles.find(r=>r.role==='frontend').memberProfile.name,'同名成员');
 assert.equal(view.revision,revision,'qualification is not a role assignment');assert.throws(()=>f.identities.verifyLogin(token.token,f.a.account,'device'));
});
test('same-account rejoin requires explicit assignment, whose monotonic revision never revives the old device or assignment hash',async t=>{
 const f=fixture(t);f.projects.setMember(f.project.id,'frontend',f.a.account);const old=f.service.roleRevision(f.project.id),token=f.identities.issueLogin(f.a.account,'device');
 f.identities.invalidateOrganization(f.a.account,f.identities.member(f.a.account).revision);
 f.identities.enroll(official('a','重新加入'));assert.throws(()=>f.identities.requireRole(f.a.account,f.project.id,'frontend'));
 const view=f.service.adminView(f.admin.account,f.project.id);assert.equal(view.revision,old,'re-login alone is not assignment');
 const response=await f.service.manage(f.admin.account,{action:'role',commandId:'restore',projectId:f.project.id,role:'frontend',account:f.a.account,revision:view.revision});
 assert.equal(f.identities.requireRole(f.a.account,f.project.id,'frontend'),true);assert.notEqual(response.revision,old);assert.notEqual(response.revision,view.revision);
 assert.throws(()=>f.identities.verifyLogin(token.token,f.a.account,'device'));
});
test('role submission always forces official target verification even while prior lease is fresh',async t=>{
 const f=fixture(t),view=f.service.adminView(f.admin.account,f.project.id);
 f.profiles.set('a',Object.assign(new Error('removed after candidate was displayed'),{qualificationRevoked:true}));
 await assert.rejects(f.service.manage(f.admin.account,{action:'role',commandId:'assign',projectId:f.project.id,role:'frontend',account:f.a.account,revision:view.revision}));
 assert.deepEqual(f.calls,['a']);assert.equal(f.projects.getWithRoles(f.project.id).roles.find(r=>r.role==='frontend').member,null);
});
test('official revocation aborts active work and closes matching authenticated device only',t=>{
 const f=fixture(t),login=f.identities.issueLogin(f.a.account,'device');let closed=0,aborted=0;
 const connection={identity:{account:f.a.account},login,peer:{close(){closed++;}}};f.service.connections.add(connection);
 f.service.sessions.set('synthetic',{connection,controller:{abort(){aborted++;}}});
 f.identities.invalidateOrganization(f.a.account,f.identities.member(f.a.account).revision);
 assert.equal(closed,1);assert.equal(aborted,1);assert.equal(connection.login,null);
});
