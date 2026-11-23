import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGateway } from './gateway.mjs';
import { authorityMode, automationMode, engineMode, pluginData } from '../shared/paths.mjs';
import { CONNECTION_INSTRUCTIONS, browserTool, errorResult, toolResult } from './tool.mjs';

// The package version: the MCP handshake and `status` report it, so a host that
// still runs an earlier install is visible to the agent and the person.
const VERSION = '0.6.3';

async function main() {
  const root = path.resolve(path.dirname(process.argv[1]), '..');
  const authority = authorityMode();
  // Validate optional WB_AUTOMATION_MODE and WB_ENGINE fail-closed before spawning companion.
  automationMode();
  engineMode();
  const gateway = await createGateway(root, pluginData(), { authority });
  // A plain MCP registration loads no skill; the server instructions carry
  // its guidance instead. Under host hooks the shipped skill does.
  const server = new Server({ name: 'win-browser', version: VERSION }, {
    capabilities: { tools: {} },
    ...(authority === 'connection' ? { instructions: CONNECTION_INSTRUCTIONS } : {}),
  });
  const hooked = authority === 'hook';
  const descriptor = browserTool(hooked ? gateway.channel : null);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [descriptor] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (request.params.name !== 'browse') throw new Error('Unknown plugin tool');
      const args = request.params.arguments;
      // Host hooks address this connection by _channel. Under connection authority
      // the stdio connection is the caller and the argument is not part of a call.
      if (hooked && args?._channel !== gateway.channel) throw new Error('Missing, foreign or replaced browser channel');
      if (!args || typeof args !== 'object') throw new Error('Browse arguments must be an object');
      const result = args.action === 'status' ? { version: VERSION, ...await gateway.status() } : await gateway.execute(args, extra.signal);
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
