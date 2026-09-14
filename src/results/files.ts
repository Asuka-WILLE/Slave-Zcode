import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BridgeError } from '../errors.js';
const exec = promisify(execFile);
export async function workspacePath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new BridgeError('INVALID_WORKSPACE', 'workspace_path must be absolute.');
  const result = await realpath(path);
  if (!(await lstat(result)).isDirectory()) throw new BridgeError('INVALID_WORKSPACE', 'workspace_path must be a directory.');
  return result;
}
export function workspaceKey(path: string) { return process.platform === 'win32' ? path.toLowerCase() : path; }
async function files(path: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['-C', path, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, windowsHide: true });
    return [...new Set(stdout.split('\0').filter(Boolean))];
  } catch {
    const result: string[] = [];
    const skip = new Set(['.git', 'node_modules', 'dist', '.runtime', '.mimosa', '.venv', '__pycache__']);
    async function visit(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await visit(full); else result.push(relative(path, full));
        if (result.length > 20000) throw new BridgeError('BASELINE_TOO_LARGE', 'More than 20,000 files. Use a Git workspace or narrower project directory.');
      }
    }
    await visit(path); return result;
  }
}
export async function snapshotFiles(path: string): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  const names = await files(path);
  if (names.length > 20000) throw new BridgeError('BASELINE_TOO_LARGE', 'More than 20,000 project files.');
  for (const name of names) {
    const full = resolve(path, name);
    if (!full.startsWith(path + sep)) throw new BridgeError('INVALID_FILE_PATH', 'File escaped workspace.');
    try {
      const stat = await lstat(full);
      if (stat.isDirectory()) continue;
      // Do not follow symlinks or read unbounded binary artifacts.
      if (stat.size > 32 * 1024 * 1024) { result[name] = `large:${stat.size}:${stat.mtimeMs}`; continue; }
      result[name] = createHash('sha256').update(stat.isSymbolicLink() ? `link:${await readlink(full)}` : await readFile(full)).digest('hex');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') result[name] = null; else throw e;
    }
  }
  return result;
}
export function changedFiles(before: Record<string, string | null>, after: Record<string, string | null>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(n => (before[n] ?? null) !== (after[n] ?? null)).sort();
}
