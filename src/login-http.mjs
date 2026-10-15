import http from 'node:http';

const html=message=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>协作服务钉钉登录</title><body><h1>协作服务钉钉登录</h1><p>${message}</p></body></html>`;
const headers={
  'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
  'content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const cookieName=id=>`collaboration_login_${id.replaceAll('-','')}`;
const cookies=value=>{
  const result={};for(const pair of String(value??'').split(';')){const at=pair.indexOf('=');if(at<0)continue;const name=pair.slice(0,at).trim();if(result[name]!==undefined)throw new Error('Duplicate cookie');result[name]=pair.slice(at+1).trim();}return result;
};
/** Only OAuth routes. Must be reverse-proxied from the configured HTTPS origin; no Host GUI or delivery routes. */
export function loginHttpHandler(login){
  const host=new URL(login.origin).host;
  return async(req,res)=>{
    const send=(status,message)=>{res.writeHead(status,{...headers,'content-type':'text/html; charset=utf-8'});res.end(html(message));};
    try{
      if(req.method!=='GET'||req.headers.host!==host||String(req.url).length>8192)return send(400,'登录请求无效，请从原客户端重新发起。');
      const url=new URL(req.url,login.origin);
      const start=url.pathname.match(/^\/collaboration\/login\/([a-f0-9-]{36})$/);
      if(start){
        if(url.search)throw new Error('Unexpected query');
        const id=start[1],browser=login.browserStart(id,cookies(req.headers.cookie)[cookieName(id)]);
        res.writeHead(302,{...headers,location:browser.authorizationUrl,'set-cookie':`${cookieName(id)}=${browser.cookie}; HttpOnly; Secure; SameSite=Lax; Path=/collaboration; Max-Age=300`});res.end();return;
      }
      if(url.pathname==='/collaboration/oauth/callback'){
        for(const key of ['state','code','authCode'])if(url.searchParams.getAll(key).length>1)throw new Error('Duplicate OAuth parameter');
        const state=url.searchParams.get('state'),code=url.searchParams.get('code'),authCode=url.searchParams.get('authCode');
        if(code&&authCode&&code!==authCode)throw new Error('Code mismatch');
        const row=login.db.prepare('SELECT id FROM collaboration_login_requests WHERE state=?').get(state);
        if(!row)throw new Error('Unknown request');
        await login.callback({state,code:code??authCode,cookie:cookies(req.headers.cookie)[cookieName(row.id)]});
        res.writeHead(303,{...headers,location:'/collaboration/login-complete',
          'set-cookie':`${cookieName(row.id)}=; HttpOnly; Secure; SameSite=Lax; Path=/collaboration; Max-Age=0`});res.end();return;
      }
      if(url.pathname==='/collaboration/login-complete'&&!url.search)return send(200,'浏览器授权已处理。请回到原DSH客户端完成领取；浏览器页面不证明客户端已经登录。');
      return send(404,'此入口仅提供协作登录，不提供管理、消息投递或DSH页面。');
    }catch{return send(400,'登录未完成或已失效。请从原客户端重新发起，不要重试旧授权链接。');}
  };
}
export async function listenLoginHttp(login,{port=0,host='127.0.0.1'}={}){
  if(host!=='127.0.0.1'||!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('OAuth backend must bind a loopback port');
  const server=http.createServer(loginHttpHandler(login));server.headersTimeout=10000;server.requestTimeout=10000;server.maxHeadersCount=32;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {address:server.address(),close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
