import {randomInt} from 'node:crypto';

// A locator, never a credential. Persistence must enforce global uniqueness and never reuse it.
export const DECISION_CODE_ALPHABET='23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const codePattern=new RegExp(`^[${DECISION_CODE_ALPHABET}]{8}$`);
const actions=Object.freeze({
  同意:Object.freeze({kind:'plan_confirmation',outcome:'agree',negative:false,maxReason:2000}),
  拒绝:Object.freeze({kind:'plan_confirmation',outcome:'reject',negative:true,maxReason:2000}),
  完成:Object.freeze({kind:'result_review',outcome:'complete',negative:false,maxReason:8000}),
  退回:Object.freeze({kind:'result_review',outcome:'return',negative:true,maxReason:8000}),
  接受:Object.freeze({kind:'result_acceptance',outcome:'accept',negative:false,maxReason:8000}),
  拒收:Object.freeze({kind:'result_acceptance',outcome:'reject',negative:true,maxReason:8000}),
});
const invalid=()=>({ok:false,error:'invalid-command'});

/** Pure exact syntax only. No default/latest item, natural-language guess, identity or write. */
export function parseRobotCommand(input){
  if(typeof input!=='string'||input.length>8050)return invalid();
  const text=input.trim();
  if(/[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/u.test(text))return invalid();
  const match=/^(同意|拒绝|完成|退回|接受|拒收)[ \t]+([A-Za-z0-9]{8})(?:[ \t]+(.+))?$/u.exec(text);
  if(!match)return invalid();
  const action=actions[match[1]],code=match[2].toUpperCase(),reason=match[3]?.trim()??null;
  if(!codePattern.test(code))return invalid();
  if(action.negative){
    if(!reason||reason.length>action.maxReason)return invalid();
    // A second complete action is ambiguous, even when someone attempts to hide it in a reason.
    if(/(?:同意|拒绝|完成|退回|接受|拒收)[ \t]+[A-Za-z0-9]{8}(?:$|[^A-Za-z0-9])/u.test(reason))return invalid();
  }else if(reason!==null)return invalid();
  const command={kind:action.kind,outcome:action.outcome,code,reason};
  return {ok:true,command,canonical:JSON.stringify(command)};
}

export function newDecisionCode(){
  return Array.from({length:8},()=>DECISION_CODE_ALPHABET[randomInt(DECISION_CODE_ALPHABET.length)]).join('');
}
