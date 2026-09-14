import { openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError } from '../../errors.js';
import type { DesktopAdapter, StoredTask } from '../../types.js';
import { CdpClient } from './cdp.js';
import { lookupServices, openWorkspaceExpression, serviceExpression } from './renderer.js';
import { projectSnapshot } from './project.js';

function installedVersion(install: string): string {
  const fd = openSync(join(install, 'resources', 'app.asar'), 'r');
  try {
    const b = Buffer.alloc(16); readSync(fd, b, 0, 16, 0);
    const size = b.readUInt32LE(12);
    if (size > 64 * 1024 * 1024) throw new Error('Invalid archive header');
    const h = Buffer.alloc(size); readSync(fd, h, 0, size, 16);
    const value = JSON.parse(h.toString()).files['package.json'];
    if (!value || value.unpacked || value.size > 1024 * 1024) throw new Error('Unexpected package metadata');
    const data = Buffer.alloc(value.size);
    readSync(fd, data, 0, data.length, 8 + b.readUInt32LE(4) + Number(value.offset));
    return JSON.parse(data.toString()).version;
  } finally { closeSync(fd); }
}
export class ZCodeDesktopAdapter implements DesktopAdapter {
  constructor(readonly cdp = new CdpClient(), readonly install = process.env.ZCODE_INSTALL_DIR || 'C:\\Program Files\\ZCode') {}
  async health() {
    let version: string;
    try { version = installedVersion(this.install); }
    catch { throw new BridgeError('ZCODE_NOT_FOUND', 'Cannot read ZCode installation. Set ZCODE_INSTALL_DIR.'); }
    if (version !== '3.12.1') throw new BridgeError('UNSUPPORTED_VERSION', `Desktop ${version} has not been validated; this adapter supports 3.12.1.`);
    const ready = await this.cdp.evaluate<boolean>(`(() => {const s=${lookupServices};return !!s.zcodeTaskService && !!s.zcodeAgentService;})()`);
    return { connected: ready, desktop_version: version, adapter: 'desktop-3.12.1', transport: 'local-cdp', permission_mode: 'build', model: 'inherited from ZCode', automatic_permission_approval: false };
  }
  async listModels() {
    return this.cdp.evaluate<any>(`(async()=>{const v=await (${lookupServices}).modelSelectionService.getView();return {providers:v.providers.map(p=>({provider_id:p.providerId,name:p.providerName,models:p.models.map(m=>({model_id:m.modelId,reasoning_levels:m.config?.optionSpecs?.reasoningLevel?.values || []}))})),preferred_selection:v.preferredSelection?{providerId:v.preferredSelection.providerId,modelId:v.preferredSelection.modelId,options:{reasoningLevel:v.preferredSelection.options?.reasoningLevel}}:null};})()`);
  }
  private call<T = any>(service: string, method: string, input: unknown): Promise<T> {
    return this.cdp.evaluate(serviceExpression(service, method, input), 90000);
  }
  private async command(task: StoredTask, type: string, payload: unknown, commandId: string, sessionId: string | null) {
    const ack = await this.call('zcodeAgentService', 'sendConversationCommandV4', {
      workspacePath: task.workspace_path,
      envelope: { commandId, sessionId, type, payload, issuedAt: Date.now() },
    });
    if (!['accepted', 'duplicate', 'noop'].includes(ack?.status)) throw new BridgeError('COMMAND_REJECTED', `${type}: ${ack?.reasonCode || ack?.status || 'invalid response'} ${ack?.message || ''}`);
    return ack;
  }
  async createSession(task: StoredTask, commandId: string) {
    await this.health();
    await this.cdp.evaluate(openWorkspaceExpression(task.workspace_path));
    const ack = await this.command(task, 'createSession', { workspaceId: task.workspace_path, config: { mode: 'build', ...(task.model_selection ? { provider: task.model_selection.providerId, model: task.model_selection.modelId, thought: task.model_selection.options?.reasoningLevel } : {}) } }, commandId, null);
    if (typeof ack.result?.sessionId !== 'string') throw new BridgeError('PROTOCOL_MISMATCH', 'Create acknowledgement omitted sessionId. Do not create a replacement task.');
    return ack.result.sessionId;
  }
  async registerTask(task: StoredTask) {
    const actual = await this.call('zcodeTaskService', 'createTask', { workspacePath: task.workspace_path, draftSessionId: task.zcode_session_id, mode: 'build', modelSelection: task.model_selection });
    if (actual.taskId !== task.zcode_session_id) throw new BridgeError('SESSION_REPLACED', 'ZCode replaced the requested session; inspect the desktop before continuing.');
    await this.call('zcodeTaskService', 'renameTask', { workspacePath: task.workspace_path, taskId: task.zcode_session_id, title: task.title });
  }
  async send(task: StoredTask, text: string, commandId: string) {
    const ack = await this.command(task, 'sendText', { text, requestedDelivery: 'startNow', modelSelection: task.model_selection }, commandId, task.zcode_session_id!);
    return { messageId: ack.result?.messageId };
  }
  async observe(task: StoredTask) {
    const snapshot = await this.call('zcodeSessionService', 'readSession', { workspacePath: task.workspace_path, sessionId: task.zcode_session_id });
    return projectSnapshot(snapshot, task);
  }
  async stop(task: StoredTask, commandId: string) { await this.command(task, 'stop', {}, commandId, task.zcode_session_id!); }
  async resolvePermission(task: StoredTask, requestId: string, allow: boolean, commandId: string) { await this.command(task, 'resolveInteraction', {interactionId:requestId,answer:{optionId:allow?'allow_once':'deny'}}, commandId, task.zcode_session_id!); }
  close() { this.cdp.close(); }
}
