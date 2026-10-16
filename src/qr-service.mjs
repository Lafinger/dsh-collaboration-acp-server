import {MvpAccessService} from './mvp-service.mjs';
import {AccessError} from './protocol.mjs';
const exact=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===3&&['requestId','deviceId','proof'].every(k=>typeof value[k]==='string');

/** Exactly one configured production login method; old PC clients fail before starting authentication. */
export class QrAccessService extends MvpAccessService {
 constructor({authenticationOnly=false,...options}){super(options);this.authenticationOnly=authenticationOnly===true;}
 async handle(c,method,p){
  if(c.closed||this.closing)throw new AccessError(-32001,'连接已关闭');
  if(method==='initialize'){
   if(p?.clientCapabilities?.webQrLogin!==1)throw new AccessError(-32011,'请安装配套网页扫码客户端并完整重启DSH；不回退电脑钉钉免登');
   const result=await super.handle(c,method,p);return {...result,authMethods:[{id:'dingtalk-device',name:'钉钉网页扫码登录'}],agentCapabilities:{...result.agentCapabilities,mvpHttpsVersion:2,loginMethod:'dingtalk-qr'}};
  }
  if(!c.initialized)throw new AccessError(-32600,'请先初始化连接');
  if(typeof method!=='string'||!p||typeof p!=='object'||Array.isArray(p))throw new AccessError(-32602,'请求格式不正确');
  if(method==='collaboration/login/resume'){
   if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==2||typeof p.deviceId!=='string'||typeof p.proof!=='string')throw new AccessError(-32602,'恢复请求参数无效');return this.login.resume(null,p);
  }
  if(['collaboration/login/cancel','collaboration/login/request-status','collaboration/login/ack'].includes(method)){
   if(!exact(p))throw new AccessError(-32602,'扫码请求参数无效');
   if(method.endsWith('/cancel'))return this.login.cancel(null,p);
   if(method.endsWith('/ack'))return this.login.acknowledge(null,p);
   return this.login.status(null,p);
  }
  if(this.authenticationOnly&&!method.startsWith('collaboration/login/')&&method!=='collaboration/whoami')throw new AccessError(-32601,'临时实例仅验证官方认证，不提供项目／管理／业务／模型入口');
  return super.handle(c,method,p);
 }
}
