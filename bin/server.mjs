#!/usr/bin/env node
// Normal installed dependencies by default; optional cache routing is limited to this process.
await import('../scripts/official-loader.mjs');
await import('../src/server-cli.mjs');
