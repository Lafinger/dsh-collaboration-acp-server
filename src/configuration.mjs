import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve, relative } from 'node:path';
import { AccountAuthority } from './authority.mjs';
export const defaultConfigPath = () => join(homedir(), '.dsh', 'collaboration-acp-server.json');
const required = ['serviceId', 'workspace', 'stateRoot', 'socketPath', 'provider', 'model', 'accounts'];
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const nested = (a, b) => { const r = relative(resolve(a), resolve(b)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
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
  if (Object.keys(config).some(k => !required.includes(k))) return pending('配置含不支持字段，旧fixture/adapterModule部署配置不可直接使用');
  if (['serviceId', 'provider', 'model'].some(k => !text(config[k])) || ['workspace', 'stateRoot', 'socketPath'].some(k => typeof config[k] !== 'string' || !config[k].trim())) return pending('缺少serviceId/workspace/stateRoot/socketPath/provider/model');
  if (![config.workspace, config.stateRoot].every(isAbsolute)) return pending('workspace/stateRoot须为绝对路径');
  if (nested(config.workspace, config.stateRoot) || nested(config.stateRoot, config.workspace)) return pending('工作区与私有状态目录须分离，不能相互包含');
  if (process.platform === 'win32' ? !/^\\\\\.\\pipe\\[A-Za-z0-9_.-]+$/.test(config.socketPath) : !isAbsolute(config.socketPath)) return pending('须使用本地Unix socket或Windows测试命名管道');
  if (!config.accounts || typeof config.accounts !== 'object' || Array.isArray(config.accounts)
    || Object.keys(config.accounts).some(k => !/^[A-Za-z0-9_.-]+$/.test(k))) return pending('accounts须为合法登录账号与独立凭据的映射');
  try { new AccountAuthority(config); } catch { return pending('accounts须包含至少一个账号和各自不同的64+字符凭据'); }
  return { state: 'configured', configPath, config, message: '配置格式完整；仍需宿主服务、持久化和已注册模型路线。' };
}
