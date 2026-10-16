import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
export const MVP_NETWORK_BASELINE_SHA256='9cf941f639f328b8b66ffda6579ca2f6b89867f83a57b79c3f13d6bcbcc703a6';
const personalMap=`    map "$server_addr|$remote_addr" $collaboration_login_zt_denied {
        default 0;
        ~^10\\.242\\.169\\.184\\| 1;
        "10.242.169.184|10.242.66.179" 0;
    }

`;
export function renderMvpPrivateNetwork(original){
 if(typeof original!=='string'||createHash('sha256').update(original).digest('hex')!==MVP_NETWORK_BASELINE_SHA256)throw Error('Exact reviewed private HTTPS probe baseline required; no drift overwrite');
 const edits=[['        10.242.66.179/32 1;\n','        10.242.0.0/16 1;\n'],['        allow 10.242.66.179/32;\n','        allow 10.242.0.0/16;\n'],[personalMap,''],['        if ($collaboration_login_zt_denied = 1) { return 403; }\n','']];
 let result=original;for(const [before,after]of edits){if(result.split(before).length!==2)throw Error('Unexpected private-network policy shape');result=result.replace(before,after);}
 if(result.includes('10.242.66.179')||result.includes('collaboration_login_zt_denied'))throw Error('Personal network policy survived');return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3)throw Error('Usage: node mvp-private-network.mjs <reviewed-nginx.conf>');
 process.stdout.write(renderMvpPrivateNetwork(readFileSync(process.argv[2],'utf8')));
}
