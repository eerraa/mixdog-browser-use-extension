import net from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { BROWSER_TOOL, withoutLease } from '../shared/authority.mjs';
import { RpcPeer } from '../shared/rpc.mjs';
import { connectionPaths, pluginData, validChannel } from '../shared/paths.mjs';

const activation = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart']);
const ending = new Set(['Stop', 'StopFailure', 'SessionEnd', 'SubagentStop']);
async function deliver(data, channel, method, params, timeoutMs) {
  const paths = connectionPaths(data, channel);
  const bytes = await readFile(paths.endpoint);
  if (bytes.length > 4096) throw new Error('Invalid plugin endpoint record');
  const record = JSON.parse(bytes);
  if (record.channel !== channel || record.pipe !== paths.pipe || record.protocol !== 1) throw new Error('Replaced plugin endpoint');
  const socket = net.createConnection(paths.pipe);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const peer = new RpcPeer(socket);
  try {
    await peer.request('hello', { channel, key: record.key, role: 'hook' }, { timeoutMs });
    return await peer.request(method, params, { timeoutMs });
  } finally { peer.close(); }
}

async function main() {
  let bytes = 0;
  const input = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('Hook payload exceeds its byte limit');
    input.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(input).toString('utf8'));
  const event = payload.hook_event_name;
  if (event === 'PreToolUse') {
    if (payload.tool_name !== BROWSER_TOOL) return; // Never gate another tool.
    try {
      const args = withoutLease(payload.tool_input);
      if (!validChannel(args._channel)) throw new Error('Current browser channel is required');
      const response = await deliver(pluginData(), args._channel, 'issue', {
        sessionId: payload.session_id, callId: payload.tool_use_id,
        toolName: payload.tool_name, args,
      }, 2000);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, _lease: response.ticket } },
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: `Independent browser admission failed: ${error.message}`,
        },
      }));
    }
    return;
  }
  if (!activation.has(event) && !ending.has(event)) return;
  const data = pluginData();
  let entries;
  try { entries = await readdir(path.join(data, 'connections')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const method = activation.has(event) ? 'begin' : 'end';
  await Promise.all(entries.filter(validChannel).map(async channel => {
    try { await deliver(data, channel, method, { sessionId: payload.session_id, event }, 150); }
    catch (error) {
      // A dead owned connection has no live ticket authority to notify.
      if (!['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) {
        process.stderr.write(`Independent browser ${event} delivery failed: ${error.message}\n`);
      }
    }
  }));
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
