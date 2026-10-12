import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releaseNames, sha256, repository } from '../scripts/release-policy.mjs';
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const script = new URL('../scripts/publish-github-release.mjs', import.meta.url).href;
for (const mode of ['new', 'same', 'different', 'missing']) {
  test(`release API scenario ${mode}: publish once or fail closed without replacing attachments`, () => {
    const root = mkdtempSync(join(tmpdir(), 'github-release-test-')), directory = join(root, 'assets'); mkdirSync(directory);
    writeFileSync(join(root, 'package.json'), JSON.stringify(metadata));
    const names = releaseNames(metadata.version), commit = 'a'.repeat(40), bytes = Buffer.from('fixture-plugin');
    writeFileSync(join(directory, names.packageName), bytes);
    writeFileSync(join(directory, names.checksumName), `${sha256(bytes)}  ${names.packageName}\n`);
    writeFileSync(join(directory, names.metadataName), JSON.stringify({ repository, version: metadata.version, tag: names.tag, commit, package: names.packageName,
      sha256: sha256(bytes), registryPublication: false, marketPublication: false }));
    const mock = join(root, 'mock.mjs');
    writeFileSync(mock, `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {join} from 'node:path';
const mode=${JSON.stringify(mode)},directory=${JSON.stringify(directory)},names=${JSON.stringify(names)};
let uploads=0,published=0,created=0;const assets=Object.values(names).filter(n=>n!==names.tag).map((name,id)=>({name,id,browser_download_url:'https://github.com/${repository}/releases/download/'+names.tag+'/'+name}));
globalThis.fetch=async(url,options={})=>{url=String(url);const method=options.method??'GET';
 if(url.includes('uploads.github.com')){assert.equal(mode,'new');uploads++;return Response.json({id:uploads});}
 if(url.includes('/releases/download/')){assert.equal(options.headers,undefined);const name=url.split('/').at(-1);return new Response(mode==='different'?Buffer.from('changed'):readFileSync(join(directory,name)));}
 if(url.endsWith('/assets'))return Response.json(mode==='new'?[]:mode==='missing'?[]:assets);
 if(method==='GET'&&url.includes('/releases/tags/'))return mode==='new'?new Response('',{status:404}):Response.json({id:1,draft:false,html_url:'fixture-release'});
 if(method==='POST'&&url.endsWith('/releases')){const body=JSON.parse(options.body);assert.equal(body.draft,true);created++;return Response.json({id:1,draft:true,html_url:'fixture-release'});}
 if(method==='PATCH'){assert.equal(mode,'new');assert.equal(JSON.parse(options.body).draft,false);published++;return Response.json({id:1,draft:false,html_url:'fixture-release'});}
 throw new Error('Unexpected mock request '+method+' '+url);
};
process.on('exit',()=>{if(mode==='new'){assert.equal(created,1);assert.equal(uploads,3);assert.equal(published,1);}else{assert.equal(uploads,0);assert.equal(published,0);}});`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, '--input-type=module', '-e', `process.argv[2]=${JSON.stringify(directory)};await import(${JSON.stringify(script)});`],
      { cwd: root, encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'test-only-not-a-credential', GITHUB_SHA: commit, GITHUB_REF_NAME: names.tag, GITHUB_REPOSITORY: repository } });
    if (result.error) throw result.error;
    assert.equal(result.status, ['new', 'same'].includes(mode) ? 0 : 1, result.stderr);
    if (mode === 'different') assert.match(result.stderr, /do not overwrite/);
    if (mode === 'missing') assert.match(result.stderr, /refuse mutation/);
  });
}
