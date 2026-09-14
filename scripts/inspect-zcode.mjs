import { openAsar } from './asar.mjs';
const root = process.env.ZCODE_INSTALL_DIR || 'C:/Program Files/ZCode';
const archive = openAsar(`${root}/resources/app.asar`);
try {
  const report = { package: JSON.parse(archive.read('package.json')).version, findings: [] };
  for (const folder of ['out/renderer/assets', 'out/host', 'out/preload']) {
    for (const file of archive.list(folder).filter(f => f.endsWith('.js') || f.endsWith('.cjs'))) {
      const source = archive.read(`${folder}/${file}`);
      for (const term of process.argv.slice(2).length ? process.argv.slice(2) : ['createSession', 'sendText', 'ServicePort']) {
        let from = 0;
        for (let n = 0; n < 2; n++) {
          const offset = source.indexOf(term, from);
          if (offset < 0) break;
          report.findings.push({ file: `${folder}/${file}`, term, offset, excerpt: source.slice(Math.max(0, offset - 160), offset + 500) });
          from = offset + term.length;
        }
      }
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally { archive.close(); }
