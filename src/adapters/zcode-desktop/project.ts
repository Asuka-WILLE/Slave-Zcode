import { createHash } from 'node:crypto';
import { BridgeError } from '../../errors.js';
import type { Observation, StoredTask, TaskStatus } from '../../types.js';

// ZCode 3.12.1 legacy readSession projection. Only verified structural fields are consumed.
export function projectSnapshot(raw: any, task: StoredTask): Observation {
  if (!raw?.session || !Array.isArray(raw.messages) || !raw.runtime || raw.session.sessionId !== task.zcode_session_id)
    throw new BridgeError('PROTOCOL_MISMATCH', 'ZCode returned an unexpected session snapshot.');
  const messages = raw.messages;
  const lastUserIndex = messages.findLastIndex((m: any) => m.info?.role === 'user' && !m.info.synthetic);
  const inputVisible = !task.latest_input_command_id || messages.some((m: any) => (m.info?.metadata?.inputIntent?.sourceCommandId || m.info?.metadata?.conversationInputIntent?.sourceCommandId) === task.latest_input_command_id);
  const assistant = inputVisible ? messages.slice(lastUserIndex + 1).filter((m: any) => m.info?.role === 'assistant').at(-1) : undefined;
  const text = (assistant?.parts || []).filter((p: any) => p.type === 'text' && !p.ignored).map((p: any) => p.text).join('\n');
  const failure = assistant?.info?.error?.data?.message || assistant?.info?.error?.message || raw.projection?.lastError?.message;
  const users = messages.filter((m: any) => m.info?.role === 'user' && !m.info.synthetic && !m.info.source && m.info.visibility !== 'model-only' && m.info.semantics?.uiVisibility !== 'hidden');
  let status: TaskStatus = 'unknown';
  const s = raw.session.status;
  if (s === 'running' || raw.runtime.activeTurnId) status = 'running';
  if (s === 'waiting' || raw.runtime.pendingRequestIds?.length || raw.projection?.pendingPermissions?.length) status = 'waiting_for_input';
  if ((s === 'idle' || s === 'completed') && !assistant && task.stage === 'submitted') status = 'queued';
  if (s === 'paused') status = 'stopped';
  if (s === 'error') status = 'failed';
  if ((s === 'completed' || s === 'idle') && !raw.runtime.activeTurnId && task.stage === 'submitted' && assistant?.info?.time?.completed) {
    status = assistant.info.error ? 'failed' : 'completed';
  }
  // Never report an empty, freshly created session as a completed task.
  if (task.stage !== 'submitted' && ['idle', 'completed'].includes(s)) status = 'queued';
  const stopped = assistant?.info?.finish && /cancel|interrupt|abort/i.test(assistant.info.finish);
  if (stopped && !raw.runtime.activeTurnId) status = 'stopped';
  const outputs: string[] = [];
  for (const m of messages) for (const p of m.parts || []) {
    if (p.type !== 'tool' || !/bash|shell|terminal/i.test(p.tool || '')) continue;
    const command = p.state?.input?.command ?? p.state?.input?.cmd ?? '[command unavailable]';
    const output = p.state?.output ?? p.state?.error ?? '';
    outputs.push(`${command}\n${p.state?.status || 'unknown'}: ${String(output).slice(-3000)}`);
  }
  const needsVerification = typeof failure === 'string' && /captcha|verification|sign.?in|login|unauthorized/i.test(failure);
  return {
    pending_permissions: (raw.projection?.pendingPermissions || []).map((p: any) => ({request_id:p.requestId,tool:p.toolName,input:p.input,fingerprint:createHash('sha256').update(JSON.stringify(p.input)).digest('hex')})),
    status,
    summary: failure || text.slice(-2000) || (status === 'running' ? 'ZCode is running; no final response yet.' : `ZCode state: ${s}`),
    final_message: text.slice(-16000),
    verification_summary: outputs.slice(-8).join('\n\n') || 'No shell validation evidence was recorded. A parent review is still required.',
    user_message_ids: users.map((m: any) => m.info.messageId),
    user_commands: users.map((m: any) => ({ messageId: m.info.messageId, commandId: m.info.metadata?.inputIntent?.sourceCommandId || m.info.metadata?.conversationInputIntent?.sourceCommandId })),
    mode: raw.session.mode,
    source_revision: Number(raw.runtime.eventSeq || 0),
    unresolved_items: [
      ...(failure ? [String(failure)] : []),
      ...(status === 'waiting_for_input' ? ['Resolve the pending request in the ZCode desktop.'] : []),
    ],
    error: failure ? { code: needsVerification ? 'ZCODE_AUTH_REQUIRED' : 'ZCODE_EXECUTION_FAILED', message: String(failure), retryable: false } : undefined,
  };
}
