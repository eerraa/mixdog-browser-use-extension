import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGateway } from './gateway.mjs';
import { pluginData } from './paths.mjs';
import { browserTool, toolResult } from './tool-schema.mjs';

async function main() {
  const root = path.resolve(path.dirname(process.argv[1]), '..');
  const gateway = await createGateway(root, pluginData());
  const server = new Server({ name: 'win-browser', version: '0.2.0' }, { capabilities: { tools: {} } });
  const descriptor = browserTool(gateway.channel);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [descriptor] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (request.params.name !== 'browse') throw new Error('Unknown plugin tool');
      const args = request.params.arguments;
      if (args?._channel !== gateway.channel) throw new Error('Missing, foreign or replaced browser channel');
      const result = args.action === 'status' ? await gateway.status() : await gateway.execute(args, extra.signal);
      return toolResult(result);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({
          disposition: error.requestedInputDispatched === false ? 'not-executed' : 'failed-or-unknown',
          code: error.code ?? 'BROWSER_ERROR',
          reason: error.message, replaySafe: false,
          ...(error.requestedInputDispatched === false ? {
            tabId: error.tabId, preparation: error.preparation, requestedInputDispatched: false,
          } : {}),
          ...(error.snapshotId ? { snapshotId: error.snapshotId } : {}),
          ...(error.candidates ? { candidates: error.candidates } : {}),
        }) }],
      };
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
