import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';

const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const sizeText = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
const asciiName = name => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';

function page(token, files) {
  const rows = files.map(file => {
    const label = escape(file.original_name ?? '文件名称不可用');
    const name = file.available === false ? label : `<a href="/d/${token}/${file.position}">${label}</a>`;
    const info = `${file.kind === 'material' ? '参考资料' : '成果原件'}${Number.isSafeInteger(file.version) ? ` · 固定 v${file.version}` : ''}`;
    return `<li>${name} <span>${info} · ${file.available === false ? '不可用（原件缺失或校验失败）' : sizeText(file.size_bytes)}</span></li>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>相关文件</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#222}h1{font-size:1.3rem}ul{padding-left:1.2rem}li{margin:.5rem 0}span{color:#666;margin-left:.5rem}</style>
<h1>相关文件</h1><ul>${rows || '<li>没有可下载的文件。</li>'}</ul></html>`;
}
const message = text => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>相关文件</title><p>${text}</p></html>`;
function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(body);
}
function handler(downloads) {
  return (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return; }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { html(res, 404, message('下载地址无效。')); return; }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'd' || (parts.length !== 2 && parts.length !== 3)) { html(res, 404, message('下载地址无效。')); return; }
    const token = parts[1];
    if (parts.length === 2) {
      const pageData = downloads.page(token);
      if (pageData.status === 410) { html(res, 410, message('下载链接已过期，请联系相关人员重新获取通知。')); return; }
      if (pageData.status !== 200) { html(res, 404, message('下载链接无效。')); return; }
      html(res, 200, page(token, pageData.files)); return;
    }
    if (!/^\d+$/.test(parts[2])) { html(res, 404, message('文件不存在。')); return; }
    const file = downloads.file(token, Number(parts[2]));
    if (file.status === 410) { html(res, 410, message('下载链接已过期，请联系相关人员重新获取通知。')); return; }
    if (file.status !== 200) { html(res, 404, message('文件不存在。')); return; }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': file.size,
      'content-disposition': `attachment; filename="${asciiName(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    downloads.record(token);
    pipeline(createReadStream(file.path), res, () => {});
  };
}

/** One listener per configured internal address. No TLS, no proxy, no member auth (ADR-0010). */
export async function listenResultDownloads(downloads, { port = downloads.port, hosts = downloads.hosts } = {}) {
  if (!Array.isArray(hosts) || !hosts.length) throw new Error('Result download hosts required');
  const servers = [];
  try {
    for (const host of hosts) {
      const serve = handler(downloads);
      const server = createServer((req, res) => {
        try { serve(req, res); }
        catch { if (res.headersSent) res.destroy(); else html(res, 500, message('暂时无法下载，请稍后重试。')); }
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      servers.push(server);
    }
  } catch (error) {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(() => resolve()))));
    throw error;
  }
  return {
    addresses: servers.map(server => server.address()),
    close: () => Promise.all(servers.map(server => new Promise(resolve => server.close(() => resolve())))),
  };
}
