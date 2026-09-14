import {build} from 'esbuild';
await build({entryPoints:['src/mcp/server.ts'],bundle:true,platform:'node',target:'node24',format:'esm',outfile:'bundle/server.mjs',banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"}});
