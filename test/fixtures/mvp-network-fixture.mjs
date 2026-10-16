import {readFileSync} from 'node:fs';import {renderProbeIngress} from '../../deploy/ubuntu/mvp-probe-ingress.mjs';
/** Reconstruct the exact public Linux deployment baseline; normalize ONLY this synthetic Git fixture on Windows. */
export function reviewedProbeIngress(){
 let s=readFileSync(new URL('../../deploy/ubuntu/login-lan.baseline.conf',import.meta.url),'utf8').replaceAll('\r\n','\n');
 s=s.replace('# Bind ONLY the verified LAN address, not 0.0.0.0 or IPv6.','# Preserve LAN; ZeroTier listener permits only the verified B source, no wildcard/IPv6.');
 s=s.replace('        127.0.0.1/32 1;\n','        127.0.0.1/32 1;\n        10.242.66.179/32 1;\n');
 s=s.replace('        listen 192.168.2.20:443 ssl default_server;\n','        listen 192.168.2.20:443 ssl default_server;\n        listen 10.242.169.184:443 ssl default_server;\n').replace('        listen 192.168.2.20:443 ssl;\n','        listen 192.168.2.20:443 ssl;\n        listen 10.242.169.184:443 ssl;\n').replace('        allow 127.0.0.1;\n','        allow 127.0.0.1;\n        allow 10.242.66.179/32;\n');
 s=s.replace('    # Missing/unknown SNI must never reach the OAuth application.\n','    map "$server_addr|$remote_addr" $collaboration_login_zt_denied {\n        default 0;\n        ~^10\\.242\\.169\\.184\\| 1;\n        "10.242.169.184|10.242.66.179" 0;\n    }\n\n    # Missing/unknown SNI must never reach the OAuth application.\n');
 s=s.replace('        if ($collaboration_login_lan = 0) { return 403; }\n','        if ($collaboration_login_lan = 0) { return 403; }\n        if ($collaboration_login_zt_denied = 1) { return 403; }\n');return renderProbeIngress(s);
}
