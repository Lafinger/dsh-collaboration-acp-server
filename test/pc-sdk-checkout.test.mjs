import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';

test('official PC SDK stays byte-identical after Windows Git autocrlf checkout; exact integrity check is never relaxed',()=>{
 const root=mkdtempSync(join(tmpdir(),'pc-sdk-git-')),expected=readFileSync(new URL('../assets/dingtalk-pc.js',import.meta.url));mkdirSync(join(root,'assets'));
 const attrs=new URL('../.gitattributes',import.meta.url);writeFileSync(join(root,'.gitattributes'),existsSync(attrs)?readFileSync(attrs):'');writeFileSync(join(root,'assets/dingtalk-pc.js'),expected);
 const git=(...args)=>{const r=spawnSync('git',['-c','core.autocrlf=true',...args],{cwd:root,encoding:'utf8'});if(r.error)throw r.error;assert.equal(r.status,0,r.stderr);};
 git('init','--quiet');git('add','.gitattributes','assets/dingtalk-pc.js');writeFileSync(join(root,'assets/dingtalk-pc.js'),'force real checkout');git('checkout-index','--force','assets/dingtalk-pc.js');
 const actual=readFileSync(join(root,'assets/dingtalk-pc.js'));assert.ok(actual.equals(expected),`Windows checkout changed official SDK bytes: ${expected.length} -> ${actual.length}`);
});
