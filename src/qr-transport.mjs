import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {PassThrough} from 'node:stream';
import {JsonPeer} from './protocol.mjs';
function websocketPeer(ws){const input=new PassThrough(),output=new PassThrough();output.on('data',chunk=>{if(ws.readyState!==1||ws.bufferedAmount>4*1024*1024){ws.terminate();return;}ws.send(chunk.toString('utf8'),{binary:false});});ws.on('message',(data,binary)=>{if(binary){ws.close(1003);return;}if(input.writableLength>4*1024*1024){ws.terminate();return;}input.write(data);});ws.on('error',()=>input.destroy());ws.on('close',()=>input.destroy());input.on('close',()=>{if(ws.readyState<2)ws.close();});output.on('close',()=>{if(ws.readyState<2)ws.close();});return new JsonPeer(input,output);}
const policy={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin'};
const COOKIE='collaboration_qr_binding';
const cookieOf=req=>{const entries=String(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE+'='));if(entries.length>1)throw Error('Duplicate binding cookie');return entries[0]?.slice(COOKIE.length+1);};
const cookieHeader=value=>`${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/collaboration; Max-Age=300`;
const script=`(()=>{const el=document.getElementById('status');try{const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error();fetch('/collaboration/qr/bind',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-collaboration-qr':'1'},body:JSON.stringify({token})}).then(async response=>{const value=await response.json();if(!response.ok||!value.ok)throw Error();const url=new URL(value.authorizationUrl);if(url.origin!=='https://login.dingtalk.com'||url.pathname!=='/oauth2/auth'||url.username||url.password||url.hash)throw Error();el.textContent='正在打开钉钉官方授权页，请只确认自己从DSH发起的登录…';location.replace(url.href);}).catch(()=>{el.textContent='扫码请求未完成、已被打开或已失效，请回原DSH核对／取消，再明确重新发起；不要重用他人的链接。';});}catch{el.textContent='请从原DSH点击钉钉扫码登录；不接受手输身份或工作台核对码。';}})();`;
const page=nonce=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>钉钉扫码登录</title><body><h1>钉钉扫码登录</h1><p id="status">正在准备本次官方授权…</p><p>只扫描本人在可信DSH中发起的页面；实际授权者将登录到原发起电脑。请勿替他人发送的二维码或链接授权。</p><script nonce="${nonce}">${script}</script></body></html>`;
const completion='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>钉钉授权已处理</title><body><h1>钉钉授权已处理</h1><p>原DSH将自动核对并完成登录，请返回查看实际姓名。此页面不证明DSH已保存登录；无需输入授权码或再次点击确认。</p></body></html>';
const failure='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>扫码登录未完成</title><body><h1>扫码登录未完成</h1><p>本次请求被取消、过期、已使用或身份不符合组织要求。请回原DSH核对后明确重新发起，不重试旧授权码。</p></body></html>';
async function body(req){let size=0;const parts=[];for await(const chunk of req){size+=chunk.length;if(size>8192)throw Error('Request too large');parts.push(chunk);}return JSON.parse(Buffer.concat(parts).toString('utf8'));}

/** Only QR authentication and authenticated WSS. Dedicated private TLS ingress supplies the exact configured Host. */
export async function listenQrHttp(service,login,{port=0,host='127.0.0.1'}={}){
 if(host!=='127.0.0.1')throw Error('QR backend must bind loopback');
 const origin=login.origin,authority=new URL(origin).host,connections=new Set(),rates=new Map();
 const allowed=req=>req.headers.host===authority;
 const rate=req=>{const key=req.socket.remoteAddress,now=Date.now();let row=rates.get(key);if(!row||row.until<now){row={n:0,until:now+60000};rates.set(key,row);}if(++row.n>600)throw Error('Rate bound');};
 const server=http.createServer(async(req,res)=>{
  const json=(status,value,extra={})=>{res.writeHead(status,{...policy,'content-type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(value));};
  const html=(status,value,extra={})=>{res.writeHead(status,{...policy,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",...extra});res.end(value);};
  try{
   if(!allowed(req)||String(req.url).length>16384)return json(403,{ok:false,message:'入口校验失败'});
   const url=new URL(req.url,origin),callback=url.pathname==='/collaboration/oauth/callback';
   if(!callback&&req.headers.origin&&req.headers.origin!==origin)return json(403,{ok:false,message:'入口来源不匹配'});
   if(req.method==='GET'&&callback){
    rate(req);const params=url.searchParams,allowedKeys=['state','code','authCode','error','error_description'];
    if([...params.keys()].some(k=>!allowedKeys.includes(k))||allowedKeys.some(k=>params.getAll(k).length>1)||!params.get('state')||(!params.has('error')&&!params.get('code')&&!params.get('authCode'))||(params.get('code')&&params.get('authCode')&&params.get('code')!==params.get('authCode')))throw Error('Invalid callback');
    if(params.has('error')){login.reject({state:params.get('state'),cookie:cookieOf(req)});res.writeHead(303,{...policy,location:'/collaboration/login-failed'});res.end();return;}
    await login.callback({state:params.get('state'),code:params.get('code')??params.get('authCode'),cookie:cookieOf(req)});
    res.writeHead(303,{...policy,location:'/collaboration/login-complete'});res.end();return;
   }
   if(url.search)return json(400,{ok:false,message:'请求参数无效'});
   if(req.method==='GET'&&url.pathname==='/collaboration/info')return json(200,{serviceId:service.identities.serviceId,origin,mvpHttpsVersion:2,loginMethod:'dingtalk-qr',protocolVersion:4});
   if(req.method==='GET'&&url.pathname==='/collaboration/qr-login'){
    const nonce=randomBytes(18).toString('base64');return html(200,page(nonce),{'content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`});
   }
   if(req.method==='POST'&&url.pathname==='/collaboration/qr/bind'){
    if(req.headers.origin!==origin||req.headers['x-collaboration-qr']!=='1'||req.headers['content-type']?.split(';')[0]!=='application/json')return json(403,{ok:false,message:'请从原浏览器页面继续'});
    rate(req);const value=await body(req);if(!value||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'token'))throw Error('Invalid body');
    const {cookie,...safe}=login.browser(value.token,cookieOf(req));return json(200,{ok:true,...safe},{'set-cookie':cookieHeader(cookie)});
   }
   if(req.method==='GET'&&url.pathname==='/collaboration/login-complete')return html(200,completion);
   if(req.method==='GET'&&url.pathname==='/collaboration/login-failed')return html(400,failure);
   return json(404,{ok:false,message:'此入口不提供PC免登、DSH管理、shell或匿名业务'});
  }catch{if(String(req.url).split('?')[0]==='/collaboration/oauth/callback'){res.writeHead(303,{...policy,location:'/collaboration/login-failed'});res.end();return;}return html(400,failure);}
 });
 server.headersTimeout=10000;server.requestTimeout=15000;server.maxHeadersCount=32;
 const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
 server.on('upgrade',(req,socket,head)=>{if(!allowed(req)||(req.headers.origin&&req.headers.origin!==origin)||req.url!=='/collaboration/socket'||connections.size>=100){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}try{rate(req);wss.handleUpgrade(req,socket,head,ws=>{connections.add(ws);ws.on('close',()=>connections.delete(ws));service.attach(websocketPeer(ws));});}catch{socket.destroy();}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 return {address:server.address(),async close(){for(const ws of connections)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}};
}
