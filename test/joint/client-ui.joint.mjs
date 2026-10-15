import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const clientRoot=process.env.DSH_COLLABORATION_CLIENT_ROOT,imRoot=process.env.DSH_COLLABORATION_IM_ROOT;
if(!clientRoot||!imRoot)throw new Error('Select independent client and IM dependencies explicitly');
const require=createRequire(resolve(imRoot,'package.json')),React=require('react'),Renderer=require('react-test-renderer');
const source=readFileSync(resolve(clientRoot,'lib/client.js'),'utf8');let module;
vm.runInNewContext(source,{window:{__ModuleLoader__:{load:entry=>{module=entry.factory(name=>{assert.equal(name,'react');return React;});}}},Date});

test('built client keeps login in Settings and binds only the current session through a separate project area',async()=>{
 const calls=[];let authenticated=false;const configuration={state:'configured'};const call=async(method,payload)=>{calls.push({method,payload});
   if(method==='status')return {authenticated,account:authenticated?'alice':null,expiresAt:Date.now()+3600000,configuration};
   if(method==='configuration.list')return {configuration,candidates:[]};
   if(method==='login.start')return {loginUrl:'https://login.example.test/collaboration/login/11111111-1111-1111-1111-111111111111'};
   if(method==='login.claim'){authenticated=true;return {authenticated:true};}
   if(method==='project.state')return {authenticated,localId:payload.localId,mapped:false,projectId:null};
   if(method==='project.list')return {projects:[{id:'p',key:'A',name:'Project'}]};
   if(method==='project.select'){assert.deepEqual(JSON.parse(JSON.stringify(payload)),{localId:'local',projectId:'p'});return {};}
   if(method==='login.logout'){authenticated=false;return {authenticated:false};}throw new Error(method);
  };
  let tree;await Renderer.act(async()=>{tree=Renderer.create(React.createElement(module.CollaborationPanel,{call}));});
  const button=text=>tree.root.findAllByType('button').find(b=>b.props.children===text);
  await Renderer.act(async()=>{await button('发起钉钉扫码登录').props.onClick();});const link=tree.root.findByType('a');assert.ok(link.props.href.startsWith('https://login.example.test/'));assert.equal(link.props.rel,'noopener noreferrer');
  await Renderer.act(async()=>{await button('我已扫码，完成登录').props.onClick();});assert.ok(JSON.stringify(tree.toJSON()).includes('已登录：alice'));assert.ok(!calls.some(c=>c.method.startsWith('project.')));
  let projects;await Renderer.act(async()=>{projects=Renderer.create(React.createElement(module.ProjectSelectionArea,{call,localId:'local'}));});
  await Renderer.act(async()=>{projects.root.findByType('select').props.onChange({target:{value:'p'}});});
  await Renderer.act(async()=>{await projects.root.findAllByType('button').find(b=>b.props.children==='确认绑定当前会话').props.onClick();});
  assert.ok(calls.some(c=>c.method==='project.select'));assert.ok(!calls.some(c=>/prompt|history|communication|session.list/.test(c.method)));assert.ok(!JSON.stringify(calls).includes('token'));
  await Renderer.act(async()=>{await button('退出当前设备').props.onClick();});assert.ok(JSON.stringify(tree.toJSON()).includes('尚未扫码登录'));assert.equal(tree.root.findAllByType('pre').length,0);
  await Renderer.act(async()=>{tree.unmount();projects.unmount();});
});
