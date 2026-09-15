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
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
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
if (!/^1\.0\.\d+$/.test(manifest.version)) throw new Error('Release version must use the v1.0.X line.');
if (manifest.skills !== './skills/' || manifest.mcpServers !== './.mcp.json') throw new Error('Manifest component paths are invalid.');

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
if (packageJson.version !== manifest.version || packageLock.version !== manifest.version || packageLock.packages?.['']?.version !== manifest.version)
  throw new Error('Package, lockfile and plugin manifest versions must match.');
const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
const escapedVersion = manifest.version.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
if (!new RegExp(`^## v${escapedVersion}(?:\\s|$)`, 'm').test(changelog)) throw new Error('CHANGELOG.md must contain the current v1.0.X release heading.');

const mcp = JSON.parse(await readFile(resolve(root, '.mcp.json'), 'utf8'));
const server = mcp.mcpServers?.zcode;
if (!server || server.command !== 'node' || JSON.stringify(server.args) !== JSON.stringify(['bundle/server.mjs'])) throw new Error('MCP declaration is invalid.');
if (server.cwd !== '.') throw new Error('MCP cwd must keep execution relative to the plugin root.');

const marketplace = JSON.parse(await readFile(resolve(root, '.agents/plugins/marketplace.json'), 'utf8'));
const entry = marketplace.plugins?.find((item) => item.name === manifest.name);
if (marketplace.name !== 'slave-zcode' || entry?.source?.path !== './') throw new Error('Repository marketplace entry is invalid.');

const bundlePath = resolve(root, 'bundle/server.mjs');
const bundle = await stat(bundlePath);
if (bundle.size < 10000) throw new Error('Bundled MCP server is unexpectedly small. Run npm run bundle.');
const bundleText = await readFile(bundlePath, 'utf8');
if (!bundleText.includes(`name: "zcode-mcp-server", version: "${manifest.version}"`)) throw new Error('MCP bundle version does not match the plugin manifest. Run npm run bundle.');
console.log(JSON.stringify({ valid: true, root, version: manifest.version, bundle_bytes: bundle.size }));
