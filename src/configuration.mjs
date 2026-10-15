import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve, relative } from 'node:path';
import { AccountAuthority } from './authority.mjs';
export const defaultConfigPath = () => join(homedir(), '.dsh', 'collaboration-acp-server.json');
const required = ['serviceId', 'workspace', 'stateRoot', 'socketPath', 'provider', 'model', 'accounts', 'dingtalk'];
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const nested = (a, b) => { const r = relative(resolve(a), resolve(b)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
function resolveMvp(config,configPath,pending){
  const keys=['mode','serviceId','workspace','stateRoot','provider','model','dingtalk'];
  if(Object.keys(config).some(k=>!keys.includes(k))||['serviceId','provider','model'].some(k=>!text(config[k])))return pending('MVP配置仅支持统一HTTPS、宿主模型和钉钉组织字段');
  if(![config.workspace,config.stateRoot].every(v=>typeof v==='string'&&isAbsolute(v))||nested(config.workspace,config.stateRoot)||nested(config.stateRoot,config.workspace))return pending('MVP工作区与私有状态须为分离绝对目录');
  const d=config.dingtalk,allowed=['corpId','clientId','clientSecret','publicOrigin','loginPort','administratorUserId','agentId'];
  if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!allowed.includes(k))||['corpId','clientId','administratorUserId'].some(k=>!text(d[k]))||typeof d.clientSecret!=='string'||!d.clientSecret.trim()||d.clientSecret.length>4096||typeof d.agentId!=='string'||!/^\d{1,30}$/.test(d.agentId))return pending('MVP需组织／应用秘密／AgentId和指定管理员身份，不使用个人SSH账号');
  try{const u=new URL(d.publicOrigin);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error();}catch{return pending('MVP服务地址须为明确可信HTTPS origin');}
  if(!Number.isSafeInteger(d.loginPort)||d.loginPort<1||d.loginPort>65535)return pending('MVP需本机后端端口');
  return {state:'configured',configPath,config:{...config,dingtalk:{...d,organizationTtlMs:300000,loginTtlMs:604800000}},message:'MVP配置完整；只监听本机后端，需统一HTTPS代理和真实电脑钉钉验收。'};
}
/** File-only configuration: credentials stay outside profile YAML and status output. */
export function resolveServerConfiguration(input = {}, { fallbackPath = defaultConfigPath() } = {}) {
  const configPath = input.configFile ?? fallbackPath;
  const pending = issue => ({ state: 'configuration-required', configPath, issue, message: `协作服务端待配置：${issue}；未监听、未建库。` });
  if (typeof configPath !== 'string' || !configPath.trim() || !isAbsolute(configPath)) return pending('配置文件须为绝对路径');
  if (Object.keys(input).some(k => k !== 'configFile')) return pending('只接受configFile，不在插件配置中保存凭据或内联部署参数');
  if (!existsSync(configPath)) return pending('私有JSON配置文件尚不存在');
  let config;
  try {
    const stat = lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return pending('配置须为小于64KiB的普通文件');
    if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) return pending('配置须由服务账号拥有且无组/其他用户权限');
    config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return pending('配置无法读取或JSON格式不正确'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return pending('配置须为JSON对象');
  if(config.mode==='mvp-https')return resolveMvp(config,configPath,pending);
  if (Object.keys(config).some(k => !required.includes(k))) return pending('配置含不支持字段，旧fixture/adapterModule部署配置不可直接使用');
  if (['serviceId', 'provider', 'model'].some(k => !text(config[k])) || ['workspace', 'stateRoot', 'socketPath'].some(k => typeof config[k] !== 'string' || !config[k].trim())) return pending('缺少serviceId/workspace/stateRoot/socketPath/provider/model');
  if (![config.workspace, config.stateRoot].every(isAbsolute)) return pending('workspace/stateRoot须为绝对路径');
  if (nested(config.workspace, config.stateRoot) || nested(config.stateRoot, config.workspace)) return pending('工作区与私有状态目录须分离，不能相互包含');
  if (process.platform === 'win32' ? !/^\\\\\.\\pipe\\[A-Za-z0-9_.-]+$/.test(config.socketPath) : !isAbsolute(config.socketPath)) return pending('须使用本地Unix socket或Windows测试命名管道');
  if (!config.accounts || typeof config.accounts !== 'object' || Array.isArray(config.accounts)
    || Object.keys(config.accounts).some(k => !/^[A-Za-z0-9_.-]+$/.test(k))) return pending('accounts须为合法登录账号与独立凭据的映射');
  try { new AccountAuthority(config); } catch { return pending('accounts须包含至少一个账号和各自不同的64+字符凭据'); }
  const d=config.dingtalk;
  if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['corpId','clientId','clientSecret','publicOrigin','loginPort','organizationTtlMs','loginTtlMs','communicationRetentionDays'].includes(k)))return pending('需配置钉钉认证；不回退仅SSH业务身份');
  if(!text(d.corpId)||!text(d.clientId)||typeof d.clientSecret!=='string'||!d.clientSecret.trim()||d.clientSecret.length>4096)return pending('缺少钉钉组织／应用／私有凭据');
  try{const origin=new URL(d.publicOrigin);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error();}catch{return pending('钉钉登录需明确HTTPS origin，不开放普通DSH或投递接口');}
  if(!Number.isSafeInteger(d.loginPort)||d.loginPort<1||d.loginPort>65535)return pending('需指定本机OAuth后端端口');
  for(const [key,max,defaultValue]of [['organizationTtlMs',300000,300000],['loginTtlMs',43200000,43200000],['communicationRetentionDays',90,90]]){
    const value=d[key]??defaultValue;if(!Number.isSafeInteger(value)||value<1||value>max)return pending('钉钉有限复核、登录或保留期限无效');
  }
  return { state: 'configured', configPath, config:{...config,dingtalk:{organizationTtlMs:300000,loginTtlMs:43200000,communicationRetentionDays:90,...d}}, message: '配置格式完整；仍需宿主服务、钉钉权限验证和已注册模型路线。' };
}
