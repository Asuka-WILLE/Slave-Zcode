// Runtime lookup through the observed renderer services. No application archive or persistent renderer code is changed.
// React's App component receives the actual service proxies as its `services` prop.
export const lookupServices = `(() => {
  const root = document.getElementById('root');
  const key = root && Object.keys(root).find(k => k.startsWith('__reactContainer$'));
  if (!key) throw new Error('ZCODE_SERVICES_UNAVAILABLE: React root not ready');
  const container = root[key];
  const queue = [container.stateNode?.current || container];
  const seen = new Set();
  while (queue.length && seen.size < 30000) {
    const node = queue.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    const services = node.memoizedProps?.services;
    if (services?.zcodeTaskService && services?.zcodeAgentService && services?.zcodeSessionService) return services;
    queue.push(node.child, node.sibling);
  }
  throw new Error('ZCODE_SERVICES_UNAVAILABLE: desktop services not found');
})()`;

// This is a capability probe, not an application-version check. It reports the
// services and methods used by the adapter without creating a task or session.
export const interfaceHealthExpression = `(() => {
  const required = {
    zcodeTaskService: ['createTask', 'renameTask'],
    zcodeSessionService: ['readSession'],
    modelSelectionService: ['getView'],
    zcodeAgentService: ['helloConversationV4', 'initializeConversationV4', 'sendConversationCommandV4']
  };
  const root = document.getElementById('root');
  const key = root && Object.keys(root).find(k => k.startsWith('__reactContainer$'));
  const container = key ? root[key] : undefined;
  const queue = [container?.stateNode?.current || container];
  const seen = new Set();
  let services;
  while (queue.length && seen.size < 30000) {
    const node = queue.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    const candidate = node.memoizedProps?.services;
    if (candidate && typeof candidate === 'object' && Object.keys(required).some(name => candidate[name])) {
      services = candidate;
      break;
    }
    queue.push(node.child, node.sibling);
  }
  if (!services) return { availableServices: [], missing: ['React services root'] };
  const missing = [];
  for (const [service, methods] of Object.entries(required)) {
    if (!services[service] || typeof services[service] !== 'object') {
      missing.push(service);
      continue;
    }
    for (const method of methods) {
      if (typeof services[service][method] !== 'function') missing.push(service + '.' + method);
    }
  }
  return {
    availableServices: Object.keys(services).filter(name => typeof services[name] === 'object'),
    missing
  };
})()`;

// Reuse the same workspace-opening callback as the desktop UI. Merely creating a
// session in an unopened directory does not make that directory visible in the sidebar.
export function openWorkspaceExpression(path: string): string {
  return `(async () => {
    const root = document.getElementById('root');
    const container = root?.[Object.keys(root).find(k => k.startsWith('__reactContainer$'))];
    const queue = [container?.stateNode?.current || container], seen = new Set(), callbacks = new Set();
    while (queue.length && seen.size < 30000) {
      const node = queue.pop(); if (!node || seen.has(node)) continue; seen.add(node);
      let hook = node.memoizedState;
      for (let i=0; hook && i<1000; i++,hook=hook.next) {
        const value = Array.isArray(hook.memoizedState) ? hook.memoizedState[0] : hook.memoizedState;
        if (typeof value === 'function' && String(value).includes('activateOrSetWorkspace') && String(value).includes('handleSelectProject')) callbacks.add(value);
      }
      queue.push(node.child,node.sibling);
    }
    if (callbacks.size !== 1) throw new Error('ZCODE_WORKSPACE_CALLBACK_UNAVAILABLE');
    await [...callbacks][0](${JSON.stringify(path)});
    return {requested:true};
  })()`;
}

export const serviceAllowlist: Record<string, readonly string[]> = {
  zcodeTaskService: ['createTask', 'listTasks', 'renameTask'],
  zcodeAgentService: ['sendConversationCommandV4', 'queryConversationCommandsV4', 'readSession', 'readSessionEvents', 'readSessionMessages'],
  zcodeSessionService: ['readSession', 'readSessionEvents'],
};
export function serviceExpression(service: string, method: string, input: unknown): string {
  if (!serviceAllowlist[service]?.includes(method)) throw new Error('Unsupported desktop service operation');
  const init = service === 'zcodeAgentService' && ['sendConversationCommandV4', 'queryConversationCommandsV4'].includes(method) ? `
    const clientId = localStorage.getItem('zcode-v4-client-id:v1');
    if (!clientId) throw new Error('ZCODE_CLIENT_NOT_READY: open a workspace in ZCode first');
    const hello = await s.zcodeAgentService.helloConversationV4();
    if (hello.protocolVersion !== undefined && hello.protocolVersion !== 3) throw new Error('ZCODE_PROTOCOL_UNSUPPORTED');
    await s.zcodeAgentService.initializeConversationV4({kind:'clientHello',protocolVersion:3,clientId,clientKind:hello.clientMode === 'desktop-continuous' ? 'desktop' : 'web',appVersion:'unknown',capabilities:{workspaceHookReviewUi:true}});
    if (input.envelope) input.envelope.clientId = clientId;
  ` : '';
  return `(async () => { const s = ${lookupServices}; const input = ${JSON.stringify(input)}; ${init} return await s[${JSON.stringify(service)}][${JSON.stringify(method)}](input); })()`;
}
