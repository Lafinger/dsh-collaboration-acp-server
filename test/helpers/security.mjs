// Test-only synthetic provisioning, never production config or platform identity evidence.
import net from 'node:net';
import {join} from 'node:path';
import {openDatabase} from '../../business/lib/sqlite/connection.js';
import {ProjectService} from '../../business/lib/service/project-service.js';
import {IdentityStore} from '../../src/identity-store.mjs';

export async function syntheticDingTalkConfig(){
  const socket=net.createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
  const loginPort=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  return {corpId:'synthetic-corp',clientId:'synthetic-app',clientSecret:'synthetic-never-used-secret',publicOrigin:'https://login.example.test',loginPort};
}
export function provisionSynthetic(config){
  const db=openDatabase({path:join(config.stateRoot,'collaboration.sqlite')});
  try{
    const identities=new IdentityStore({db,serviceId:config.serviceId,...config.dingtalk}),projects=new ProjectService(db);
    let project=projects.list(true).find(p=>p.key==='SYNTHETIC');
    if(!project)project=projects.create({key:'SYNTHETIC',name:'Synthetic integration'});
    const tokens={};
    for(const account of Object.keys(config.accounts)){
      if(!identities.member(account)){identities.bind({account,userId:account,unionId:account});identities.participate(project.id,account,true);}
      identities.markVerified(account,{corpId:config.dingtalk.corpId,userId:account,unionId:account,internal:true});
      tokens[account]=identities.issueLogin(account,`test-${account}`);
    }
    return {projectId:project.id,tokens};
  }finally{db.close();}
}
export async function authenticateSynthetic(peer,token){await peer.request('collaboration/login/authenticate',{token:token.token,deviceId:token.deviceId});}
