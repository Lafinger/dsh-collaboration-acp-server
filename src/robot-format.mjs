import {DECISION_CODE_ALPHABET} from './robot-command.mjs';
import {robotMetadataHash} from './robot-store.mjs';
import {ROBOT_TEXT_BUDGET_BYTES} from './robot-api.mjs';
import {ROLE_LABELS} from '../business/lib/domain/roles.js';
const codePattern=new RegExp(`^[${DECISION_CODE_ALPHABET}]{8}$`);
const labels={plan_confirmation:'方案确认',result_review:'成果评审',result_acceptance:'下游接收',task_assignment:'任务提醒'};
export const robotTextBytes=text=>Buffer.byteLength(JSON.stringify({content:text}),'utf8');
/** Saved facts only; previews are deterministic, not summaries or evidence of having read a file.
 * These conservative presentation filters are not a general-purpose secret/DLP guarantee.
 */
export function formatRobotNotification(snapshot,reference=null,downloadLinks=[]){
  const b=snapshot?.binding,d=snapshot?.display;
  if(!b||!d||!labels[b.kind]||snapshot.pending!==true||snapshot.account!==b.account||!Number.isSafeInteger(b.version)||b.version<1||!Object.hasOwn(ROLE_LABELS,b.role))throw new Error('Current notification unavailable');
  const informational=b.kind==='task_assignment';
  if(informational?reference!==null:!reference||reference.account!==b.account||!codePattern.test(reference.code)||robotMetadataHash(reference.binding)!==robotMetadataHash(b))throw new Error('Fixed notification reference unavailable');
  let filtered=false;
  const safe=(value,max)=>{
    if(typeof value!=='string'||!value.trim())return '';
    let text=value.replace(/\b(?:https?|dingtalk):\/\/[^\s"'<>]+/giu,'[链接请DSH查看]')
      .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:srv|home|root|etc|var|tmp)\/)[^\s"'<>]*/gu,'[路径请DSH查看]')
      .replace(/(?:\.{1,2}[\\/]|\/)[^\s"'<>]+/gu,'[路径请DSH查看]')
      .replace(/\bauthorization\b\s*[:=]\s*["']?Bearer\s+[^\s"',;]+/giu,'[敏感字段请DSH查看]')
      .replace(/\b(?:clientSecret|appSecret|accessToken|refreshToken|authorization|password|api[_-]?key|ticket)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,'[敏感字段请DSH查看]')
      .replace(/\b(?:[A-Za-z0-9_-]{32,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|(?:task|plan|result|material|analysis|project)[_-][A-Za-z0-9_-]{16,})\b/giu,'[标识请DSH查看]')
      .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu,'')
      .replace(/\r\n|[\r\n\u0085\u2028\u2029]/gu,' ⏎ ')
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu,' ')
      // Saved commands are quoted facts, never an executable-looking command in the action block.
      .replace(/(同意|拒绝|完成|退回|接受|拒收)[ \t]+([A-Za-z0-9]{8})(?![A-Za-z0-9])/gu,'$1〔原文短号已隐藏〕').trim();
    if(text!==value)filtered=true;
    const points=Array.from(text);if(points.length>max){text=points.slice(0,max).join('')+'…';filtered=true;}
    return text;
  };
  const preview=(label,value,max=70)=>{
    if(typeof value!=='string'||!value.trim())return '';
    // First nonempty saved line only; never turn later paragraphs into an invented abstract.
    const first=value.split(/\r\n|[\r\n\u0085\u2028\u2029]/u).find(line=>line.trim())??'';
    if(first!==value)filtered=true;
    const text=safe(first,max);return text?`${label}预览：${text}`:'';
  };
  const fixed=[`项目：${safe(d.project?.name,36)||'请在DSH核对'}`,`本人职责：${ROLE_LABELS[b.role]}`];
  const objectName=b.kind==='plan_confirmation'?'方案':informational?'任务':'成果';
  fixed.push(`固定版本：${objectName}第${b.version}版`);
  if(b.taskId&&!informational)fixed.push(`本职任务第${b.taskVersion}版${b.upstreamTaskId?`；上游任务第${b.upstreamTaskVersion}版`:''}`);
  const title=b.kind==='plan_confirmation'?safe(d.plan?.title,48):'';
  const head=[`【${labels[b.kind]}】${title?` ${title}`:''}`,...fixed].join('\n');
  // These URLs come only from the download service argument, never from saved business fields.
  const links=[...new Set((Array.isArray(downloadLinks)?downloadLinks:[]).filter(link=>typeof link==='string'&&/^http:\/\/(?:[A-Za-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]{1,5})?\/d\/[A-Za-z0-9_-]{43}$/iu.test(link)))].slice(0,2);
  const linkBlock=links.length?`下载原件（30天内有效）：\n${links.join('\n')}`:'';
  const facts=[];
  if(b.kind==='plan_confirmation'){
    facts.push(`任务：${d.plan.tasks.length}项；待定：${d.plan.undecided.length}项`);
  }else{
    const task=preview('本职任务',d.task?.current?.content);if(task)facts.push(task);
    if(d.upstream){const upstream=preview('上游任务',d.upstream.current?.content,50);if(upstream)facts.push(upstream);}
    if(d.result){for(const [label,value]of [['成果',d.result.summary],['自检',d.result.selfCheck]]){const text=preview(label,value,55);if(text)facts.push(text);}}
  }
  const important=[];
  if(b.kind==='result_acceptance')important.push(`上游本职评审：${d.review?.outcome==='complete'?'已完成':d.review?.outcome==='return'?'已退回':'未完成评审'}；接收仍须单独决定。`);
  const refs=Array.isArray(d.referenceFiles)?d.referenceFiles:[],results=Array.isArray(d.result?.files)?d.result.files:[];
  const hasRefs=refs.length>0||d.referenceStatus==='available'||d.referenceStatus==='unavailable';
  if(!hasRefs)important.push('未关联参考资料');
  if(d.referenceStatus==='unavailable'||refs.some(file=>file.available!==true))important.push('部分参考资料不可用，请在DSH核对');
  if(results.some(file=>file.available===false))important.push('部分成果原件不可用，请在DSH核对');
  if(d.downloadUnavailable===true||((results.length||refs.some(file=>file.available===true))&&!links.length))important.push('下载暂不可用，请在DSH核对');
  const fileRows=[];
  let shortenedFile=false;
  const fileName=(value)=>{
    // Authorized disclosure is basename only. Never fall back to relPath, hash or materialId.
    if(typeof value!=='string')return '';
    // Redact a saved URL as a whole before extracting a basename; its last segment can be a secret.
    const basename=/\b(?:https?|dingtalk):\/\//iu.test(value)?value:value.split(/[\\/]/u).at(-1);
    const name=safe(basename,60);if(name!==basename)shortenedFile=true;
    return name;
  };
  const addFiles=(files,label,name,version)=>{
    for(const file of files){const basename=fileName(file[name]);fileRows.push(`${label}：${basename||'名称不可用'}（第${version(file)}版${file.available===false?'，不可用':''}）`);}
  };
  addFiles(results,'成果原件','originalName',()=>b.version);
  addFiles(refs,'参考资料','name',file=>Number.isSafeInteger(file.version)&&file.version>0?file.version:'待核对');
  const commands=informational?'这是任务提醒，没有审批短号；请在DSH执行并提交成果，不接受直接回复“完成”。':b.kind==='plan_confirmation'?`同意 ${reference.code}\n拒绝 ${reference.code} 原因\n拒绝原因必填，最多2000字。`:b.kind==='result_review'?`完成 ${reference.code}\n退回 ${reference.code} 原因\n退回原因必填，最多8000字。`:`接受 ${reference.code}\n拒收 ${reference.code} 原因\n拒收原因必填，最多8000字。`;
  const footer=`${informational?'办理方式':'仅限本人，单条私聊发送一个完整命令'}：\n${commands}\n仅针对上述固定版本。`;
  const checklist=links.length?'完整清单见下载页':'完整清单见DSH';
  const render=(shownFacts,shownFiles,partial)=>[head,...shownFacts,...shownFiles,...important,
    ...(partial?[`文件仅展示部分或短名；${checklist}。`]:[]),
    ...(filtered?['预览已省略或过滤；请在DSH核对。']:[]),
    'DSH看完整内容并核对固定版本；参考资料不代表已成功读取。',linkBlock,footer].filter(Boolean).join('\n');
  // Omit optional whole rows, not bytes from actions/versions/missing flags. Always label partial lists.
  let shownFacts=[...facts],shownFiles=[...fileRows],partial=shortenedFile;
  while(robotTextBytes(render(shownFacts,shownFiles,partial))>ROBOT_TEXT_BUDGET_BYTES){
    if(shownFacts.length)shownFacts.pop();
    else if(shownFiles.length){shownFiles.pop();partial=true;}
    else throw new Error('Notification framing exceeds safe budget');
  }
  return render(shownFacts,shownFiles,partial);
}
