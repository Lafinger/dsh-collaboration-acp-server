import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
const root=fileURLToPath(new URL('..',import.meta.url));
const result=await build({absWorkingDir:root,entryPoints:['scripts/pc-sdk-entry.js'],bundle:true,platform:'browser',format:'iife',target:'es2020',minify:true,legalComments:'inline',write:false});
const output=result.outputFiles[0].contents,path=new URL('../assets/dingtalk-pc.js',import.meta.url);
if(process.argv.includes('--check')){if(!existsSync(path)||!Buffer.from(readFileSync(path)).equals(Buffer.from(output)))throw new Error('Pinned official PC SDK bundle differs; run node scripts/build-pc-sdk.mjs');}
else{mkdirSync(new URL('../assets/',import.meta.url),{recursive:true});writeFileSync(path,output);}
console.log(JSON.stringify({pcSdk:'dingtalk-jsapi@3.2.9',sameOrigin:true,bytes:output.length,verified:process.argv.includes('--check')}));
