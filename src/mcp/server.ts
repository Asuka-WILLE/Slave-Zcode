import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ZCodeDesktopAdapter } from '../adapters/zcode-desktop/adapter.js';
import { TaskStore } from '../storage/store.js';
import { TaskManager } from '../tasks/manager.js';
import { errorInfo } from '../errors.js';

const id = z.string().trim().min(1).max(200);
const path = z.string().min(1).max(32767);
const message = z.string().trim().min(1).max(100000);
export function createServer(manager: TaskManager) {
  const server = new McpServer({ name: 'zcode-mcp-server', version: '0.1.0' });
  const run = async (action: () => Promise<unknown> | unknown) => {
    try {
      const value = await action(); const output = { result: value };
      return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (e) {
      const output = { error: errorInfo(e) };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
    }
  };
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true };
  server.registerTool('zcode_health', { description: 'Check local ZCode desktop connection and required runtime interface. Never starts a model task.', inputSchema: {}, annotations: read }, () => run(() => manager.adapter.health()));
  server.registerTool('zcode_list_models', { description: 'List configured ZCode provider names and model IDs without credentials. Selection is per task and does not change global defaults.', inputSchema: {}, annotations: read }, () => run(() => manager.adapter.listModels?.()));
  server.registerTool('zcode_start_task', {
    description: 'Delegate an authorized development task to the local ZCode desktop. The task edits the CURRENT project, including existing changes. Pause parent writes to this project. Returns immediately; use wait/get. Reuse request_id only for an identical request.',
    inputSchema: { model_selection: z.object({providerId: id, modelId: id, options: z.object({reasoningLevel: id.optional()}).optional()}).optional(), workspace_path: path.describe('Absolute local project directory.'), title: z.string().trim().min(1).max(200), prompt: message, request_id: id.describe('Stable unique ID for this logical task; never regenerate after a timeout.') }, annotations: write,
  }, input => run(() => manager.start(input)));
  server.registerTool('zcode_get_task', { description: 'Read a plugin task and refresh its desktop state. Detects user takeover; unknown means outcome is not established.', inputSchema: { task_id: id }, annotations: read }, ({ task_id }) => run(() => manager.get(task_id)));
  server.registerTool('zcode_wait_task', { description: 'Wait up to 30 seconds for task changes. A wait timeout never cancels the ZCode task. Pass the cursor from the last result.', inputSchema: { task_id: id, after_cursor: z.string().optional(), wait_ms: z.number().int().min(0).max(30000).default(25000) }, annotations: read }, ({ task_id, after_cursor, wait_ms }) => run(() => manager.wait(task_id, after_cursor, wait_ms)));
  server.registerTool('zcode_send_message', { description: 'Continue an idle, completed, failed, or stopped task. Never retry an uncertain previous send with a new request ID. Set take_control only when the user explicitly hands a manually controlled task back to Codex. Pending permissions must be resolved in ZCode.', inputSchema: { task_id: id, message, request_id: id, take_control: z.boolean().default(false) }, annotations: write }, ({ task_id, message, request_id, take_control }) => run(() => manager.send(task_id, message, request_id, take_control)));
  server.registerTool('zcode_resolve_permission', {description:'Resolve one pending native tool request after reviewing its exact input and existing user authorization. Allow only authorized in-scope actions. Never automatically approve every request or change project/global rules. Pass the fingerprint from get_task. User-owned tasks must be handled in ZCode.', inputSchema:{task_id:id,request_id:id,fingerprint:id,allow:z.boolean()},annotations:{...write,idempotentHint:false}}, ({task_id,request_id,fingerprint,allow})=>run(()=>manager.resolvePermission(task_id,request_id,fingerprint,allow)));
  server.registerTool('zcode_stop_task', { description: 'Request cancellation of a task owned by this plugin. Stopping is not a confirmed stop; read the next state. Does not kill the ZCode application.', inputSchema: { task_id: id }, annotations: write }, ({ task_id }) => run(() => manager.stop(task_id)));
  server.registerTool('zcode_list_tasks', { description: 'List only tasks recorded by this plugin, using cached state. Use get_task to refresh a task.', inputSchema: { workspace_path: path.optional() }, annotations: read }, ({ workspace_path }) => run(() => ({ tasks: manager.list(workspace_path) })));
  return server;
}
export async function main() {
  const data = process.env.ZCODE_SUBAGENT_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'zcode-subagent');
  const store = new TaskStore(join(data, 'tasks.sqlite'));
  const manager = new TaskManager(store, new ZCodeDesktopAdapter());
  const server = createServer(manager);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await manager.close(); await server.close(); };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  process.stdin.once('end', () => void close());
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(errorInfo(e)); process.exitCode = 1; });
}
