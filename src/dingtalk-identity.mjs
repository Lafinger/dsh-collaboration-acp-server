import { AccessError, requireText } from './protocol.mjs';

const unavailable = () => new AccessError(-32003,'DingTalk identity verification unavailable');
const revoked=()=>Object.assign(unavailable(),{qualificationRevoked:true});
/** Fixed official endpoints. Secrets and provider payloads never appear in public errors. */
export class DingTalkIdentityProvider {
  constructor({corpId,clientId,clientSecret,fetchImpl=fetch,now=Date.now}) {
    this.corpId=requireText(corpId,'corpId',200); this.clientId=requireText(clientId,'clientId',200);
    this.clientSecret=requireText(clientSecret,'clientSecret',4096); this.fetch=fetchImpl; this.now=now; this.cached=null; this.pending=null;
  }
  async json(url,{body,headers={}}={}) {
    try {
      const response=await this.fetch(url,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000),redirect:'error'});
      if (!response.ok) throw unavailable();
      let size=0;const parts=[];
      for await(const chunk of response.body){size+=chunk.length;if(size>128*1024)throw unavailable();parts.push(chunk);}
      const value=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(value?.errcode===33012)throw revoked();
      if (!value || Array.isArray(value) || typeof value!=='object' || (value.errcode!==undefined && String(value.errcode)!=='0')) throw unavailable();
      return value;
    } catch(error) { if(error?.qualificationRevoked===true)throw revoked();throw unavailable(); }
  }
  async applicationToken() {
    if(this.cached?.until>this.now())return this.cached.token;
    this.pending??=(async()=>{
      const value=await this.json('https://api.dingtalk.com/v1.0/oauth2/accessToken',{body:{appKey:this.clientId,appSecret:this.clientSecret}});
      const token=requireText(value.accessToken,'application token',4096);
      if(!Number.isSafeInteger(value.expireIn)||value.expireIn<=60)throw unavailable();
      this.cached={token,until:this.now()+Math.min(value.expireIn-60,3600)*1000};return token;
    })().finally(()=>{this.pending=null;});
    return this.pending;
  }
  async resolveUnion(unionId,{displayName=false}={}) {
    requireText(unionId,'unionId',200); const token=await this.applicationToken();
    const value=await this.json(`https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(token)}`,{body:{unionid:unionId}});
    if(String(value.result?.contact_type)==='1')throw revoked();
    if(String(value.result?.contact_type)!=='0')throw unavailable();
    const userId=requireText(value.result?.userid,'organization userId',200);
    const detail=await this.json(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(token)}`,{body:{userid:userId}});
    if([false,'false'].includes(detail.result?.active)||detail.result?.userid!==userId||detail.result?.unionid!==unionId)throw revoked();
    if(![true,'true'].includes(detail.result?.active))throw unavailable();
    const name=typeof detail.result?.name==='string'&&detail.result.name.trim()&&detail.result.name.length<=200?detail.result.name.trim():userId;
    return {corpId:this.corpId,userId,unionId,internal:true,...displayName?{name}:{}};
  }
  async exchange(code,{displayName=false}={}) {
    requireText(code,'authorization code',4096);
    const token=await this.json('https://api.dingtalk.com/v1.0/oauth2/userAccessToken',{
      body:{clientId:this.clientId,clientSecret:this.clientSecret,code,grantType:'authorization_code'}});
    if(token.corpId!==this.corpId)throw unavailable();
    const accessToken=requireText(token.accessToken,'user token',4096);
    const me=await this.json('https://api.dingtalk.com/v1.0/contact/users/me',{headers:{'x-acs-dingtalk-access-token':accessToken}});
    // Neither refresh token nor personal contact fields are retained.
    return this.resolveUnion(requireText(me.unionId,'unionId',200),{displayName});
  }
  async exchangePc(code) {
    requireText(code,'PC免登授权码',4096);
    const token=await this.applicationToken();
    const result=await this.json(`https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(token)}`,{body:{code}});
    const userId=requireText(result.result?.userid,'组织员工身份',200),unionId=requireText(result.result?.unionid,'组织用户身份',200);
    const identity=await this.resolveUnion(unionId,{displayName:true});
    if(identity.userId!==userId)throw unavailable();
    return identity;
  }
  async verifyMember(member) {
    if(member.corp_id!==this.corpId||member.client_id!==this.clientId)throw unavailable();
    const identity=await this.resolveUnion(member.union_id);
    if(identity.userId!==member.user_id)throw revoked();
    return identity;
  }
}
