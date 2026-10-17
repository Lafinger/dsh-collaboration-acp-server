import {DECISION_CODE_ALPHABET} from './robot-command.mjs';
import {robotMetadataHash} from './robot-store.mjs';
import {ROBOT_TEXT_BUDGET_BYTES} from './robot-api.mjs';
const codePattern=new RegExp(`^[${DECISION_CODE_ALPHABET}]{8}$`);
const labels={plan_confirmation:'本人方案确认',result_review:'本人职责成果评审',result_acceptance:'本人下游输入接收',task_assignment:'本人当前任务提醒'};
export const robotTextBytes=text=>Buffer.byteLength(JSON.stringify({content:text}),'utf8');
/** Whitelisted saved facts only. Delimit text; never interpolate messages, paths, auth or errors.
 * Redactions are conservative presentation filters, not a general-purpose secret/DLP guarantee.
 */
export function formatRobotNotification(snapshot,reference=null){
  const b=snapshot?.binding,d=snapshot?.display;
  if(!b||!d||!labels[b.kind]||snapshot.pending!==true||snapshot.account!==b.account||!Number.isSafeInteger(b.version)||b.version<1)throw new Error('Current notification unavailable');
  const informational=b.kind==='task_assignment';
  if(informational?reference!==null:!reference||reference.account!==b.account||!codePattern.test(reference.code)||robotMetadataHash(reference.binding)!==robotMetadataHash(b))throw new Error('Fixed notification reference unavailable');
  let incomplete=false;
  const q=(value,max=500)=>{
    if(typeof value!=='string')return '（无）';
    let text=value.replace(/\b(?:https?|dingtalk):\/\/[^\s"'<>]+/giu,'[链接请DSH查看]').replace(/(?:[A-Za-z]:[\\/]|\/(?:srv|home|root|etc|var|tmp)\/)[^\s"'<>]*/gu,'[路径请DSH查看]').replace(/\b(?:clientSecret|appSecret|accessToken|refreshToken|authorization|password|api[_-]?key|ticket)\b\s*[:=]\s*["']?[^\s"',;]+/giu,'[敏感字段请DSH查看]').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,'�');
    if(text!==value)incomplete=true;const points=Array.from(text);if(points.length>max){text=points.slice(0,max).join('')+'…';incomplete=true;}return JSON.stringify(text);
  };
  const head=[`【${labels[b.kind]}】`,`项目：${q(d.project.name,60)}`,`本人职责：${q(b.role,30)}`,`固定对象：${q(b.objectId,200)} v${b.version}`];
  if(b.taskId)head.push(`本职任务：${q(b.taskId,200)} v${b.taskVersion}`);
  if(b.upstreamTaskId)head.push(`上游任务：${q(b.upstreamTaskId,200)} v${b.upstreamTaskVersion}`);
  const lines=[];
  const task=(name,view)=>{if(!view)return;lines.push(`${name}内容：${q(view.current.content)}`,`${name}所需成果：${q(view.current.requiredResults)}`,`${name}完成标准：${q(view.current.completionCriteria)}`,`${name}当前依赖：${view.current.dependsOn.map(id=>q(id,200)).join('，')||'无'}`);};
  if(b.kind==='plan_confirmation'){
    lines.push(`方案标题：${q(d.plan.title)}`,`职责依据：${q(d.plan.rolesReason)}`,`待定项数量：${d.plan.undecided.length}`);
    for(const proposal of d.plan.tasks)lines.push(`任务原文 ${q(proposal.role,30)}／${q(proposal.change,20)}：${q(proposal.content)}；所需成果：${q(proposal.requiredResults)}；完成标准：${q(proposal.completionCriteria)}；依赖：${proposal.dependsOn.map(id=>q(id,200)).join('，')||'无'}`);
  }else{
    task('本职',d.task);
    if(d.upstream)task('上游',d.upstream);
    if(d.result){lines.push(`成果摘要：${q(d.result.summary)}`,`已保存自检：${q(d.result.selfCheck)}`,`附件：${d.result.files.length}个（不在私聊展开）`);if(d.result.files.length)incomplete=true;}
    if(b.kind==='result_acceptance')lines.push(`上游本职评审：${d.review?.outcome==='complete'?'已完成':d.review?.outcome==='return'?'已退回':'未完成评审'}（不是接收前置条件的替代判断）`);
  }
  const commands=informational?'这是任务提醒，没有审批短号；请在DSH执行并提交成果，不接受直接回复“完成”。':b.kind==='plan_confirmation'?`同意 ${reference.code}\n拒绝 ${reference.code} 原因（必填，最多2000字）`:b.kind==='result_review'?`完成 ${reference.code}\n退回 ${reference.code} 原因（必填，最多8000字）`:`接受 ${reference.code}\n拒收 ${reference.code} 原因（必填，最多8000字）`;
  const footer=`\n${informational?'办理方式':'仅限本人，单条私聊发送以下一个完整命令'}：\n${commands}\n仅针对上列固定版本；资料、分析、编修、执行与成果提交仍在DSH。`;
  const render=(body,partial)=>`${head.join('\n')}\n业务原文预览${partial?'（不完整）':''}：\n${body}${partial?'\n预览不完整：请先在DSH核对同一固定版本及附件，勿据片段决定。':''}${footer}`;
  const body=lines.join('\n');if(robotTextBytes(render(body,incomplete))<=ROBOT_TEXT_BUDGET_BYTES)return render(body,incomplete);
  if(robotTextBytes(render('',true))>ROBOT_TEXT_BUDGET_BYTES)throw new Error('Notification framing exceeds safe budget');
  const points=Array.from(body).slice(0,ROBOT_TEXT_BUDGET_BYTES);let low=0,high=points.length;
  while(low<high){const mid=Math.ceil((low+high)/2);if(robotTextBytes(render(points.slice(0,mid).join('')+'…',true))<=ROBOT_TEXT_BUDGET_BYTES)low=mid;else high=mid-1;}
  return render(points.slice(0,low).join('')+'…',true);
}
