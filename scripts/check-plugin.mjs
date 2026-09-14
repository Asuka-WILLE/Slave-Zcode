import { access, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(process.argv[2] || '.');
const required = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'skills/zcode-delegation/SKILL.md',
  'bundle/server.mjs',
  'scripts/doctor.mjs',
  'scripts/start-zcode.ps1',
  'scripts/asar.mjs',
  'scripts/zcode-install.mjs',
  'README.md',
  '.agents/plugins/marketplace.json',
];

for (const relative of required) {
  const target = resolve(root, relative);
  if (!target.startsWith(root)) throw new Error(`Path escaped plugin root: ${relative}`);
  await access(target);
}

const manifest = JSON.parse(await readFile(resolve(root, '.codex-plugin/plugin.json'), 'utf8'));
if (manifest.name !== 'zcode-subagent') throw new Error('Manifest name must be zcode-subagent.');
if (!manifest.version || manifest.version.includes('+codex.')) throw new Error('Release manifest must use a clean version.');
if (manifest.skills !== './skills/' || manifest.mcpServers !== './.mcp.json') throw new Error('Manifest component paths are invalid.');

const mcp = JSON.parse(await readFile(resolve(root, '.mcp.json'), 'utf8'));
const server = mcp.mcpServers?.zcode;
if (!server || server.command !== 'node' || JSON.stringify(server.args) !== JSON.stringify(['bundle/server.mjs'])) throw new Error('MCP declaration is invalid.');
if (server.cwd !== '.') throw new Error('MCP cwd must keep execution relative to the plugin root.');

const marketplace = JSON.parse(await readFile(resolve(root, '.agents/plugins/marketplace.json'), 'utf8'));
const entry = marketplace.plugins?.find((item) => item.name === manifest.name);
if (marketplace.name !== 'slave-zcode' || entry?.source?.path !== './') throw new Error('Repository marketplace entry is invalid.');

const bundle = await stat(resolve(root, 'bundle/server.mjs'));
if (bundle.size < 10000) throw new Error('Bundled MCP server is unexpectedly small. Run npm run bundle.');
console.log(JSON.stringify({ valid: true, root, version: manifest.version, bundle_bytes: bundle.size }));
