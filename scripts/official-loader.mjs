// Test/isolated-launcher import routing only. No profile installation or global mutation.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const root = process.env.WORKBENCH_OFFICIAL_NODE_MODULES;
if (root) {
for (const name of ['dsh-agent', 'dsh-agent-loop', 'dsh-llm', 'dsh-session', 'dsh-tools', 'dsh-session-persistence-jsonl']) {
  const metadata = JSON.parse(readFileSync(resolve(root, '@deepseek-ai', name, 'package.json'), 'utf8'));
  if (metadata.version !== '0.1.5-rc.2') throw new Error(`Prototype requires 0.1.5-rc.2 package family; ${name}=${metadata.version}`);
}
const parentURL = pathToFileURL(resolve(root, 'workbench-prototype-resolution.mjs')).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/') || specifier === 'zod' || specifier.startsWith('zod/')) {
    return nextResolve(specifier, { ...context, parentURL });
  }
  return nextResolve(specifier, context);
} });
}
