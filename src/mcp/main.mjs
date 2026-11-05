import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGateway } from './gateway.mjs';
import { authorityMode, pluginData } from '../shared/paths.mjs';
import { CONNECTION_INSTRUCTIONS, browserTool, errorResult, toolResult } from './tool.mjs';

async function main() {
  const root = path.resolve(path.dirname(process.argv[1]), '..');
  const authority = authorityMode();
  const gateway = await createGateway(root, pluginData(), { authority });
  // A plain MCP registration loads no skill; the server instructions carry
  // its guidance instead. Under host hooks the shipped skill does.
  const server = new Server({ name: 'win-browser', version: '0.4.0' }, {
    capabilities: { tools: {} },
    ...(authority === 'connection' ? { instructions: CONNECTION_INSTRUCTIONS } : {}),
  });
  const descriptor = browserTool(gateway.channel, { lease: authority === 'hook' });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [descriptor] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (request.params.name !== 'browse') throw new Error('Unknown plugin tool');
      const args = request.params.arguments;
      if (args?._channel !== gateway.channel) throw new Error('Missing, foreign or replaced browser channel');
      const result = args.action === 'status' ? await gateway.status() : await gateway.execute(args, extra.signal);
      return toolResult(result, args.action);
    } catch (error) {
      const args = request.params.arguments;
      return errorResult(error, args && typeof args === 'object' ? args : {});
    }
  });
  server.onclose = () => { gateway.close().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); };
  // The SDK's stdio transport does not translate stdin EOF into onclose.
  // Use its public shutdown path once, including when both events arrive.
  let shutdown;
  const close = () => {
    shutdown ??= server.close().catch(error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  };
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  await server.connect(new StdioServerTransport());
}
main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
