import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let imports = 0, links = 0;
function inspect(path) {
  const text = readFileSync(path, 'utf8');
  if (/\.(?:mjs|ts)$/.test(path)) {
    for (const match of text.matchAll(/(?:from\s*|import\s*|import\()\s*['"](\.[^'"]+)['"]/g)) {
      imports++;
      const target = resolve(dirname(path), match[1]);
      const rel = relative(root, target);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) failures.push(`Cross-project import: ${path} ${match[1]}`);
      else if (!existsSync(target) && !(path.endsWith('.ts') && existsSync(target.replace(/\.js$/, '.ts')))) failures.push(`Missing import: ${path} ${match[1]}`);
    }
  }
  if (path.endsWith('.md') && !path.split(sep).includes('history')) {
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let destination = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!destination || /^(?:https?:|mailto:|data:)/.test(destination) || isAbsolute(destination)) continue;
      try { destination = decodeURIComponent(destination); } catch { /* Preserve literal filename. */ }
      links++;
      if (!existsSync(resolve(dirname(path), destination))) failures.push(`Broken link: ${path} ${destination}`);
    }
  }
}
function walk(path) {
  if (!existsSync(path)) { failures.push(`Missing file/directory: ${path}`); return; }
  if (!statSync(path).isDirectory()) { inspect(path); return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (['node_modules', '.git', '.dsh', 'lib', 'lib-test'].includes(entry.name)) continue;
    walk(join(path, entry.name));
  }
}
for (const name of ['bin', 'src', 'business', 'test', 'scripts', 'deploy/ubuntu', 'docs', 'README.md', 'GLOSSARY.md']) walk(join(root, name));
console.log(JSON.stringify({ imports, links, failures }));
if (failures.length) process.exitCode = 1;
