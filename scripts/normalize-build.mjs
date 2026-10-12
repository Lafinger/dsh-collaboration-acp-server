import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Canonical generated text: TypeScript retains trailing spaces from wrapped signatures. */
export function normalizeBuild(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) normalizeBuild(file);
    else if (/\.(?:js|ts)$/.test(entry.name)) {
      const text = readFileSync(file, 'utf8'), normalized = text.replace(/\r\n/g, '\n').replace(/[\t ]+$/gm, '');
      if (text !== normalized) writeFileSync(file, normalized);
    }
  }
}
