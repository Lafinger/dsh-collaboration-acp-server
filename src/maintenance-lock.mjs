import {open,mkdir,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {tryLockExclusive} from '@deepseek-ai/node-addon-system/flock';

/** Stable kernel ownership, no TTL/unlink/reset of a live lock. Shared by service and offline maintenance. */
export async function acquireMaintenanceLock(root){
  await mkdir(root,{recursive:true,mode:0o700});const stat=await lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||resolve(root)!==await realpath(root)||process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)))throw new Error('Canonical private maintenance root required');
  let parent=resolve(root);for(;;){const s=await lstat(parent);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Canonical maintenance ancestors required');const next=dirname(parent);if(next===parent)break;parent=next;}
  return acquireKernelLock(join(root,'collaboration-maintenance.lock'));
}
let winApi;
async function windowsApi(){
  if(winApi)return winApi;const {default:koffi}=await import('koffi'),dll=koffi.load('kernel32.dll');
  return winApi={create:dll.func('__stdcall','CreateSemaphoreW','intptr',['void*','int','int','str16']),wait:dll.func('__stdcall','WaitForSingleObject','uint',['intptr','uint']),release:dll.func('__stdcall','ReleaseSemaphore','int',['intptr','int','void*']),close:dll.func('__stdcall','CloseHandle','int',['intptr'])};
}
export async function acquireKernelLock(path,{session=false}={}){
  path=resolve(path);let released=false;
  if(process.platform==='win32'){
    // For Session logs this is exactly the pinned rc.2 persistence backend's kernel semaphore naming contract.
    const api=await windowsApi(),prefix=session?'dsh-session-lock-':'dsh-collaboration-maintenance-',name='Local\\'+prefix+createHash('sha256').update(path.toLowerCase()).digest('hex');
    const handle=api.create(null,1,1,name);if(!handle)throw new Error('Kernel maintenance lock unavailable');
    if(api.wait(handle,0)!==0){api.close(handle);throw new Error('Service or session still active; stop it before maintenance');}
    return {async release(){if(released)return;released=true;const a=api.release(handle,1,null),b=api.close(handle);if(!a||!b)throw new Error('Kernel maintenance lock release failed');}};
  }
  const before=await lstat(path).catch(e=>{if(e.code!=='ENOENT')throw e;});if(before&&(!before.isFile()||before.isSymbolicLink()||before.nlink!==1))throw new Error('Unsafe lock file');
  const fd=await open(path,'a+',0o600);try{await tryLockExclusive(fd.fd);const held=await fd.stat(),current=await lstat(path);
    if(!current.isFile()||current.isSymbolicLink()||current.ino!==held.ino||current.dev!==held.dev||current.nlink!==1)throw new Error('Lock inode changed');
    return {async release(){if(released)return;released=true;await fd.close();}};
  }catch{await fd.close();throw new Error('Service or session lock unavailable; stop it before maintenance');}
}
