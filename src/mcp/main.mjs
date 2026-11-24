import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGateway } from './gateway.mjs';
import { fail, validateArgs } from '../shared/contract.mjs';
import { authorityMode, automationMode, engineMode, pluginData } from '../shared/paths.mjs';
import { browserTool, connectionInstructions, errorResult, toolResult } from './tool.mjs';

// The package version: the MCP handshake and `status` report it, so a host that
// still runs an earlier install is visible to the agent and the person.
const VERSION = '0.7.0';

async function main() {
  const root = path.resolve(path.dirname(process.argv[1]), '..');
  // Validate optional WB_AUTHORITY, WB_AUTOMATION_MODE and WB_ENGINE fail-closed before spawning companion.
  authorityMode();
  automationMode();
  engineMode();
  const gateway = await createGateway(root, pluginData());
  const server = new Server({ name: 'win-browser', version: VERSION }, {
    capabilities: { tools: {} },
    instructions: connectionInstructions(gateway.engine),
  });
  const descriptor = browserTool({ engine: gateway.engine });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [descriptor] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (request.params.name !== 'browse') throw new Error('Unknown browser tool');
      const args = request.params.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Browse arguments must be an object');
      // Enforce explicit _lease refusal BEFORE any metadata shortcut (including `status`).
      if (Object.hasOwn(args, '_lease')) {
        fail('INVALID_ARGUMENT', 'This server does not accept _lease; send the call without _lease',
          { requestedInputDispatched: false });
      }
      if (args.action === 'status') {
        const { _channel: _c, ...cleaned } = args;
        try { validateArgs(cleaned); }
        catch (error) { throw Object.assign(error, { requestedInputDispatched: false }); }
        return toolResult({ version: VERSION, ...await gateway.status() }, 'status');
      }
      const result = await gateway.execute(args, extra.signal);
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
