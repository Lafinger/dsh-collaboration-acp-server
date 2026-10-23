import {ROBOT_CALLBACK_TOPIC} from './robot-api.mjs';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const opaque=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value;
const rejected=error=>({ok:false,error});

/** Only the private Stream adapter supplies `source`; never derive it from frame/body fields.
 * Returns the minimum native-text envelope. Does not enroll a member, extract quoted commands,
 * retain a webhook/body, interpret a command, or confer any business permission.
 */
export function normalizeRobotEvent(frame,binding,source,{now=Date.now()}={}){
  if(!binding||!opaque(binding.scopeKey,512)||!opaque(binding.corpId,200)||!opaque(binding.robotCode,200)||!source||source.scopeKey!==binding.scopeKey||!Number.isSafeInteger(source.notBefore)||!Number.isSafeInteger(now)||source.notBefore<0||now<0)return rejected('untrusted-source');
  if(!plain(frame)||frame.type!=='CALLBACK'||frame.headers?.topic!==ROBOT_CALLBACK_TOPIC||!opaque(frame.headers?.messageId,2048)||typeof frame.data!=='string'||Buffer.byteLength(frame.data,'utf8')>65536)return rejected('unsupported-frame');
  let value;try{value=JSON.parse(frame.data);}catch{return rejected('malformed-message');}
  if(!plain(value)||value.robotCode!==binding.robotCode||value.chatbotCorpId!==binding.corpId||value.senderCorpId!==binding.corpId)return rejected('untrusted-scope');
  if(value.conversationType!=='1'||value.msgtype!=='text'||!plain(value.text)||typeof value.text.content!=='string')return rejected('unsupported-message');
  // Reject explicit forwarding markers. Never read forwarded/quoted/original content as the command.
  if(['isForward','isForwarded','forward','forwardMessages','forwardContent','forwardInfo'].some(key=>Object.hasOwn(value,key)&&value[key]!==false))return rejected('unsupported-message');
  if(!opaque(value.senderStaffId,200)||!opaque(value.msgId,2048))return rejected('missing-message-identity');
  const createdAt=typeof value.createAt==='string'&&/^[0-9]{13}$/.test(value.createAt)?Number(value.createAt):value.createAt;
  if(!Number.isSafeInteger(createdAt)||createdAt<source.notBefore||createdAt>now+5000)return rejected('stale-message');
  return {ok:true,event:Object.freeze({msgId:value.msgId,userId:value.senderStaffId,createdAt,content:value.text.content})};
}

/** Transport acknowledgement only, never an approval/result. Echo opaque outer id, not inner msgId. */
export function robotAcknowledgement(frame,data={response:null}){
  if(!opaque(frame?.headers?.messageId,2048))return null;
  return {code:200,headers:{contentType:'application/json',messageId:frame.headers.messageId},message:'OK',data:JSON.stringify(data)};
}
