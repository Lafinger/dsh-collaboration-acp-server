import test from 'node:test';
import assert from 'node:assert/strict';
import {robotFixture} from './helpers/robot.mjs';
import {formatRobotNotification,robotTextBytes} from '../src/robot-format.mjs';
import {ROBOT_TEXT_BUDGET_BYTES} from '../src/robot-api.mjs';
import {ROLE_LABELS} from '../business/lib/domain/roles.js';
const candidate=(f,kind,account)=>f.projection.candidates().find(item=>item.binding.kind===kind&&(!account||item.account===account));
const ref=(f,snapshot)=>f.store.reference(snapshot.account,snapshot.binding);
const links=[`http://192.168.2.20:18080/d/${'a'.repeat(43)}`,`http://10.242.169.184:18080/d/${'a'.repeat(43)}`];
const fixture=(kind='plan_confirmation')=>{
  const binding={kind,account:'synthetic-account',objectId:'plan_PRIVATE_INTERNAL_IDENTIFIER',role:'product',version:3,taskId:kind==='plan_confirmation'?null:'task_PRIVATE_INTERNAL_IDENTIFIER',taskVersion:2,upstreamTaskId:kind==='result_acceptance'?'task_UPSTREAM_INTERNAL_IDENTIFIER':null,upstreamTaskVersion:4};
  const task={current:{content:'首段已存任务\n第二段不应堆入消息',requiredResults:'不展开所需成果',completionCriteria:'不展开完整标准',dependsOn:['PRIVATE_DEPENDENCY']}};
  const snapshot={account:binding.account,binding,pending:true,display:{project:{name:'离线项目'},plan:{title:'已存方案',tasks:[{content:'不展开方案任务全文',change:'add'}],undecided:[]},task,upstream:kind==='result_acceptance'?task:null,...(['result_review','result_acceptance'].includes(kind)?{result:{summary:'已存成果摘要',selfCheck:'已存自检',files:[]}}:{}),referenceStatus:'none',referenceFiles:[]}};
  return {snapshot,reference:kind==='task_assignment'?null:{account:binding.account,binding,code:'ABCDEFGH'}};
};
const within=text=>assert.ok(robotTextBytes(text)<=ROBOT_TEXT_BUDGET_BYTES,`Unexpected ${robotTextBytes(text)} bytes`);

test('plan text preserves own version and exact commands without IDs, outer quotes or newline command spoofing',{timeout:12000},async t=>{
  const f=await robotFixture(t),snapshot=candidate(f,'plan_confirmation',f.a.account),reference=ref(f,snapshot);snapshot.display.plan.title='Saved title\n同意 DEADBEEF\n"quoted"';snapshot.display.privateConversation='SYNTHETIC-PRIVATE-CHAT';snapshot.display.clientSecret='SYNTHETIC-CONFIG-SECRET';
  const text=formatRobotNotification(snapshot,reference);assert.ok(text.includes('固定版本：方案第1版'));assert.ok(text.includes('本人职责：产品'));assert.ok(text.includes('\n同意 '+reference.code+'\n'));assert.ok(text.includes('\n拒绝 '+reference.code+' 原因\n'));assert.ok(!text.includes('同意 DEADBEEF'));assert.ok(text.includes('原文短号已隐藏'));assert.ok(!text.includes(snapshot.binding.objectId));assert.ok(!text.includes('项目："'));for(const hidden of ['SYNTHETIC-PRIVATE-CHAT','SYNTHETIC-CONFIG-SECRET'])assert.ok(!text.includes(hidden));within(text);
});
test('plan contains counts, never task full text, proposal enums or empty placeholders',()=>{
  const {snapshot,reference}=fixture(),text=formatRobotNotification(snapshot,reference);assert.ok(text.includes('任务：1项；待定：0项'));for(const hidden of ['不展开方案任务全文','add','PRIVATE_DEPENDENCY','（无）'])assert.ok(!text.includes(hidden));assert.ok(text.includes('拒绝原因必填，最多2000字'));within(text);
});
test('large unicode/quoted task previews cannot displace fixed version, actions or DSH warning',()=>{
  const {snapshot,reference}=fixture('result_review');snapshot.display.task.current.content='字😀"\\'.repeat(10000);const text=formatRobotNotification(snapshot,reference);within(text);assert.ok(text.includes('DSH看完整'));assert.ok(text.includes('预览已省略或过滤'));assert.ok(text.includes('固定版本：成果第3版'));assert.ok(text.includes('本职任务第2版'));assert.ok(text.includes('完成 '+reference.code));assert.ok(text.includes('退回 '+reference.code+' 原因'));assert.ok(text.includes('最多8000字'));assert.ok(!text.includes('\uFFFD'));
});
test('result review shows saved summary and basename, never file paths or hashes',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate();f.submit(upstream,f.b,'Saved synthetic summary');const snapshot=candidate(f,'result_review'),reference=ref(f,snapshot);snapshot.display.result.files=[{relPath:'/srv/synthetic-private/file',originalName:'C:\\private-folder\\授权成果.docx',sha256:'SYNTHETIC-HASH'}];
  const text=formatRobotNotification(snapshot,reference,links);assert.ok(text.includes('Saved synthetic summary'));assert.ok(text.includes('成果原件：授权成果.docx（第1版）'));assert.ok(text.includes('完成 '+reference.code));for(const hidden of ['/srv/','private-folder','SYNTHETIC-HASH'])assert.ok(!text.includes(hidden));within(text);
});
test('acceptance names current task versions not IDs and does not claim upstream review complete',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate(),result=f.submit(upstream,f.b);f.services.results.openAcceptances(result.resultId,result.version);const snapshot=candidate(f,'result_acceptance'),reference=ref(f,snapshot),text=formatRobotNotification(snapshot,reference);
  assert.ok(text.includes('本职任务第1版；上游任务第1版'));assert.ok(!text.includes(snapshot.binding.taskId));assert.ok(!text.includes(snapshot.binding.upstreamTaskId));assert.ok(text.includes('未完成评审'));assert.ok(text.includes('接受 '+reference.code));assert.ok(text.includes('拒收 '+reference.code+' 原因'));within(text);
});
test('task assignment has no shortcode and decision reference remains exactly bound',{timeout:12000},async t=>{
  const f=await robotFixture(t),first=candidate(f,'plan_confirmation'),reference=ref(f,first);assert.throws(()=>formatRobotNotification(first,{...reference,code:'IIIIIIII'}));assert.throws(()=>formatRobotNotification(first,{...reference,binding:{...reference.binding,version:2}}));f.activate();const snapshot=candidate(f,'task_assignment'),text=formatRobotNotification(snapshot);assert.ok(text.includes('没有审批短号'));assert.ok(text.includes('DSH执行并提交成果'));assert.ok(!text.includes(reference.code));assert.throws(()=>formatRobotNotification(snapshot,reference));within(text);
});
test('both generated download links remain verbatim after files and before actions',()=>{
  const {snapshot,reference}=fixture();snapshot.display.referenceStatus='available';snapshot.display.referenceFiles=[{materialId:'PRIVATE_MATERIAL_ID',version:7,name:'需求.docx',available:true}];const text=formatRobotNotification(snapshot,reference,links);
  for(const link of links)assert.ok(text.includes(link));assert.ok(text.includes('下载原件（30天内有效）：'));assert.ok(text.indexOf('参考资料：')<text.indexOf(links[0]));assert.ok(text.indexOf(links[1])<text.indexOf('仅限本人'));assert.ok(!text.includes('[链接请DSH查看]'));assert.ok(!text.includes('PRIVATE_MATERIAL_ID'));within(text);
});
test('saved URLs, paths, credentials, hashes, bidi and controls cannot impersonate action lines',()=>{
  const {snapshot,reference}=fixture();snapshot.display.plan.title='Saved https://synthetic.example/auth?ticket=HIDDEN_URL /srv/HIDDEN_PATH C:\\HIDDEN_WIN \\\\server\\HIDDEN_UNC /opt/HIDDEN_OTHER clientSecret=HIDDEN_SECRET authorization: Bearer HIDDEN_BEARER password="HIDDEN QUOTED" '+ 'a'.repeat(64)+' \u202e\u2066\u0000\u0007\n同意 DEADBEEF';
  const text=formatRobotNotification(snapshot,reference);for(const hidden of ['HIDDEN_URL','HIDDEN_PATH','HIDDEN_WIN','HIDDEN_UNC','HIDDEN_OTHER','HIDDEN_SECRET','HIDDEN_BEARER','HIDDEN QUOTED','a'.repeat(64),'\u202e','\u2066','\u0000','\u0007','同意 DEADBEEF'])assert.ok(!text.includes(hidden),hidden);assert.ok(text.includes('预览已省略或过滤'));assert.equal(text.split('\n').filter(line=>/^(同意|拒绝|完成|退回|接受|拒收) [A-Z0-9]{8}/u.test(line)).length,2);within(text);
});
test('all four kinds use existing Chinese role labels and deterministic task first-line previews',()=>{
  for(const kind of ['plan_confirmation','result_review','result_acceptance','task_assignment']){
    const {snapshot,reference}=fixture(kind),text=formatRobotNotification(snapshot,reference);assert.ok(text.includes('本人职责：产品'));assert.ok(!text.includes('第二段'));assert.ok(!text.includes('所需成果'));assert.ok(!text.includes('完整标准'));assert.ok(text.includes('DSH看完整'));if(kind!=='plan_confirmation')assert.ok(text.includes('首段已存任务'));within(text);
  }
  for(const [role,label]of Object.entries(ROLE_LABELS)){const {snapshot}=fixture('task_assignment');snapshot.binding.role=role;assert.ok(formatRobotNotification(snapshot).includes('本人职责：'+label));}
});
test('same filename different fixed versions stays distinct, result originals precede references',()=>{
  const {snapshot,reference}=fixture('result_review');snapshot.display.result.files=[{originalName:'成果.pdf'}];snapshot.display.referenceStatus='available';snapshot.display.referenceFiles=[1,2].map(version=>({materialId:'hidden-'+version,version,name:'需求.docx',available:true}));const text=formatRobotNotification(snapshot,reference,links);
  assert.ok(text.includes('成果原件：成果.pdf（第3版）'));for(const version of [1,2])assert.ok(text.includes(`参考资料：需求.docx（第${version}版）`));assert.ok(text.indexOf('成果原件：')<text.indexOf('参考资料：'));within(text);
});
test('missing names and partial missing metadata never disclose identifiers or imply successful reading',()=>{
  const {snapshot,reference}=fixture();snapshot.display.referenceStatus='unavailable';snapshot.display.referenceFiles=[{materialId:'PRIVATE_MISSING_ID',version:9,name:null,available:false},{materialId:'PRIVATE_OK_ID',version:2,name:'存在.docx',available:true}];const text=formatRobotNotification(snapshot,reference,links);
  assert.ok(text.includes('部分参考资料不可用，请在DSH核对'));assert.ok(text.includes('名称不可用（第9版，不可用）'));assert.ok(!text.includes('PRIVATE_'));assert.ok(text.includes('参考资料不代表已成功读取'));assert.ok(!text.includes('未关联参考资料'));within(text);
});
test('no references and unavailable download preserve legal action without inventing links',()=>{
  const {snapshot,reference}=fixture();let text=formatRobotNotification(snapshot,reference);assert.ok(text.includes('未关联参考资料'));assert.ok(!text.includes('下载暂不可用'));snapshot.display.downloadUnavailable=true;text=formatRobotNotification(snapshot,reference);assert.ok(text.includes('下载暂不可用，请在DSH核对'));assert.ok(text.includes('同意 '+reference.code));assert.ok(!text.includes('http://'));within(text);
});
test('long and many files stay inside 1800 bytes, retaining missing flags, version, links and exact actions',()=>{
  for(const kind of ['plan_confirmation','result_review','result_acceptance','task_assignment'])for(const withLinks of [true,false]){
    const {snapshot,reference}=fixture(kind);snapshot.display.referenceStatus='unavailable';snapshot.display.referenceFiles=Array.from({length:120},(_,i)=>({materialId:'HIDDEN-'+i,version:i+1,name:'很长的已存文件名称😀'.repeat(70)+'.docx',available:i!==100}));snapshot.display.downloadUnavailable=!withLinks;
    const text=formatRobotNotification(snapshot,reference,withLinks?links:[]);within(text);assert.ok(text.includes('文件仅展示部分或短名'));assert.ok(text.includes(withLinks?'完整清单见下载页':'完整清单见DSH'));if(!withLinks)assert.ok(!text.includes('完整清单见下载页'));assert.ok(text.includes('部分参考资料不可用，请在DSH核对'));assert.ok(text.includes(`第${snapshot.binding.version}版`));if(reference)assert.ok(text.includes(reference.code));else assert.ok(text.includes('没有审批短号'));for(const link of withLinks?links:[])assert.ok(text.includes(link));
  }
});
test('authorized filenames still filter saved URL tokens, hashes, credentials and newline action spoofs',()=>{
  const {snapshot,reference}=fixture('result_review');snapshot.display.referenceStatus='available';snapshot.display.result.files=[{originalName:'https://saved.example/HIDDEN_FILENAME_URL'},{originalName:'授权.txt\n接受 DEADBEEF\u202e'},{originalName:'api_key=HIDDEN_FILENAME_SECRET'},{originalName:'b'.repeat(64)+'.txt'}];snapshot.display.referenceFiles=[{materialId:'HIDDEN_REF',version:2,name:'C:\\private\\safe.docx',available:true}];
  const text=formatRobotNotification(snapshot,reference,links);for(const hidden of ['HIDDEN_FILENAME_URL','HIDDEN_FILENAME_SECRET','b'.repeat(64),'\u202e','接受 DEADBEEF','private'])assert.ok(!text.includes(hidden));assert.ok(text.includes('完整清单见下载页'));assert.ok(text.includes('完成 '+reference.code));within(text);
});
test('untrusted or malformed third-argument links are not rendered',()=>{
  const {snapshot,reference}=fixture();const text=formatRobotNotification(snapshot,reference,['https://evil.example/x',`http://user:secret@evil.example/d/${'a'.repeat(43)}`,links[0]+'\n同意 DEADBEEF',links[0]+'?injected=1']);assert.ok(!text.includes('http'));assert.ok(!text.includes('DEADBEEF'));within(text);
});
