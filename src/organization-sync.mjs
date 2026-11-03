/** Poll only already-enrolled members. Local disablement and organization qualification are independent. */
export class OrganizationSync {
  constructor({identities,login,intervalMs=300000,concurrency=3,debounceMs=5000,now=Date.now,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}) {
    if(!Number.isSafeInteger(intervalMs)||intervalMs<1||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>20)throw new Error('Invalid organization sync bounds');
    this.identities=identities;this.login=login;this.intervalMs=intervalMs;this.concurrency=concurrency;this.now=now;
    if(!Number.isSafeInteger(debounceMs)||debounceMs<0||debounceMs>30000)throw new Error('Invalid sync debounce');
    this.debounceMs=debounceMs;this.lastResult=null;
    this.setInterval=setIntervalImpl;this.clearInterval=clearIntervalImpl;this.failures=new Map();this.task=null;this.timer=null;this.closed=false;
  }
  start() {
    if(this.closed)throw new Error('Organization sync is closed');
    if(this.timer!==null)return this;
    const run=()=>{void this.sync({force:true,background:true}).catch(()=>{});};
    this.timer=this.setInterval(run,this.intervalMs);this.timer?.unref?.();run();return this;
  }
  sync({force=true,background=false}={}) {
    if(this.closed)return Promise.resolve({status:'closed',checkedAt:this.now(),checked:0,failed:0});
    if(this.task){
      if(!background&&this.taskBackground){
        if(!this.manualTask){
          const queued=this.task.then(result=>result.skipped>0?this.sync({force,background:false}):result).finally(()=>{if(this.manualTask===queued)this.manualTask=null;});
          this.manualTask=queued;
        }
        return this.manualTask;
      }
      return this.task;
    }
    if(this.lastResult&&(background||!this.lastResult.skipped)&&this.lastResult.checkedAt+this.debounceMs>this.now())return Promise.resolve(this.lastResult);
    this.taskBackground=background;
    const task=this.run({force,background}).then(result=>{this.lastResult=result;return result;}).finally(()=>{if(this.task===task)this.task=null;});
    this.task=task;return task;
  }
  async run({force,background}) {
    const members=this.identities.db.prepare('SELECT account FROM collaboration_members WHERE enabled=1 ORDER BY account').all();
    let index=0,checked=0,failed=0,skipped=0;
    const worker=async()=>{
      while(!this.closed&&index<members.length){
        const {account}=members[index++],prior=this.failures.get(account);
        if(background&&prior?.retryAt>this.now()){skipped++;continue;}
        try{await this.login.refresh(account,{force});this.failures.delete(account);checked++;}
        catch{
          if(this.identities.profile(account)?.qualification==='revoked'&&this.identities.organization(account)?.reason!=='verification-unavailable'){checked++;this.failures.delete(account);continue;}
          checked++;failed++;
          const count=Math.min((prior?.count??0)+1,8);
          this.failures.set(account,{count,retryAt:this.now()+Math.min(this.intervalMs*2**(count-1),3600000)});
        }
      }
    };
    await Promise.all(Array.from({length:Math.min(this.concurrency,members.length)},worker));
    return {status:failed||skipped?'partial':'complete',checkedAt:this.now(),checked,failed,skipped};
  }
  async close() {
    this.closed=true;if(this.timer!==null){this.clearInterval(this.timer);this.timer=null;}
    if(this.task)await this.task.catch(()=>{});if(this.manualTask)await this.manualTask.catch(()=>{});this.failures.clear();
  }
}
