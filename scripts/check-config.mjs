import { resolveServerConfiguration } from '../src/configuration.mjs';
const result = resolveServerConfiguration(process.argv[2] ? { configFile: process.argv[2] } : {});
const { config, ...safe } = result;
console.log(JSON.stringify(safe, null, 2));
if (result.state !== 'configured') process.exitCode = 1;
