import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface InstallCandidate {
  path: string;
  source: string;
}

export interface InstallDiscovery {
  path?: string;
  explicit?: string;
  candidates: InstallCandidate[];
  checked: string[];
}

export interface InstallDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  processPaths?: string[];
  registryPaths?: string[];
  pathPaths?: string[];
  shortcutPaths?: string[];
  readVersion?: (path: string) => string;
  preferredVersion?: string;
}

const executableName = 'ZCode.exe';

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  return trimmed || undefined;
}

function executablePath(value: string): string {
  const match = value.match(/^\s*"([^"]+\.(?:exe|ico))"(?:\s|,|$)/i)
    || value.match(/^\s*(.+?\.(?:exe|ico))(?:\s|,|$)/i);
  return clean(match?.[1] || value) || value;
}

function asInstallDir(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const input = clean(value);
  if (!input) return undefined;
  const path = executablePath(value);
  if (path.toLowerCase().endsWith('.exe') || path.toLowerCase().endsWith('.ico')) return dirname(path);
  if (input.toLowerCase().endsWith('.exe') || input.toLowerCase().endsWith('.ico')) return dirname(input);
  return clean(path);
}

function validInstall(path: string): boolean {
  return existsSync(join(path, executableName)) && existsSync(join(path, 'resources', 'app.asar'));
}

function commandLines(command: string, args: string[], timeout: number): string[] {
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function runningProcessPaths(platform: string): string[] {
  if (platform !== 'win32') return [];
  return commandLines('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '(Get-Process -Name ZCode -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -ExpandProperty Path)',
  ], 1500);
}

function registeredInstallPaths(platform: string): string[] {
  if (platform !== 'win32') return [];
  const script = [
    "$keys = @(",
    "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ')',
    '$items = Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match \'(?i)z[\\s-]?code\' }',
    'foreach ($item in $items) {',
    '  if ($item.InstallLocation) { $item.InstallLocation }',
    '  if ($item.DisplayIcon) { $item.DisplayIcon }',
    '  if ($item.UninstallString) { $item.UninstallString }',
    '}',
  ].join('\n');
  return commandLines('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 2000);
}

function pathExecutablePaths(platform: string): string[] {
  if (platform !== 'win32') return [];
  return commandLines('where.exe', [executableName], 1000);
}

function shortcutTargetPaths(platform: string): string[] {
  if (platform !== 'win32') return [];
  const script = [
    "$roots = @(",
    "  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),",
    "  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'),",
    "  (Join-Path $env:PUBLIC 'Desktop'),",
    "  (Join-Path $env:USERPROFILE 'Desktop')",
    ')',
    "$shell = New-Object -ComObject WScript.Shell",
    "$items = Get-ChildItem -Path $roots -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -match '(?i)z.?code' }",
    'foreach ($item in $items) {',
    '  $shortcut = $shell.CreateShortcut($item.FullName)',
    "  if ($shortcut.TargetPath -match '(?i)\\\\ZCode\\.exe$') { $shortcut.TargetPath }",
    '}',
  ].join('\n');
  return commandLines('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 2500);
}

function standardPaths(env: NodeJS.ProcessEnv): InstallCandidate[] {
  const result: InstallCandidate[] = [];
  const add = (base: string | undefined, suffix: string, source: string) => {
    if (base) result.push({ path: join(base, suffix), source });
  };
  add(env.ProgramW6432, 'ZCode', 'ProgramW6432');
  add(env.ProgramFiles, 'ZCode', 'ProgramFiles');
  add(env['ProgramFiles(x86)'], 'ZCode', 'ProgramFiles(x86)');
  add(env.LOCALAPPDATA, join('Programs', 'ZCode'), 'LocalAppData/Programs');
  add(env.LOCALAPPDATA, 'ZCode', 'LocalAppData');
  add(env.APPDATA, 'ZCode', 'AppData');
  add(env.ProgramData, 'ZCode', 'ProgramData');
  add(env.USERPROFILE, 'ZCode', 'UserProfile');
  return result;
}

export function discoverZCodeInstall(options: InstallDiscoveryOptions = {}): InstallDiscovery {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const explicitRaw = asInstallDir(env.ZCODE_INSTALL_DIR);
  const explicit = explicitRaw ? resolve(explicitRaw) : undefined;
  if (explicit) {
    return {
      path: validInstall(explicit) ? explicit : undefined,
      explicit,
      candidates: [{ path: explicit, source: 'ZCODE_INSTALL_DIR' }],
      checked: [explicit],
    };
  }

  const candidates: InstallCandidate[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, source: string) => {
    const path = asInstallDir(value);
    if (!path) return;
    const normalized = resolve(path);
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: normalized, source });
  };

  for (const path of options.processPaths ?? runningProcessPaths(platform)) add(path, 'running-process');
  for (const path of options.registryPaths ?? registeredInstallPaths(platform)) add(path, 'Windows-registry');
  for (const path of options.pathPaths ?? pathExecutablePaths(platform)) add(path, 'PATH');
  for (const path of options.shortcutPaths ?? shortcutTargetPaths(platform)) add(path, 'Start-menu-shortcut');
  for (const candidate of standardPaths(env)) add(candidate.path, candidate.source);

  const valid = candidates.filter(candidate => validInstall(candidate.path));
  if (!valid.length) return { candidates, checked: candidates.map(candidate => candidate.path) };

  if (options.readVersion && options.preferredVersion) {
    for (const candidate of valid) {
      try {
        if (options.readVersion(candidate.path) === options.preferredVersion) {
          return { path: candidate.path, candidates, checked: candidates.map(item => item.path) };
        }
      } catch {
        // A malformed candidate is left in the diagnostic list, but does not
        // prevent a later valid installation from being selected.
      }
    }
  }
  return { path: valid[0]!.path, candidates, checked: candidates.map(candidate => candidate.path) };
}

export function installationError(discovery: InstallDiscovery): string {
  if (discovery.explicit) {
    return `ZCODE_INSTALL_DIR points to an invalid ZCode installation: ${discovery.explicit}. The directory must contain ZCode.exe and resources\\app.asar.`;
  }
  const checked = discovery.checked.length ? ` Checked: ${discovery.checked.join('; ')}` : '';
  return `Cannot find a ZCode installation automatically. Checked running processes, Windows registry entries, PATH, and common install directories.${checked} Set ZCODE_INSTALL_DIR only for a custom or portable installation.`;
}
