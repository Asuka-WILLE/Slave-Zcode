import { BridgeError } from '../../errors.js';

export function localEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new BridgeError('INVALID_ENDPOINT', 'ZCODE_CDP_URL must be a loopback HTTP origin.');
  }
  return url;
}
export interface Target { id: string; type: string; url: string; webSocketDebuggerUrl: string }
export class CdpClient {
  private socket?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private connecting?: Promise<void>;
  constructor(readonly endpoint = process.env.ZCODE_CDP_URL || 'http://127.0.0.1:19222', readonly targetId = process.env.ZCODE_TARGET_ID) {
    localEndpoint(endpoint);
  }
  async targets(): Promise<Target[]> {
    try {
      const response = await fetch(new URL('/json/list', this.endpoint), { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      if (!Array.isArray(targets)) throw new Error('Invalid target list');
      return targets.filter(t => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('file:') && /\/out\/renderer\/index\.html/.test(t.url) && !t.url.includes('windowKind=update-status'));
    } catch (e) { throw new BridgeError('DESKTOP_UNAVAILABLE', `Cannot connect to ZCode desktop. Close it normally and use scripts/start-zcode.ps1. ${e instanceof Error ? e.message : e}`, true); }
  }
  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private async open() {
    const targets = await this.targets();
    const target = this.targetId ? targets.find(t => t.id === this.targetId) : targets.length === 1 ? targets[0] : undefined;
    if (!target) throw new BridgeError('DESKTOP_TARGET_REQUIRED', `Found ${targets.length} ZCode windows. Set ZCODE_TARGET_ID to the intended window ID.`);
    const address = new URL(target.webSocketDebuggerUrl);
    if (address.protocol !== 'ws:' || address.hostname !== new URL(this.endpoint).hostname || address.port !== new URL(this.endpoint).port)
      throw new BridgeError('INVALID_ENDPOINT', 'Unexpected CDP WebSocket address.');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(address); this.socket = ws;
      const timer = setTimeout(() => { ws.close(); reject(new BridgeError('CDP_TIMEOUT', 'Desktop connection timed out.', true)); }, 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new BridgeError('CDP_ERROR', 'Desktop WebSocket failed.', true)); }, { once: true });
      ws.addEventListener('message', event => {
        let response: any;
        try { response = JSON.parse(String(event.data)); } catch { return; }
        const item = this.pending.get(response.id);
        if (!item) return;
        clearTimeout(item.timer); this.pending.delete(response.id);
        response.error ? item.reject(new BridgeError('CDP_ERROR', response.error.message)) : item.resolve(response.result);
      });
      ws.addEventListener('close', () => {
        if (this.socket === ws) this.socket = undefined;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BridgeError('DESKTOP_DISCONNECTED', 'Desktop disconnected; operation outcome may be unknown. Do not resubmit automatically.', true)); }
        this.pending.clear();
      });
    });
  }
  async call(method: string, params: Record<string, unknown> = {}, timeout = 30000): Promise<any> {
    await this.connect();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError('CDP_TIMEOUT', `${method} timed out; its execution may continue.`, true)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async evaluate<T>(expression: string, timeout = 30000): Promise<T> {
    const response = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (response.exceptionDetails) throw new BridgeError('DESKTOP_CALL_FAILED', response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value as T;
  }
  close() { this.socket?.close(); }
}
