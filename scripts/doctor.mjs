import { execFileSync } from 'node:child_process';
import { discoverZCodeInstall, installationError } from './zcode-install.mjs';
const discovery = discoverZCodeInstall();
const install = discovery.path || discovery.explicit || null;
const endpoint = process.env.ZCODE_CDP_URL || 'http://127.0.0.1:19222';
const report = {
  node: process.version,
  install,
  install_source: discovery.candidates.find(candidate => candidate.path === discovery.path)?.source,
  installed: Boolean(discovery.path),
  endpoint,
  desktop_connected: false,
  ...(discovery.path ? {} : { install_error: installationError(discovery), checked_install_paths: discovery.checked }),
};
try {
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Only loopback endpoints are supported');
  const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const targets = await response.json();
  report.targets = targets.map(({ id, type, url }) => ({ id, type, url: url.startsWith('file:') ? url : '[non-file target]' }));
  report.desktop_connected = targets.some(t => t.type === 'page' && t.url.startsWith('file:') && /renderer/.test(t.url));
} catch (e) {
  report.connection_error = e.message;
  report.next_step = 'Close ZCode normally after its active tasks finish, then run scripts/start-zcode.ps1. No process is terminated by this plugin.';
}
if (discovery.path) {
  try {
    report.cli_version = execFileSync(process.execPath, [`${install}/resources/glm/zcode.cjs`, '--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  } catch (e) { report.cli_error = e.message; }
}
console.log(JSON.stringify(report, null, 2));
if (!report.desktop_connected) process.exitCode = 2;
