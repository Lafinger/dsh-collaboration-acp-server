import {createHash} from 'node:crypto';
export const QR_PC_INGRESS_BASELINE='734537190614dcf727259e816f16372e62a5e1a164b35a843ad97b92364eb8fb';
const tail='        location / { return 404; }\n';
const paths=['/collaboration/qr-login','/collaboration/qr/bind','/collaboration/oauth/callback','/collaboration/login-complete','/collaboration/login-failed'];
export const qrProxyInclude=`# QR HTTPS. Backend owns nonce/CSP; only existing private ingress listeners are admitted.
proxy_http_version 1.1;
proxy_set_header Host login.lafinger.us.ci;
proxy_set_header Origin $http_origin;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-For "";
proxy_set_header Forwarded "";
proxy_connect_timeout 3s;
proxy_send_timeout 12s;
proxy_next_upstream off;
proxy_intercept_errors off;
proxy_buffering off;
proxy_request_buffering on;
client_max_body_size 8k;
# Authorization codes/query/cookies/body MUST NOT be retained by either proxy log.
access_log off;
error_log /dev/null crit;
add_header X-Collaboration-Transport "mvp-web-qr" always;
`;
const exact=(path,port,upstreamPath='')=>`        location = ${path} { proxy_pass http://127.0.0.1:${port}${upstreamPath}; include /etc/dsh-collaboration-login/qr-proxy.conf; }\n`;
function baseline(original,expected){if(typeof original!=='string'||original.includes('\r')||!original.endsWith('\n')||createHash('sha256').update(original).digest('hex')!==expected||original.split(tail).length!==2)throw Error('Exact reviewed private ingress required; do not overwrite drift');for(const v of ['listen 192.168.2.20:443 ssl;','listen 10.242.169.184:443 ssl;','access_log off;','error_log /dev/null crit;'])if(!original.includes(v))throw Error('Required private listener/log boundary changed');}
/** Add only new authentication probe routes; original PC info/socket/business remain on 19481. Never adds a listener/domain. */
export function renderQrProbeIngress(original){baseline(original,QR_PC_INGRESS_BASELINE);if(paths.some(path=>original.includes('location = '+path)))throw Error('QR paths already present');
 const locations='        # Temporary QR authentication only; preserve current PC business and device logins.\n'+paths.map(path=>exact(path,19483)).join('')+exact('/collaboration/qr-probe/info',19483,'/collaboration/info')+`        location = /collaboration/qr-probe/socket {
            proxy_pass http://127.0.0.1:19483/collaboration/socket;
            include /etc/dsh-collaboration-login/qr-proxy.conf;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_read_timeout 3600s;
        }

`;
 return original.replace(tail,locations+tail);
}
/** Formal migration is a distinct exact-hash operation; remove PC locations, send normal info/socket to same original backend port. */
export function renderQrProductionIngress(original,expected){
 if(!/^[a-f0-9]{64}$/.test(expected??''))throw Error('Explicit reviewed source hash required');baseline(original,expected);
 const current=original.includes('Temporary QR authentication only')?renderQrProbeIngressFromBaselineShape(original):original;
 let next=current;
 for(const path of ['/collaboration/pc-login','/collaboration/pc-sdk.js','/collaboration/pc/bind','/collaboration/pc/authorize','/collaboration/pc/confirm']){
  const line=exact(path,19481).replace('/qr-proxy.conf','/mvp-https-proxy.conf');if(next.split(line).length!==2)throw Error('Unexpected PC route shape');next=next.replace(line,'');
 }
 if(paths.some(path=>next.includes('location = '+path)))throw Error('Unexpected QR routes before formal render');
 next=next.replaceAll('/etc/dsh-collaboration-login/mvp-https-proxy.conf','/etc/dsh-collaboration-login/qr-proxy.conf').replace(tail,paths.map(path=>exact(path,19481)).join('')+tail);
 if(/pc-login|pc-sdk|pc\/|qr-probe|19483/.test(next))throw Error('PC/probe route not fully retired');return next;
}
function renderQrProbeIngressFromBaselineShape(original){
 const start=original.indexOf('        # Temporary QR authentication only;'),end=original.indexOf(tail,start);if(start<0||end<start)throw Error('Unknown QR probe shape');
 const restored=original.slice(0,start)+original.slice(end);baseline(restored,QR_PC_INGRESS_BASELINE);if(renderQrProbeIngress(restored)!==original)throw Error('QR probe changed; refuse drift');return restored;
}
