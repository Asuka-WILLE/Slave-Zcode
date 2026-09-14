import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, errorInfo } from '../errors.js';
import { changedFiles, snapshotFiles, workspaceKey, workspacePath } from '../results/files.js';
import { TaskStore } from '../storage/store.js';
import { publicTask, terminal, type DesktopAdapter, type StartInput, type StoredTask, type Task } from '../types.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class TaskManager {
  private running = new Set<Promise<unknown>>();
  private initializing = new Set<string>();
  constructor(readonly store: TaskStore, readonly adapter: DesktopAdapter, readonly snapshot = snapshotFiles) {}
  private persist(task: StoredTask) {
    task.cursor = String(Number(task.cursor) + 1); task.updated_at = Date.now(); this.store.save(task);
  }
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const owner = randomUUID(), name = `task:${id}`;
    if (!this.store.acquire(owner, name)) throw new BridgeError('TASK_BUSY', 'Another plugin operation is handling this task. Read its cached state or retry later.', true);
    let lost = false;
    const timer = setInterval(() => { try { if (!this.store.acquire(owner, name)) lost = true; } catch { lost = true; } }, 10000);
    timer.unref();
    try {
      const result = await action();
      if (lost) throw new BridgeError('LEASE_LOST', 'Task lease was lost; inspect the existing task before further writes.');
      return result;
    } finally { clearInterval(timer); this.store.release(owner); }
  }
  async start(input: StartInput): Promise<Task> {
    const path = await workspacePath(input.workspace_path);
    const fingerprint = hash({ ...input, workspace_path: workspaceKey(path) });
    const prior = this.store.byRequest(input.request_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new BridgeError('REQUEST_CONFLICT', 'request_id has different task content.');
      return publicTask(prior);
    }
    await this.adapter.health();
    let selected = input.model_selection;
    if (this.adapter.listModels) {
      const catalog = await this.adapter.listModels();
      selected ||= catalog.preferred_selection;
      if (selected) {
        const model = (Array.isArray(catalog.providers) ? catalog.providers : []).find((p: any) => p.provider_id === selected!.providerId)?.models.find((m: any) => m.model_id === selected!.modelId);
        if (!model) throw new BridgeError('MODEL_NOT_FOUND', 'Selected model is not configured in ZCode. Call zcode_list_models.');
        const reasoningLevels = Array.isArray(model.reasoning_levels) ? model.reasoning_levels : [];
        const level = selected.options?.reasoningLevel || reasoningLevels.at(-1);
        if (level && !reasoningLevels.includes(level)) throw new BridgeError('INVALID_MODEL_OPTION', 'Unsupported reasoning level for this model.');
        selected = { ...selected, ...(level ? {options:{reasoningLevel:level}} : {}) };
      }
    }
    const now = Date.now();
    const task: StoredTask = {
      task_id: randomUUID(), workspace_path: path, workspace_key: workspaceKey(path), title: input.title,
      model_selection: selected, prompt: input.prompt, request_id: input.request_id, fingerprint, status: 'queued', control_owner: 'codex',
      cursor: '1', created_at: now, updated_at: now, stage: 'reserved', baseline: {}, known_user_message_ids: [], command_ids: [],
    };
    const reservation = this.store.reserve(task);
    if (!reservation.created) return publicTask(reservation.task);
    // Persist the reservation before any desktop mutation. Tool calls return promptly.
    this.initializing.add(task.task_id);
    const work = this.locked(task.task_id, async () => {
      let remoteAttempted = false;
      try {
        task.baseline = await this.snapshot(path); this.persist(task);
        const createId = `codex-create-${task.task_id}`; task.command_ids.push(createId); this.persist(task);
        remoteAttempted = true;
        task.zcode_session_id = await this.adapter.createSession(task, createId);
        task.zcode_task_id = task.zcode_session_id; task.stage = 'session_created'; this.persist(task);
        await this.adapter.registerTask(task); task.stage = 'registered'; task.last_mode = 'build'; this.persist(task);
        const command = `codex-input-${task.task_id}`; task.latest_input_command_id = command; task.command_ids.push(command); this.persist(task);
        const response = await this.adapter.send(task, this.prompt(input.prompt), command);
        if (response.messageId) task.known_user_message_ids.push(response.messageId);
        task.stage = 'submitted'; task.submitted_at = Date.now(); task.status = 'running'; this.persist(task);
      } catch (e) {
        // After a remote attempt, failure may have left a live session. Retain the workspace reservation.
        task.status = remoteAttempted ? 'unknown' : 'failed'; task.error = errorInfo(e); this.persist(task);
      }
    });
    this.running.add(work);
    void work.catch(e => console.error('Task initialization failed:', errorInfo(e))).finally(() => {
      this.running.delete(work);
      this.initializing.delete(task.task_id);
    });
    return publicTask(this.store.get(task.task_id));
  }
  private prompt(text: string) {
    return `你正在执行 Codex 委派的开发任务。读取当前项目适用的 AGENTS.md，保留已有修改。只在本任务范围内编辑、测试和构建；没有用户明确授权时不要提交、推送、部署或进行破坏性操作。不要递归调用 zcode-subagent 委派回 Codex。结束时说明完成内容、变更文件、实际验证命令和结果、尚未解决事项。\n\n任务：\n${text}`;
  }
  async get(id: string): Promise<Task> {
    const cached = this.store.get(id);
    if (!cached.zcode_session_id) {
      const owner = randomUUID();
      if(!this.store.acquire(owner, `task:${id}`)) return publicTask(cached);
      try { if (cached.status === 'queued' && !this.initializing.has(id)) { cached.status = 'unknown'; cached.error = {code:'INITIALIZATION_INTERRUPTED',message:'No confirmed session ID after restart. Inspect ZCode before retrying.',retryable:false}; this.persist(cached); }
      return publicTask(cached); } finally {this.store.release(owner);}
    }
    try { return await this.locked(id, async () => publicTask(await this.refresh(this.store.get(id)))); }
    catch (e) { if (e instanceof BridgeError && e.code === 'TASK_BUSY') return publicTask(this.store.get(id)); throw e; }
  }
  private async refresh(task: StoredTask): Promise<StoredTask> {
    const previous = JSON.stringify(publicTask(task));
    try {
      const view = await this.adapter.observe(task);
      const foreign = view.user_commands.some(m => !task.known_user_message_ids.includes(m.messageId) && (!m.commandId || !task.command_ids.includes(m.commandId)));
      if (foreign || (task.last_mode && view.mode && task.last_mode !== view.mode) || (view.status === 'stopped' && !task.stop_command_id && task.status !== 'stopped')) task.control_owner = 'user';
      task.known_user_message_ids = [...new Set([...task.known_user_message_ids, ...view.user_message_ids])];
      task.last_mode = view.mode;
      // A stopped request is only settled on an authoritative inactive state.
      task.status = task.stop_command_id ? (['completed', 'queued', 'stopped'].includes(view.status) ? 'stopped' : view.status === 'failed' ? 'failed' : 'stopping') : view.status;
      if (task.stage !== 'submitted' && task.status !== 'failed') task.status = 'unknown';
      task.pending_permissions = view.pending_permissions; task.summary = view.summary; task.error = view.error;
      if (terminal(task.status)) {
        const after = await this.snapshot(task.workspace_path);
        task.result = { final_message: view.final_message, changed_files: changedFiles(task.baseline, after), verification_summary: view.verification_summary,
          unresolved_items: [...view.unresolved_items, 'File changes are differences observed during delegation; concurrent external edits cannot be attributed automatically.'] };
      } else task.result = undefined;
    } catch (e) { task.status = 'unknown'; task.error = errorInfo(e); }
    if (JSON.stringify(publicTask(task)) !== previous) this.persist(task);
    return task;
  }
  async wait(id: string, after = '', milliseconds = 25000): Promise<Task> {
    const until = Date.now() + Math.min(Math.max(milliseconds, 0), 30000);
    for (;;) {
      const remaining = Math.max(0, until - Date.now());
      let timer: NodeJS.Timeout | undefined;
      const task = await Promise.race([this.get(id), new Promise<Task>(resolve => { timer = setTimeout(() => resolve(publicTask(this.store.get(id))), remaining); })]).finally(() => { if(timer) clearTimeout(timer); });
      if (task.cursor !== after || terminal(task.status) || task.status === 'waiting_for_input' || task.status === 'unknown' || Date.now() >= until) return task;
      await delay(Math.min(1000, Math.max(1, until - Date.now())));
    }
  }
  async send(id: string, text: string, requestId: string, takeControl = false): Promise<Task> {
    return this.locked(id, async () => {
      const previous = this.store.operation(requestId, id, hash({ text, takeControl }));
      if (previous === 'done') return publicTask(this.store.get(id));
      if (previous === 'pending') throw new BridgeError('OUTCOME_UNKNOWN', 'This message was already attempted; inspect the existing session.');
      const task = await this.refresh(this.store.get(id));
      if (task.control_owner === 'user' && !takeControl) throw new BridgeError('USER_CONTROL', 'User has taken control in ZCode. Continue observing; explicit user handback is needed to send instructions.');
      if (task.status === 'unknown' || task.stage !== 'submitted') throw new BridgeError('OUTCOME_UNKNOWN', 'Task outcome is uncertain. Inspect the desktop; do not resubmit automatically.');
      if (!terminal(task.status)) throw new BridgeError('TASK_NOT_IDLE', 'Send a follow-up only after the current turn ends. Resolve pending interactions in ZCode.');
      const commandId = `codex-message-${hash({ id, requestId }).slice(0,32)}`;
      // Reacquire the project reservation before restarting a terminal task.
      task.stop_command_id = undefined; task.status = 'queued'; task.result = undefined; task.error = undefined;
      if (takeControl) task.control_owner = 'codex';
      task.latest_input_command_id = commandId; task.command_ids.push(commandId);
      task.cursor = String(Number(task.cursor)+1); task.updated_at = Date.now();
      this.store.reserveFollowup(task,requestId,hash({text,takeControl}));
      try {
        const result = await this.adapter.send(task, text, commandId);
        if (result.messageId) task.known_user_message_ids.push(result.messageId);
        task.status = 'running'; task.submitted_at = Date.now(); this.persist(task);
        this.store.completeOperation(requestId);
      } catch (e) { task.status = 'unknown'; task.error = errorInfo(e); this.persist(task); }
      return publicTask(task);
    });
  }
  async resolvePermission(id: string, requestId: string, fingerprint: string, allow: boolean): Promise<Task> {
    return this.locked(id, async () => {
      const task = await this.refresh(this.store.get(id));
      if(task.control_owner === 'user') throw new BridgeError('USER_CONTROL', 'Resolve this request in ZCode while the user has control.');
      const pending = task.pending_permissions?.find(p => p.request_id === requestId);
      if(!pending || pending.fingerprint !== fingerprint) throw new BridgeError('STALE_PERMISSION', 'The pending request changed. Read and review the current task.');
      if(!this.adapter.resolvePermission) throw new BridgeError('UNSUPPORTED_OPERATION', 'Adapter cannot resolve permissions.');
      const command = `codex-permission-${hash({id,requestId,fingerprint,allow}).slice(0,32)}`;
      task.command_ids.push(command); this.persist(task);
      await this.adapter.resolvePermission(task,requestId,allow,command);
      return publicTask(await this.refresh(task));
    });
  }
  async stop(id: string): Promise<Task> {
    return this.locked(id, async () => {
      const task = await this.refresh(this.store.get(id));
      if (terminal(task.status) || task.stop_command_id) return publicTask(task);
      if (task.control_owner === 'user') throw new BridgeError('USER_CONTROL', 'User has taken control. Stop this task from ZCode.');
      if (!task.zcode_session_id) throw new BridgeError('SESSION_UNKNOWN', 'No confirmed desktop session ID; inspect the desktop before releasing its workspace.');
      const command = `codex-stop-${task.task_id}-${task.cursor}`;
      task.stop_command_id = command; task.status = 'stopping'; task.command_ids.push(command); this.persist(task);
      try { await this.adapter.stop(task, command); }
      catch (e) { task.status = 'unknown'; task.error = errorInfo(e); this.persist(task); }
      return publicTask(task);
    });
  }
  list(path?: string) { return this.store.list().filter(t => !path || t.workspace_key === workspaceKey(path)).map(publicTask); }
  async drain() { await Promise.allSettled(this.running); }
  async close() { await this.drain(); this.adapter.close(); this.store.close(); }
}
