import {readFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
const gate="        add_header Content-Security-Policy \"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\" always;\n";
const locations=`        # Isolated MVP PC identity probe only. Keep legacy OAuth routes/backend unchanged.
        location = /collaboration/info { proxy_pass http://127.0.0.1:19483; include /etc/dsh-collaboration-login/mvp-probe-proxy.conf; }
        location = /collaboration/pc-login { proxy_pass http://127.0.0.1:19483; include /etc/dsh-collaboration-login/mvp-probe-proxy.conf; }
        location = /collaboration/pc-sdk.js { proxy_pass http://127.0.0.1:19483; include /etc/dsh-collaboration-login/mvp-probe-proxy.conf; }
        location = /collaboration/pc/bind { proxy_pass http://127.0.0.1:19483; include /etc/dsh-collaboration-login/mvp-probe-proxy.conf; }
        location = /collaboration/pc/authorize { proxy_pass http://127.0.0.1:19483; include /etc/dsh-collaboration-login/mvp-probe-proxy.conf; }
        location = /collaboration/pc/confirm { proxy_pass http://127.0.0.1:19483; include /etc/dsh-collaboration-login/mvp-probe-proxy.conf; }
        location = /collaboration/socket {
            proxy_pass http://127.0.0.1:19483;
            include /etc/dsh-collaboration-login/mvp-probe-proxy.conf;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_read_timeout 3600s;
        }

`;
export const probeProxyInclude=`# Probe only. Backend owns per-page CSP/nonce; do not overlay legacy deny-all script policy.
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
# Local add_header stops inherited legacy CSP; do not hide upstream nonce script policy.
add_header X-Collaboration-Probe "pc-identity-only" always;
`;
export function renderProbeIngress(original){
 if(typeof original!=='string'||original.includes('\r')||!original.endsWith('\n')||original.includes('mvp-probe-proxy.conf')||original.includes('/collaboration/socket')||original.split(gate).length!==2||original.split('        location / { return 404; }\n').length!==2)throw Error('Expected unmodified dedicated legacy HTTPS ingress');
 if(!original.includes('proxy_pass http://127.0.0.1:19481;')||!original.includes('listen 192.168.2.20:443 ssl;')||!original.includes('listen 10.242.169.184:443 ssl;'))throw Error('Unexpected legacy listeners/backend');
 // No new listener, individual-source rule, DNS, firewall, TLS path or old OAuth location edit.
 return original.replace('        location / { return 404; }\n',locations+'        location / { return 404; }\n');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--include'&&process.argv.length===3)process.stdout.write(probeProxyInclude);
 else if(process.argv.length===3)process.stdout.write(renderProbeIngress(readFileSync(process.argv[2],'utf8')));
 else throw Error('Usage: node mvp-probe-ingress.mjs <reviewed-dedicated-nginx.conf> | --include');
}
