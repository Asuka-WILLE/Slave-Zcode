// Development-only live bridge verification. Only creates/operates its own persisted smoke task.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CdpClient } from '../dist/src/adapters/zcode-desktop/cdp.js';
import { serviceExpression, openWorkspaceExpression } from '../dist/src/adapters/zcode-desktop/renderer.js';
const base = resolve('.runtime');
const workspacePath = resolve(base, 'acceptance');
await mkdir(workspacePath, { recursive: true });
const statePath = resolve(base, 'smoke-state.json');
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if(e.code !== 'ENOENT') throw e; state = { workspacePath }; }
const cdp = new CdpClient();
const call = (service, method, args) => cdp.evaluate(serviceExpression(service, method, args), 90000);
const save = () => writeFile(statePath, JSON.stringify(state, null, 2));
try {
  const action = process.argv[2] || 'read';
  if (action === 'show') {
    console.log(await cdp.evaluate(openWorkspaceExpression(workspacePath)));
  } else if (action === 'create') {
    if (state.sessionId) throw new Error('Smoke task already exists.');
    // Reuse the same command ID when retrying a confirmed protocol rejection.
    if (state.createAttempted && process.argv[3] !== '--retry-rejected') throw new Error('Creation was already attempted. Inspect it before retrying.');
    state.commandId ||= randomUUID(); state.createAttempted = true; await save();
    const ack = await call('zcodeAgentService', 'sendConversationCommandV4', { workspacePath, envelope: { commandId: state.commandId, clientId: 'codex-zcode-smoke', sessionId: null, type: 'createSession', payload: { workspaceId: workspacePath, config: { mode: 'build' } }, issuedAt: Date.now() } });
    state.createAck = ack; state.sessionId = ack.result?.sessionId; await save();
    if (!state.sessionId) throw new Error(JSON.stringify(ack));
    state.task = await call('zcodeTaskService', 'createTask', { workspacePath, draftSessionId: state.sessionId, mode: 'build' }); await save();
    await call('zcodeTaskService', 'renameTask', { workspacePath, taskId: state.sessionId, title: 'Codex 插件桌面桥接验收' });
    console.log(JSON.stringify({ created: true, sessionId: state.sessionId, task: state.task }, null, 2));
  } else if (action === 'send') {
    if (!state.sessionId) throw new Error('Create the smoke task first');
    const commandId = randomUUID();
    const text = process.argv[3] || '这是 Codex 插件桌面桥接的只读验收。请不要使用任何工具或修改文件，只回复 ZCODE_BRIDGE_OK。';
    const ack = await call('zcodeAgentService', 'sendConversationCommandV4', { workspacePath, envelope: { commandId, clientId: 'codex-zcode-smoke', sessionId: state.sessionId, type: 'sendText', payload: { text }, issuedAt: Date.now() } });
    state.sendAck = ack; await save(); console.log(JSON.stringify(ack, null, 2));
  } else if (action === 'stop') {
    const ack = await call('zcodeAgentService', 'sendConversationCommandV4', { workspacePath, envelope: { commandId: randomUUID(), clientId: 'codex-zcode-smoke', sessionId: state.sessionId, type: 'stop', payload: {}, issuedAt: Date.now() } });
    console.log(JSON.stringify(ack, null, 2));
  } else if (action === 'read') {
    if (!state.sessionId) throw new Error('Create the smoke task first');
    const snapshot = await call('zcodeSessionService', 'readSession', { workspacePath, sessionId: state.sessionId });
    await writeFile(resolve(base, 'smoke-snapshot.json'), JSON.stringify(snapshot, null, 2));
    console.log(JSON.stringify(snapshot, null, 2));
  } else if (action === 'list') {
    console.log(JSON.stringify(await call('zcodeTaskService', 'listTasks', { workspacePath }), null, 2));
  } else throw new Error(`Unknown action ${action}`);
} finally { cdp.close(); }
