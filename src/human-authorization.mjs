import {createHash} from 'node:crypto';
import {AccessError} from './protocol.mjs';
import {currentHumanInstruction} from './human-intent.mjs';
export const humanAuthorizationCapability=()=>({version:3});
export const READ_ONLY_TOOLS=new Set(['session_whoami','project_list','project_get','material_list','material_read','material_versions','analysis_begin','analysis_get','analysis_list','plan_get','plan_history','plan_list','task_list','task_get','task_versions','task_origin','progress_list','result_list','result_pending','todo_list','notice_list','todo_unread','trace','attachment_read']);
const forbidden=new Set(['plan_confirm','result_review','result_accept']);
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const fail=message=>{throw new AccessError(-32602,message);};
// One vocabulary for the words a person and the model both see: 上传/归档/成果/进展. The labels name what
// the operation does, the phrases are the exact sentence a person can paste to authorize it.
export const HUMAN_TOOL_LABELS=Object.freeze({
 analysis_submit:'提交需求分析',plan_register:'登记正式计划',plan_revise:'修订计划',result_submit:'提交成果',
 progress_add:'记录进展',project_update_details:'更新项目背景或目标',todo_mark_read:'把通知标为已读',result_acceptance_open:'发起验收'});
const humanPhrases=Object.freeze({
 analysis_submit:'提交这份需求分析',plan_register:'提交方案',plan_revise:'提交修订后的方案',result_submit:'提交成果',
 progress_add:'记录进展：<这次的进展>',project_update_details:'更新项目背景：<新的背景>',todo_mark_read:'把通知标为已读',result_acceptance_open:'发起验收'});
// Write tools stay visible so the model can plan a real operation and ask for it; the per-call guard is
// what refuses, and the refusal tells the person the exact sentence that would authorize it.
export const BUSINESS_WRITE_TOOLS=new Set(['analysis_submit','plan_register','plan_revise','result_submit','progress_add','project_update_details','todo_mark_read','result_acceptance_open']);
export function humanVisibleTool(name){return !forbidden.has(name)&&(READ_ONLY_TOOLS.has(name)||BUSINESS_WRITE_TOOLS.has(name)||name==='attachment_archive');}
export function humanToolDenial(name){
 const label=HUMAN_TOOL_LABELS[name]??name,phrase=humanPhrases[name];
 return '当前人类消息未授权「'+label+'」，所以没有执行；草稿不能登记业务，模型不能代本人确认。要现在做的话，请单独发一句：'+(phrase??label)+'。';
}
export function deriveHumanPolicy(text){
 const instruction=currentHumanInstruction(text),writes=new Set(),kinds=new Set();
 // Judged clause by clause: one clause people phrase as a condition or a deferral must not authorize
 // anything, and it must not void the clauses that do carry a clear instruction.
 const hypothetical=/^(?:如果|假如|倘若|要是|万一)/u;
 const deferral=/(?:以后|稍后|改天|回头|等[^\n]{0,24}?(?:再|之后|后)|待[^\n]{0,24}?(?:再|后))/u;
 const negative=/(?:不要|别|勿|取消|撤销|不必|不用|无需|不需要|不想|不打算|禁止|先不|暂不|不允许|不是|并不|未授权|没有授权)/u;
 const commitVerb=/提交|登记|记录|更新|标记|标为|发起|申请|启动/u;
 const clauses=instruction.split(/[，,。！？；;\n]+|(?:并且|然后|并)(?=提交|登记)/u).map(c=>c.trim()).filter(Boolean);
 const informational=/查询|检查|查看|阅读|读取|告诉我|解释|说明如何|状态|流程|步骤|方式|是否|如何|怎么|为什么|什么意思|什么时候|(?:吗|么|呢|\?)\s*$/u;
 const courtesy='(?:(?:请|麻烦|帮我|替我|劳驾|烦请|你需要|你要|我需要|我希望|需要|希望|务必|现在|直接|立即|马上|先|只|仅)\\s*)*';
 const commit=new RegExp('^'+courtesy+'(?:(?:提交|登记)|(?:把|将)[^，,。！？；;\\n]{1,60}(?:提交|登记)(?:一下|吧|$))','u');
 const progress=new RegExp('^'+courtesy+'(?:记录|登记|更新|添加)[^，,。！？；;\\n]{0,30}(?:进展|进度)','u');
 const details=new RegExp('^'+courtesy+'(?:更新|修改|补充|设置)[^，,。！？；;\\n]{0,20}(?:项目背景|项目目标|背景|目标)','u');
 const markRead=new RegExp('^'+courtesy+'(?:(?:把|将)[^，,。！？；;\\n]{0,30})?(?:标记|标为|设为)[^，,。！？；;\\n]{0,12}已读','u');
 const acceptance=new RegExp('^'+courtesy+'(?:(?:为|对)[^，,。！？；;\\n]{1,40})?(?:发起|申请|启动)[^，,。！？；;\\n]{0,30}验收','u');
 for(const clause of clauses){
  if(informational.test(clause.split(/[:：]/u)[0]))continue;
  if(hypothetical.test(clause)&&commitVerb.test(clause))continue;
  if(deferral.test(clause)||negative.test(clause))continue;
  if(acceptance.test(clause)){kinds.add('acceptance');continue;}
  if(progress.test(clause)){kinds.add('progress');continue;}
  if(details.test(clause)){kinds.add('details');continue;}
  if(markRead.test(clause)&&/通知|待办/u.test(clause)){kinds.add('read-notice');continue;}
  if(!commit.test(clause))continue;
  if(/成果/u.test(clause))kinds.add('result');
  else if(/分析/u.test(clause))kinds.add('analysis');
  else if(/方案|计划/u.test(clause))kinds.add(/修订|修改后的|修正后的|调整后的/u.test(clause)?'revise':'plan');
 }
 // Authorization is the union of what the clauses actually asked for; several clear instructions in one
 // message used to collapse to none, which left the model unable to act on a legitimate request.
 const kind=kinds.size===0?'draft':kinds.size===1?[...kinds][0]:'mixed';
 for(const each of kinds)for(const name of ({analysis:['analysis_submit'],plan:['plan_register'],revise:['plan_revise'],result:['result_submit'],progress:['progress_add'],details:['project_update_details'],'read-notice':['todo_mark_read'],acceptance:['result_acceptance_open']}[each]??[]))writes.add(name);
 return Object.freeze({kind,writes});
}
export function allowsHumanTool(request,name){return !forbidden.has(name)&&(READ_ONLY_TOOLS.has(name)||request?.policy?.writes.has(name));}
/** Attachment inventory lives server-side per session; no per-turn client scopes remain.
 * Attachments are read/archived by the model through tools guarded by attachment ownership,
 * not by text-authorization parsing. */
export function prepareHumanRequest({text,authorization,required=false,projectId,manifests=[],sessionId,account,requestId}){
 if(required&&!authorization)fail('当前消息缺少人类授权元数据；请升级配套客户端后重试。');
 let messageId='legacy:'+requestId;
 if(authorization){
  if(!authorization||typeof authorization!=='object'||Array.isArray(authorization))fail('Invalid human authorization');
  if(!['version','messageId','textSha256','projectId'].every(k=>k in authorization)||Object.keys(authorization).some(k=>!['version','messageId','textSha256','projectId'].includes(k)))fail('Invalid human authorization');
  if(authorization.version!==3)fail('Unsupported human authorization capability; matching client and server releases required');
  if(typeof authorization.messageId!=='string'||!authorization.messageId.trim()||authorization.messageId.length>200)fail('Invalid human messageId');
  if(authorization.textSha256!==hash(text))fail('Human authorization text digest mismatch');
  if(authorization.projectId!==projectId)fail('Human authorization project mismatch');
  messageId=authorization.messageId;
 }
 const policy=deriveHumanPolicy(text);
 return Object.freeze({sessionId,account,requestId,projectId,messageId,humanText:text,textSha256:hash(text),policy,manifests,version:authorization?3:1});
}
