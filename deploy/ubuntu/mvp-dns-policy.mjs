export const MVP_DNS_NAME='login.lafinger.us.ci';export const MVP_DNS_TARGET='10.242.169.184';
/** One administrator-owned DNS change, never per-member hosts, wildcard, proxy or unrelated records. */
export function mvpDnsUpdate(record){
 if(!record||record.type!=='A'||record.name!==MVP_DNS_NAME||record.proxied!==false||!Number.isSafeInteger(record.ttl)||record.ttl<1||![ '192.168.2.20',MVP_DNS_TARGET].includes(record.content))throw Error('Exact private DNS-only A-record baseline required');
 return {type:'A',name:MVP_DNS_NAME,content:MVP_DNS_TARGET,ttl:record.ttl,proxied:false};
}
