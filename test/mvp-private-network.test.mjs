import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {renderProbeIngress} from '../deploy/ubuntu/mvp-probe-ingress.mjs';import {renderMvpPrivateNetwork,MVP_NETWORK_BASELINE_SHA256} from '../deploy/ubuntu/mvp-private-network.mjs';import {mvpDnsUpdate,MVP_DNS_TARGET} from '../deploy/ubuntu/mvp-dns-policy.mjs';
function currentIngress(){
 let s=readFileSync(new URL('../deploy/ubuntu/login-lan.baseline.conf',import.meta.url),'utf8').replaceAll('\r\n','\n');
 s=s.replace('# Bind ONLY the verified LAN address, not 0.0.0.0 or IPv6.','# Preserve LAN; ZeroTier listener permits only the verified B source, no wildcard/IPv6.');
 s=s.replace('        127.0.0.1/32 1;\n','        127.0.0.1/32 1;\n        10.242.66.179/32 1;\n');
 s=s.replace('        listen 192.168.2.20:443 ssl default_server;\n','        listen 192.168.2.20:443 ssl default_server;\n        listen 10.242.169.184:443 ssl default_server;\n').replace('        listen 192.168.2.20:443 ssl;\n','        listen 192.168.2.20:443 ssl;\n        listen 10.242.169.184:443 ssl;\n').replace('        allow 127.0.0.1;\n','        allow 127.0.0.1;\n        allow 10.242.66.179/32;\n');
 s=s.replace('    # Missing/unknown SNI must never reach the OAuth application.\n','    map "$server_addr|$remote_addr" $collaboration_login_zt_denied {\n        default 0;\n        ~^10\\.242\\.169\\.184\\| 1;\n        "10.242.169.184|10.242.66.179" 0;\n    }\n\n    # Missing/unknown SNI must never reach the OAuth application.\n');
 s=s.replace('        if ($collaboration_login_lan = 0) { return 403; }\n','        if ($collaboration_login_lan = 0) { return 403; }\n        if ($collaboration_login_zt_denied = 1) { return 403; }\n');return renderProbeIngress(s);
}
test('single shared HTTPS private-subnet boundary removes personal IP only, preserves listener/TLS/backend paths, rejects config drift',()=>{
 const original=currentIngress();assert.equal(createHash('sha256').update(original).digest('hex'),MVP_NETWORK_BASELINE_SHA256);const next=renderMvpPrivateNetwork(original);
 assert.ok(next.includes('        10.242.0.0/16 1;'));assert.ok(next.includes('        allow 10.242.0.0/16;'));assert.ok(!next.includes('10.242.66.179'));assert.ok(!next.includes('collaboration_login_zt_denied'));
 const important=s=>s.split('\n').filter(l=>/listen |ssl_|proxy_pass|location |proxy_set_header|deny all|allow 192\.168|client_max_body_size/.test(l));assert.deepEqual(important(next),important(original));assert.ok(!/listen (?:0\.0\.0\.0|\[::\])/.test(next));
 for(const bad of [original+'\n',original.replace('19483','19484'),original.replaceAll('\n','\r\n'),next])assert.throws(()=>renderMvpPrivateNetwork(bad));
});
test('DNS policy changes only exact private A-record to shared existing ZeroTier address, never public proxy or per-user hosts',()=>{
 const old={type:'A',name:'login.lafinger.us.ci',content:'192.168.2.20',ttl:1,proxied:false},next=mvpDnsUpdate(old);assert.deepEqual(next,{...old,content:MVP_DNS_TARGET});assert.deepEqual(mvpDnsUpdate(next),next);
 for(const bad of [{...old,name:'other.lafinger.us.ci'},{...old,content:'8.8.8.8'},{...old,proxied:true},{...old,type:'AAAA'},{...old,ttl:undefined}])assert.throws(()=>mvpDnsUpdate(bad));
});
