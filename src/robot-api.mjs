// Fixed official endpoints only. This class never accepts the identity/login application's config.
export const ROBOT_TEXT_BUDGET_BYTES=1800;
export const ROBOT_CALLBACK_TOPIC='/v1.0/im/bot/messages/get';
const endpoints=Object.freeze({token:'https://api.dingtalk.com/v1.0/oauth2/accessToken',gateway:'https://api.dingtalk.com/v1.0/gateway/connections/open',send:'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'});
export class RobotPlatformError extends Error{
  constructor(kind,retryable=false){super('Robot platform unavailable');this.name='RobotPlatformError';this.kind=kind;this.retryable=retryable;}
}
const string=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value;
const rejected=(errorKind,status='failed')=>({status,errorKind});

export class RobotApplicationApi{
  #binding;#fetch;#now;#timeout;#lifetime=new AbortController();#token=null;#expires=0;#pending=null;
  constructor({binding,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=10000}){
    if(!binding||!string(binding.clientId,200)||!string(binding.clientSecret,4096)||!string(binding.robotCode,200)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>12000)throw new RobotPlatformError('invalid-robot-configuration');
    this.#binding=Object.freeze({clientId:binding.clientId,clientSecret:binding.clientSecret,robotCode:binding.robotCode});this.#fetch=fetchImpl;this.#now=now;this.#timeout=timeoutMs;
  }
  stop(){this.#lifetime.abort();this.#token=null;this.#expires=0;}
  async #post(url,body,headers={}){
    try{
      const response=await this.#fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.any([this.#lifetime.signal,AbortSignal.timeout(this.#timeout)]),headers:{accept:'application/json','content-type':'application/json',...headers},body:JSON.stringify(body)});
      if(!response.body)throw new Error();let size=0;const chunks=[];
      for await(const chunk of response.body){size+=chunk.length;if(size>131072)throw new Error();chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return {ok:response.ok,status:response.status,value};
    }catch{throw new RobotPlatformError('platform-transport-unavailable',true);}
  }
  async #applicationToken(){
    if(this.#token&&this.#expires>this.#now())return this.#token;
    if(this.#pending)return this.#pending;
    const pending=(async()=>{
      const response=await this.#post(endpoints.token,{appKey:this.#binding.clientId,appSecret:this.#binding.clientSecret});
      if(!response.ok)throw new RobotPlatformError('robot-token-rejected',![400,401,403].includes(response.status));
      const {accessToken,expireIn}=response.value;
      if(!string(accessToken,16384)||!Number.isSafeInteger(expireIn)||expireIn<=60)throw new RobotPlatformError('invalid-token-reply',true);
      if(this.#lifetime.signal.aborted)throw new RobotPlatformError('robot-stopped',true);
      this.#token=accessToken;this.#expires=this.#now()+(Math.min(expireIn,7200)-60)*1000;return accessToken;
    })();
    this.#pending=pending;try{return await pending;}finally{if(this.#pending===pending)this.#pending=null;}
  }
  /** One recipient, one API request. Caller must persist 'sending' first. Never retries here. */
  async sendPrivateText(userId,content,{beforeSend=null}={}){
    if(!string(userId,200)||/[\r\n\u0000]/u.test(userId))return rejected('invalid-recipient');
    if(typeof content!=='string'||!content.trim()||Buffer.byteLength(content,'utf8')>ROBOT_TEXT_BUDGET_BYTES||content.includes('\0'))return rejected('application-text-budget');
    let token;try{token=await this.#applicationToken();}catch(error){return rejected(error instanceof RobotPlatformError?error.kind:'token-unavailable',error instanceof RobotPlatformError&&error.retryable?'retry-unsent':'failed');}
    if(beforeSend!==null){try{const current=beforeSend();if(current&&typeof current.then==='function')void Promise.resolve(current).catch(()=>{});if(current!==true)return rejected('pre-send-guard-unavailable','retry-unsent');}catch{return rejected('pre-send-guard-unavailable','retry-unsent');}}
    let response;
    try{response=await this.#post(endpoints.send,{robotCode:this.#binding.robotCode,userIds:[userId],msgKey:'sampleText',msgParam:JSON.stringify({content})},{'x-acs-dingtalk-access-token':token});}
    catch{return rejected('unknown-send-outcome','unknown');}
    const {ok,status,value}=response;
    if(!ok){
      if(status===400&&['send.too.fast','send.byToken.tooFast'].includes(value.code))return rejected('explicit-rate-limit','retry-unsent');
      if([400,401,403,404].includes(status))return rejected('explicit-platform-rejection');
      return rejected('unknown-platform-outcome','unknown');
    }
    for(const field of ['invalidStaffIdList','filteredStaffIdList','flowControlledStaffIdList']){
      if(value[field]===undefined)continue;
      if(!Array.isArray(value[field])||value[field].some(id=>typeof id!=='string'||id!==userId))return rejected('unexpected-recipient-reply','unknown');
    }
    if(value.invalidStaffIdList?.includes(userId)||value.filteredStaffIdList?.includes(userId))return rejected('explicit-recipient-rejection');
    if(value.flowControlledStaffIdList?.includes(userId))return rejected('explicit-recipient-rate-limit','retry-unsent');
    return string(value.processQueryKey,2048)?{status:'accepted',acceptedKey:value.processQueryKey}:rejected('missing-acceptance-evidence','unknown');
  }
  /** Returned URL contains a one-use ticket: use in memory only, never log or persist it. */
  async openConnection(){
    const response=await this.#post(endpoints.gateway,{clientId:this.#binding.clientId,clientSecret:this.#binding.clientSecret,subscriptions:[{type:'CALLBACK',topic:ROBOT_CALLBACK_TOPIC}],ua:'dsh-collaboration-text-decisions/1'});
    if(!response.ok)throw new RobotPlatformError('stream-open-rejected',![400,401,403,404].includes(response.status));
    if(!string(response.value.ticket,8192))throw new RobotPlatformError('invalid-stream-reply',true);
    let endpoint;try{endpoint=new URL(response.value.endpoint);}catch{throw new RobotPlatformError('invalid-stream-endpoint');}
    if(endpoint.protocol!=='wss:'||endpoint.hostname!=='wss-open-connection.dingtalk.com'||endpoint.port&&endpoint.port!=='443'||endpoint.pathname!=='/connect'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new RobotPlatformError('invalid-stream-endpoint');
    endpoint.searchParams.set('ticket',response.value.ticket);return endpoint;
  }
}
