import http from 'node:http';
import {PassThrough} from 'node:stream';
import {WebSocketServer} from 'ws';
import {randomBytes} from 'node:crypto';
import {JsonPeer} from './protocol.mjs';
import {readFileSync} from 'node:fs';
const pcSdk=readFileSync(new URL('../assets/dingtalk-pc.js',import.meta.url));

const policy={ 'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff', };
const COOKIE='collaboration_pc_binding';
const cookieOf=req=>{
  const values=String(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));
  if(values.length>1)throw new Error('Duplicate binding cookie');return values[0]?.slice(COOKIE.length+1);
};
const cookieHeader=value=>`${COOKIE}=${value}; HttpOnly; Secure; SameSite=None; Path=/collaboration; Max-Age=300`;
const escape=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
const script=`(()=>{
 const el=id=>document.getElementById(id);let binding=null,busy=false,identified=false,done=false;
 const call=async(path,body)=>{const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-collaboration-pc':'1'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok||!v.ok)throw new Error(v.message||'登录未完成');return v.value;};
 const show=message=>el('status').textContent=message;
 setTimeout(()=>{if(done)return;busy=true;binding=null;el('confirm').disabled=true;el('bind').disabled=true;show('本次页面已超时，请回原DSH退出待登录状态后发起新登录。');},300000);
 const bind=async()=>{if(busy||done)return;busy=true;try{const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);binding=await call('/collaboration/pc/bind',token?{token}:{pairingCode:el('pair').value.trim().toUpperCase()});el('details').textContent='服务：'+binding.serviceId+' · 组织：'+binding.corpId+' · 本机核对码：'+binding.pairingCode;el('confirm').hidden=false;show('请核对这与原DSH显示的服务和核对码一致，只确认自己发起的登录。');}catch(e){show(e.message);}finally{busy=false;}};
 el('bind').onclick=bind;
 el('confirm').onclick=async()=>{if(busy||done||!binding)return;
 if(identified){busy=true;el('confirm').disabled=true;try{const v=await call('/collaboration/pc/confirm',{requestId:binding.requestId});done=true;show('已确认身份：'+v.name+'。原DSH将自动完成登录，可关闭此页。');}catch(e){show(e.message);}finally{busy=false;}return;}
 if(!window.dd||!['pc','mac'].includes(String(window.dd.env?.platform).toLowerCase())){show('请在电脑钉钉内打开本应用；不使用手机扫码。');return;}busy=true;el('confirm').disabled=true;show('正在通过电脑钉钉核验当前身份…');
 try{const task=window.dd.requestAuthCode({corpId:binding.corpId,clientId:binding.clientId,onSuccess:async result=>{try{const v=await call('/collaboration/pc/authorize',{requestId:binding.requestId,code:result.code});identified=true;el('confirm').disabled=false;el('confirm').textContent='确认以此身份登录原DSH';show('当前身份：'+v.name+' · 组织：'+v.corpId+' · 服务：'+v.serviceId+'。请核对本人身份，再确认登录。');}catch(e){show(e.message+'；请回原DSH核对，不重复使用旧授权码。');}finally{busy=false;}},onFail:()=>{busy=false;show('电脑钉钉免登失败，请核对应用PC首页／发布范围和客户端版本，再回原DSH发起新登录。');}});task?.catch(()=>{});}catch{busy=false;show('电脑钉钉免登组件不可用，请核对客户端版本与应用发布状态。');}
 };
 if(location.hash)bind();else show('请在原DSH发起登录，从电脑钉钉打开对应链接；工作台入口可输入原DSH的16位核对码。不要使用他人发来的核对码。');
})();`;

function page(nonce){return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>电脑钉钉登录</title><body><h1>电脑钉钉登录</h1><p id="status">正在读取请求…</p><p id="details"></p><label>原DSH核对码 <input id="pair" maxlength="16" autocomplete="off"></label><button id="bind" type="button">核对本次登录</button><button id="confirm" hidden type="button">确认登录到原DSH</button><p>仅在电脑钉钉内确认本人发起的登录；无需输入钉钉密码，不使用手机扫码。</p><script nonce="${escape(nonce)}" src="/collaboration/pc-sdk.js"></script><script nonce="${escape(nonce)}">${script}</script></body></html>`;}
async function body(req){
 let size=0;const parts=[];for await(const chunk of req){size+=chunk.length;if(size>8192)throw new Error('Body bound');parts.push(chunk);}return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export function websocketPeer(ws){
 const input=new PassThrough(),output=new PassThrough();
 output.on('data',chunk=>{if(ws.readyState!==1||ws.bufferedAmount>4*1024*1024){ws.terminate();return;}ws.send(chunk.toString('utf8'),{binary:false});});
 ws.on('message',(data,binary)=>{if(binary){ws.close(1003);return;}if(input.writableLength>4*1024*1024){ws.terminate();return;}input.write(data);});
 ws.on('error',()=>input.destroy());ws.on('close',()=>input.destroy());input.on('close',()=>{if(ws.readyState<2)ws.close();});output.on('close',()=>{if(ws.readyState<2)ws.close();});
 return new JsonPeer(input,output);
}

/** This HTTP listener MUST remain loopback behind the dedicated TLS reverse proxy. */
export async function listenMvpHttp(service,login,{port,host='127.0.0.1'}={}){
 if(host!=='127.0.0.1')throw new Error('MVP backend must bind loopback');
 const origin=login.origin,authority=new URL(origin).host,connections=new Set(),rates=new Map();
 const allowed=req=>req.headers.host===authority&&(!req.headers.origin||req.headers.origin===origin);
 const rate=req=>{const source=req.socket.remoteAddress;const now=Date.now();let r=rates.get(source);if(!r||r.until<now){r={n:0,until:now+60000};rates.set(source,r);}if(++r.n>600)throw new Error('Rate limit');};
 const server=http.createServer(async(req,res)=>{
   const json=(status,value,extra={})=>{res.writeHead(status,{...policy,'content-type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(value));};
   try{
     if(!allowed(req)||String(req.url).length>1024)return json(403,{ok:false,message:'入口校验失败'});
     const url=new URL(req.url,origin);
     if(url.search)return json(400,{ok:false,message:'请求参数无效'});
     if(req.method==='GET'&&url.pathname==='/collaboration/info')return json(200,{serviceId:service.identities.serviceId,origin,mvpHttpsVersion:1,loginMethod:'dingtalk-pc',protocolVersion:3});
     if(req.method==='GET'&&url.pathname==='/collaboration/pc-sdk.js'){res.writeHead(200,{...policy,'content-type':'application/javascript; charset=utf-8'});res.end(pcSdk);return;}
     if(req.method==='GET'&&url.pathname==='/collaboration/pc-login'){
       const nonce=randomBytes(18).toString('base64');res.writeHead(200,{...policy,'content-type':'text/html; charset=utf-8','content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors https://*.dingtalk.com https://*.7ding.ai; base-uri 'none'; form-action 'none'`});res.end(page(nonce));return;
     }
     if(req.method==='POST'&&['/collaboration/pc/bind','/collaboration/pc/authorize','/collaboration/pc/confirm'].includes(url.pathname)){
       if(req.headers.origin!==origin||req.headers['x-collaboration-pc']!=='1'||req.headers['content-type']?.split(';')[0]!=='application/json')return json(403,{ok:false,message:'请从电脑钉钉应用页操作'});
       rate(req);const value=await body(req),keys=Object.keys(value??{});
       if(url.pathname.endsWith('/bind')){
         if(keys.length!==1||!['token','pairingCode'].includes(keys[0]))throw new Error('Bad binding body');
         const result=value.token?login.browser(value.token,cookieOf(req)):login.pair(value.pairingCode,cookieOf(req));
         const {cookie,...safe}=result;return json(200,{ok:true,value:safe},{'set-cookie':cookieHeader(cookie)});
       }
       if(url.pathname.endsWith('/confirm')){if(keys.length!==1||keys[0]!=='requestId')throw new Error('Bad confirmation body');return json(200,{ok:true,value:login.confirm({...value,cookie:cookieOf(req)})});}
       if(keys.length!==2||!keys.includes('requestId')||!keys.includes('code'))throw new Error('Bad authorization body');
       return json(200,{ok:true,value:await login.authorize({...value,cookie:cookieOf(req)})});
     }
     return json(404,{ok:false,message:'此入口仅提供协作MVP，不提供DSH管理或shell'});
   }catch{return json(400,{ok:false,message:'登录请求未完成或已过期，请在原DSH核对后明确发起新登录'});}
 });
 server.headersTimeout=10000;server.requestTimeout=15000;server.maxHeadersCount=32;
 const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
 server.on('upgrade',(req,socket,head)=>{
   if(!allowed(req)||req.url!=='/collaboration/socket'||connections.size>=100){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
   try{rate(req);wss.handleUpgrade(req,socket,head,ws=>{connections.add(ws);ws.on('close',()=>connections.delete(ws));service.attach(websocketPeer(ws));});}catch{socket.destroy();}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port??0,host,resolve);});
 return {address:server.address(),async close(){for(const ws of connections)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}};
}
