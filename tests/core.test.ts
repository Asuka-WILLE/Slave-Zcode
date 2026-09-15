import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskStore } from '../src/storage/store.js';
import { TaskManager } from '../src/tasks/manager.js';
import { projectSnapshot } from '../src/adapters/zcode-desktop/project.js';
import { localEndpoint } from '../src/adapters/zcode-desktop/cdp.js';
import { interfaceHealthExpression, serviceExpression } from '../src/adapters/zcode-desktop/renderer.js';
import { ZCodeDesktopAdapter } from '../src/adapters/zcode-desktop/adapter.js';
import { changedFiles, snapshotFiles } from '../src/results/files.js';
import { discoverZCodeInstall, installationError } from '../src/adapters/zcode-desktop/install.js';
import type { DesktopAdapter, Observation, StoredTask } from '../src/types.js';

class Fake implements DesktopAdapter {
  created = 0; sent = 0; stopped = 0; failSend = false;
  observation: Observation = { status: 'running', summary: 'running', final_message: '', verification_summary: '', user_message_ids: [], user_commands: [], mode: 'build', source_revision: 1, unresolved_items: [] };
  async health() { return { connected: true }; }
  async createSession() { this.created++; return `sess-${this.created}`; }
  async registerTask() {}
  async send() { this.sent++; if(this.failSend) throw new Error('response lost'); return {messageId:'ours'}; }
  async stop() { this.stopped++; }
  async resolvePermission() {}
  async observe() { return this.observation; }
  close() {}
}
async function fixture(t: any) {
  const path = await mkdtemp(join(tmpdir(),'zcode 中文 '));
  const store = new TaskStore(join(path,'test.sqlite'));
  const fake = new Fake(); const manager = new TaskManager(store,fake,async()=>({}));
  t.after(async()=>{await manager.close();await rm(path,{recursive:true,force:true});});
  const input = {workspace_path:path,title:'Test',prompt:'Read files',request_id:'request-1'};
  return {path,store,fake,manager,input};
}
test('concurrent identical starts create one desktop task; conflicting IDs and writers are rejected',async t=>{
  const {manager,fake,input}=await fixture(t);
  const [a,b]=await Promise.all([manager.start(input),manager.start(input)]);
  assert.equal(a.task_id,b.task_id); await manager.drain();
  assert.equal(fake.created,1);assert.equal(fake.sent,1);
  await assert.rejects(manager.start({...input,prompt:'Different'}),/different task content/);
  await assert.rejects(manager.start({...input,request_id:'second'}),/already reserved/);
});
test('lost send response stays unknown and does not trigger another model run',async t=>{
  const {manager,fake,input,store}=await fixture(t);fake.failSend=true;
  const task=await manager.start(input);await manager.drain();
  assert.equal(store.get(task.task_id).status,'unknown');
  await manager.start(input);assert.equal(fake.sent,1);
  await assert.rejects(manager.send(task.task_id,'retry','retry-id'),/uncertain/);
});
test('a wait timeout never stops a running model task',async t=>{
  const {manager,fake,input}=await fixture(t);const task=await manager.start(input);await manager.drain();
  const a=await manager.get(task.task_id);const b=await manager.wait(task.task_id,a.cursor,10);
  assert.equal(b.status,'running');assert.equal(fake.stopped,0);
});
test('stop is idempotent and needs a confirmed inactive state',async t=>{
  const {manager,fake,input}=await fixture(t);const task=await manager.start(input);await manager.drain();
  assert.equal((await manager.stop(task.task_id)).status,'stopping');
  assert.equal((await manager.get(task.task_id)).status,'stopping');
  await manager.stop(task.task_id);assert.equal(fake.stopped,1);
  fake.observation.status='stopped';assert.equal((await manager.get(task.task_id)).status,'stopped');
});
test('foreign desktop messages transfer control and prevent automatic follow-up',async t=>{
  const {manager,fake,input}=await fixture(t);const task=await manager.start(input);await manager.drain();
  fake.observation={...fake.observation,status:'completed',user_message_ids:['manual'],user_commands:[{messageId:'manual',commandId:'desktop-command'}]};
  const current=await manager.get(task.task_id);assert.equal(current.control_owner,'user');
  await assert.rejects(manager.send(task.task_id,'next','next'),/User has taken control/);
  const resumed=await manager.send(task.task_id,'next','next',true);assert.equal(resumed.control_owner,'codex');
});
test('per-task leases exclude a second process and can be reacquired after expiry',async t=>{
  const {store}=await fixture(t);
  assert.equal(store.acquire('a','task:x',100),true);
  assert.equal(store.acquire('b','task:x',101),false);
  assert.equal(store.acquire('b','task:x',60200),true);
});
test('incomplete assistant text is not completion; captcha errors are reported without retry',()=>{
  const task={stage:'submitted',zcode_session_id:'s'} as StoredTask;
  const raw={session:{sessionId:'s',status:'running',mode:'build'},runtime:{activeTurnId:'t',eventSeq:2},messages:[{info:{role:'assistant',time:{}},parts:[{type:'text',text:'Working'}]}]};
  assert.equal(projectSnapshot(raw,task).status,'running');
  const failure={...raw,session:{...raw.session,status:'error'},runtime:{eventSeq:3},messages:[{info:{role:'assistant',time:{completed:1},error:{data:{message:'Captcha verification request timed out.'}}},parts:[]}]};
  const view=projectSnapshot(failure,task);assert.equal(view.status,'failed');assert.equal(view.error?.code,'ZCODE_AUTH_REQUIRED');assert.equal(view.error?.retryable,false);
});
test('file baseline distinguishes old content from new changes and leaves files intact',async t=>{
  const path=await mkdtemp(join(tmpdir(),'zcode baseline '));t.after(()=>rm(path,{recursive:true,force:true}));
  await writeFile(join(path,'existing.txt'),'pre-existing user change');const before=await snapshotFiles(path);
  await writeFile(join(path,'new.txt'),'new content');const after=await snapshotFiles(path);
  assert.deepEqual(changedFiles(before,after),['new.txt']);
});
test('CDP endpoints and desktop method names cannot become arbitrary remote code targets',()=>{
  assert.throws(()=>localEndpoint('https://example.com'),/loopback/);
  assert.throws(()=>localEndpoint('http://user:pass@localhost:9222'),/loopback/);
  assert.throws(()=>serviceExpression('credentialService','get',{}),/Unsupported/);
  const expression=serviceExpression('zcodeTaskService','renameTask',{title:'` ${throwThis()} "; alert(1);'});
  assert.ok(expression.includes('const input = {'));
});

test('follow-up retry returns the existing result while a new turn is running',async t=>{
 const {manager,fake,input}=await fixture(t);const task=await manager.start(input);await manager.drain();
 fake.observation.status='completed';await manager.send(task.task_id,'next','follow-up');
 fake.observation.status='running';await manager.send(task.task_id,'next','follow-up');assert.equal(fake.sent,2);
 await assert.rejects(manager.send(task.task_id,'different','follow-up'),/different content/);
});
test('model initialization failures with no assistant message preserve the error',()=>{
 const view=projectSnapshot({session:{sessionId:'s',status:'error'},runtime:{},messages:[],projection:{lastError:{message:'Reasoning level is required'}}},{zcode_session_id:'s',stage:'submitted'} as StoredTask);
 assert.equal(view.error?.message,'Reasoning level is required');assert.equal(view.status,'failed');
});

test('a previous assistant completion cannot finish a newly submitted input',()=>{
 const raw={session:{sessionId:'s',status:'idle'},runtime:{},messages:[{info:{role:'assistant',time:{completed:1}},parts:[{type:'text',text:'Old result'}]}]};
 const view=projectSnapshot(raw,{zcode_session_id:'s',stage:'submitted',latest_input_command_id:'new-command'} as StoredTask);
 assert.equal(view.status,'queued');assert.equal(view.final_message,'');
});
test('a follow-up blocked by another workspace writer can be retried after release',async t=>{
 const {manager,fake,input}=await fixture(t);const a=await manager.start(input);await manager.drain();fake.observation.status='completed';await manager.get(a.task_id);
 const b=await manager.start({...input,request_id:'second'});await manager.drain();
 await assert.rejects(manager.send(a.task_id,'next','next'),/reserves this workspace/);
 await manager.get(b.task_id);await manager.send(a.task_id,'next','next');assert.equal(fake.sent,3);
});

test('permission resolution checks the current fingerprint and user ownership',async t=>{
 const {manager,fake,input}=await fixture(t);let approved=0;
 fake.resolvePermission=async()=>{approved++;};
 const task=await manager.start(input);await manager.drain();
 fake.observation={...fake.observation,status:'waiting_for_input',pending_permissions:[{request_id:'p',tool:'Bash',input:{command:'node --test'},fingerprint:'current'}]};
 await assert.rejects(manager.resolvePermission(task.task_id,'p','stale',true),/pending request changed/);assert.equal(approved,0);
 await manager.resolvePermission(task.task_id,'p','current',true);assert.equal(approved,1);
 fake.observation.user_commands=[{messageId:'manual',commandId:'external'}];
 await assert.rejects(manager.resolvePermission(task.task_id,'p','current',true),/user has control/);assert.equal(approved,1);
});

test('reading a task during initialization does not mark it unknown',async t=>{
 const path = await mkdtemp(join(tmpdir(),'zcode initialization '));
 const store = new TaskStore(join(path,'test.sqlite')); const fake = new Fake();
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const manager = new TaskManager(store,fake,async()=>{ await gate; return {}; });
 t.after(async()=>{ await manager.close(); await rm(path,{recursive:true,force:true}); });
 const task = await manager.start({workspace_path:path,title:'Test',prompt:'Read files',request_id:'initialization-request'});
 const observed = await manager.get(task.task_id);
 assert.equal(observed.status,'queued');
 release();
 await manager.drain();
 assert.ok((await manager.get(task.task_id)).zcode_session_id);
});

test('ZCode installation discovery honors an explicit override and validates its shape',async t=>{
 const root=await mkdtemp(join(tmpdir(),'zcode install override '));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const install=join(root,'custom-zcode');
 await mkdir(join(install,'resources'),{recursive:true});
 await writeFile(join(install,'ZCode.exe'),''); await writeFile(join(install,'resources','app.asar'),'');
 const found=discoverZCodeInstall({platform:'win32',env:{ZCODE_INSTALL_DIR:install}});
 assert.equal(found.path,resolve(install)); assert.equal(found.explicit,resolve(install));
 const missing=discoverZCodeInstall({platform:'win32',env:{ZCODE_INSTALL_DIR:join(root,'missing')}});
 assert.equal(missing.path,undefined); assert.match(installationError(missing),/ZCODE_INSTALL_DIR/);
});

test('ZCode installation discovery keeps candidate order regardless of application version',async t=>{
 const root=await mkdtemp(join(tmpdir(),'zcode install candidates '));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const unsupported=join(root,'registered'); const supported=join(root,'portable');
 for(const install of [unsupported,supported]){
   await mkdir(join(install,'resources'),{recursive:true});
   await writeFile(join(install,'ZCode.exe'),''); await writeFile(join(install,'resources','app.asar'),'');
 }
 const result=discoverZCodeInstall({
   platform:'win32', env:{},
   processPaths:[],
  registryPaths:[`"${join(unsupported,'Uninstall ZCode.exe')}" /allusers`],
  pathPaths:[join(supported,'ZCode.exe')],
  shortcutPaths:[],
  });
  assert.equal(result.path,resolve(unsupported));
  assert.deepEqual(result.candidates.map(item=>item.source),['Windows-registry','PATH']);
});

test('ZCode installation discovery reports the checked scope when no candidate exists',()=>{
 const base=join(tmpdir(),'zcode missing candidates deterministic');
 const result=discoverZCodeInstall({platform:'win32',env:{ProgramFiles:join(base,'ProgramFiles'),LOCALAPPDATA:join(base,'LocalAppData')},processPaths:[],registryPaths:[],pathPaths:[],shortcutPaths:[]});
 assert.equal(result.path,undefined); assert.ok(result.checked.length>0); assert.match(installationError(result),/Checked:/);
});

test('ZCode installation discovery accepts a custom Start-menu shortcut target',async t=>{
 const root=await mkdtemp(join(tmpdir(),'zcode install shortcut '));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const install=join(root,'custom-zcode');
 await mkdir(join(install,'resources'),{recursive:true});
 await writeFile(join(install,'ZCode.exe'),''); await writeFile(join(install,'resources','app.asar'),'');
 const result=discoverZCodeInstall({platform:'win32',env:{},processPaths:[],registryPaths:[],pathPaths:[],shortcutPaths:[join(install,'ZCode.exe')]});
  assert.equal(result.path,resolve(install)); assert.equal(result.candidates[0]?.source,'Start-menu-shortcut');
});

async function writeAsarPackage(path: string, version: string) {
  const packageData = Buffer.from(JSON.stringify({ version }));
  const header = Buffer.from(JSON.stringify({ files: { 'package.json': { size: packageData.length, offset: '0' } } }));
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(header.length + 8, 4);
  prefix.writeUInt32LE(header.length, 12);
  await writeFile(path, Buffer.concat([prefix, header, packageData]));
}

function healthCdp(report: unknown) {
  return {
    expressions: [] as string[],
    async evaluate(expression: string) { this.expressions.push(expression); return report; },
    close() {},
  };
}

async function makeInstall(t: any, version?: string) {
  const root = await mkdtemp(join(tmpdir(), 'zcode health install '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const install = join(root, 'zcode');
  await mkdir(join(install, 'resources'), { recursive: true });
  await writeFile(join(install, 'ZCode.exe'), '');
  const archive = join(install, 'resources', 'app.asar');
  if (version) await writeAsarPackage(archive, version); else await writeFile(archive, '');
  return install;
}

test('health accepts ZCode 3.11.2 when the required interface is complete', async t => {
  const install = await makeInstall(t, '3.11.2');
  const cdp = healthCdp({ availableServices: ['zcodeTaskService', 'zcodeSessionService', 'modelSelectionService', 'zcodeAgentService'], missing: [] });
  const adapter = new ZCodeDesktopAdapter(cdp as any, install);
  const result = await adapter.health();
  assert.equal(result.connected, true);
  assert.equal(result.desktop_version, '3.11.2');
  assert.equal(result.adapter, 'desktop-cdp');
  assert.equal(cdp.expressions.length, 1);
  assert.ok(cdp.expressions[0]?.includes(interfaceHealthExpression));
});

test('health continues when application version metadata cannot be read', async t => {
  const install = await makeInstall(t);
  const cdp = healthCdp({ availableServices: ['all'], missing: [] });
  const adapter = new ZCodeDesktopAdapter(cdp as any, install);
  const result = await adapter.health();
  assert.equal(result.connected, true);
  assert.equal(result.desktop_version, null);
});

test('health reports missing desktop methods without creating a task', async t => {
  const install = await makeInstall(t, '3.11.2');
  const cdp = healthCdp({ availableServices: ['zcodeTaskService'], missing: ['modelSelectionService.getView', 'zcodeAgentService.sendConversationCommandV4'] });
  const adapter = new ZCodeDesktopAdapter(cdp as any, install);
  await assert.rejects(adapter.health(), (error: any) => error?.code === 'DESKTOP_INTERFACE_UNAVAILABLE'
    && /modelSelectionService\.getView/.test(error.message)
    && /zcodeAgentService\.sendConversationCommandV4/.test(error.message));
  assert.equal(cdp.expressions.length, 1);
});
