import { CdpClient } from '../dist/src/adapters/zcode-desktop/cdp.js';
import { lookupServices } from '../dist/src/adapters/zcode-desktop/renderer.js';
const cdp = new CdpClient();
try {
  const report = await cdp.evaluate(`(() => { const services = ${lookupServices}; return { connected: true, serviceNames: Object.keys(services).filter(n => /zcode.*Service/.test(n)), reactReady: !!window.__ZCODE_REACT_COMMIT_AT__ }; })()`);
  console.log(JSON.stringify(report, null, 2));
} finally { cdp.close(); }
