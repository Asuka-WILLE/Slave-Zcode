import { openSync, readSync, closeSync } from 'node:fs';
export function openAsar(path) {
  const fd = openSync(path, 'r');
  const prefix = Buffer.alloc(16);
  readSync(fd, prefix, 0, 16, 0);
  const length = prefix.readUInt32LE(12);
  if (length > 64 * 1024 * 1024) { closeSync(fd); throw new Error('Unexpected ASAR header'); }
  const buffer = Buffer.alloc(length);
  readSync(fd, buffer, 0, length, 16);
  const header = JSON.parse(buffer.toString());
  const base = 8 + prefix.readUInt32LE(4);
  function entry(path) { return path.split('/').reduce((v, p) => v.files[p], header); }
  return {
    list(path) { return Object.keys(entry(path).files); },
    read(path) {
      const value = entry(path);
      if (value.unpacked || value.link || value.files) throw new Error(`Not a packed file: ${path}`);
      const data = Buffer.alloc(value.size);
      readSync(fd, data, 0, data.length, base + Number(value.offset));
      return data.toString();
    },
    close() { closeSync(fd); }
  };
}
