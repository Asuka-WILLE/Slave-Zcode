import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const transport=new StdioClientTransport({command:process.execPath,args:[resolve(process.argv[2]||'bundle/server.mjs')],stderr:'pipe',env:{...process.env,ZCODE_SUBAGENT_DATA_DIR:resolve('.runtime/mcp-acceptance')}});
const c=new Client({name:'zcode-acceptance',version:'1.0'});
try{
 await c.connect(transport);
 const list=await c.listTools();assert.equal(list.tools.length,9);
 const result=await c.callTool({name:'zcode_health',arguments:{}});assert.equal(result.isError,undefined);
 const models=await c.callTool({name:'zcode_list_models',arguments:{}});assert.equal(models.isError,undefined);
 console.log(JSON.stringify({tools:list.tools.map(t=>t.name),health:result.structuredContent,models:models.structuredContent},null,2));
 const invalid=await c.callTool({name:'zcode_get_task',arguments:{task_id:'nonexistent-acceptance'}});assert.equal(invalid.isError,true);
}finally{await c.close()}
