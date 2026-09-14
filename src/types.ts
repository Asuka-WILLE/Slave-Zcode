export type TaskStatus = 'queued' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'stopping' | 'stopped' | 'unknown';
export interface ModelSelection { providerId: string; modelId: string; options?: { reasoningLevel?: string } }
export interface PendingPermission { request_id: string; tool: string; input: unknown; fingerprint: string }
export interface Task {
  pending_permissions?: PendingPermission[];
  model_selection?: ModelSelection;
  task_id: string;
  workspace_path: string;
  title: string;
  status: TaskStatus;
  control_owner: 'codex' | 'user';
  cursor: string;
  created_at: number;
  updated_at: number;
  zcode_task_id?: string;
  zcode_session_id?: string;
  summary?: string;
  result?: { final_message: string; changed_files: string[]; verification_summary: string; unresolved_items: string[] };
  error?: { code: string; message: string; retryable: boolean };
}
export interface StartInput { workspace_path: string; title: string; prompt: string; request_id: string; model_selection?: ModelSelection }
export interface StoredTask extends Task {
  workspace_key: string;
  request_id: string;
  fingerprint: string;
  prompt: string;
  stage: 'reserved' | 'session_created' | 'registered' | 'submitted';
  baseline: Record<string, string | null>;
  known_user_message_ids: string[];
  command_ids: string[];
  last_mode?: string;
  submitted_at?: number;
  stop_command_id?: string;
  latest_input_command_id?: string;
}
export interface Observation {
  pending_permissions?: PendingPermission[];
  status: TaskStatus;
  summary: string;
  final_message: string;
  verification_summary: string;
  user_message_ids: string[];
  user_commands: { messageId: string; commandId?: string }[];
  mode?: string;
  error?: Task['error'];
  source_revision: number;
  unresolved_items: string[];
}
export interface DesktopAdapter {
  health(): Promise<Record<string, unknown>>;
  listModels?(): Promise<any>;
  createSession(task: StoredTask, commandId: string): Promise<string>;
  registerTask(task: StoredTask): Promise<void>;
  send(task: StoredTask, text: string, commandId: string): Promise<{ messageId?: string }>;
  observe(task: StoredTask): Promise<Observation>;
  stop(task: StoredTask, commandId: string): Promise<void>;
  resolvePermission?(task: StoredTask, requestId: string, allow: boolean, commandId: string): Promise<void>;
  close(): void;
}
export const terminal = (status: TaskStatus) => ['completed', 'failed', 'stopped'].includes(status);
export function publicTask(task: StoredTask): Task {
  const { workspace_key, request_id, fingerprint, prompt, stage, baseline, known_user_message_ids, command_ids, last_mode, submitted_at, stop_command_id, latest_input_command_id, ...result } = task;
  return result;
}
