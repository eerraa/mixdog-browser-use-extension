import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { RpcPeer } from '../shared/rpc.mjs';
import { bounded } from '../shared/async.mjs';
import { BROWSER_TOOL } from '../shared/authority.mjs';
import { fail } from '../shared/contract.mjs';
import { connectionPaths } from '../shared/paths.mjs';

// Under connection authority the MCP connection is the only caller.
export const CONNECTION_CALLER = 'mcp-connection';

async function connect(pipe, hello) {
  const socket = net.createConnection(pipe);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const peer = new RpcPeer(socket);
  try { await peer.request('hello', hello, { timeoutMs: 2000 }); return peer; }
  catch (error) { peer.close(); throw error; }
}

export async function createGateway(root, data, { authority = 'hook' } = {}) {
  if (authority !== 'hook' && authority !== 'connection') throw new Error('Unknown caller authority');
  const channel = randomUUID();
  const paths = connectionPaths(data, channel);
  await mkdir(path.dirname(paths.directory), { recursive: true });
  await mkdir(paths.directory); // Fresh allocation; never reuse a previous connection.
  const key = randomBytes(32).toString('base64url');
  const child = spawn(path.join(root, 'bin', 'bridge.exe'), ['--browser'], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WB_CHANNEL: channel, WB_IPC_KEY: key },
  });
  let terminated = null, closing = false, startup = '', errors = '', peer, terminationReason;
  const exit = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      terminated = { code, signal };
      resolve(terminated);
    });
  });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`Browser companion startup exited (${code ?? signal})${errors ? `\n${errors}` : ''}`));
    });
    child.stderr.on('data', bytes => {
      if (!peer) errors = (errors + bytes.toString('utf8')).slice(-16384);
    });
    child.stdout.on('data', bytes => {
      startup += bytes.toString('utf8');
      if (startup.includes(`WB_READY ${channel}\n`)) resolve();
      if (startup.length > 65536) { child.kill(); reject(new Error('Invalid companion startup output')); }
    });
  });
  try {
    await bounded(ready, 20000, 'Browser companion startup', undefined, () => child.kill());
    const hello = { channel, key, role: 'gateway' };
    peer = await connect(paths.pipe, hello);
    const watch = current => current.on('event', (event, params) => {
      if (event === 'terminating') terminationReason = params?.reason;
    });
    watch(peer);
    // Host hooks find the pipe and key through endpoint.json. Connection
    // authority has no hooks, so its key never touches the disk.
    if (authority === 'hook') {
      await writeFile(`${paths.endpoint}.tmp`, JSON.stringify({ channel, key, pipe: paths.pipe, protocol: 1 }), { mode: 0o600, flag: 'wx' });
      await rename(`${paths.endpoint}.tmp`, paths.endpoint);
    }
    // Connection authority: this process issues each call's single-use ticket
    // over its own hook-role connection, so the companion admits every call
    // through CallerAuthority.consume exactly as under host hooks.
    const issuerHello = { channel, key, role: 'hook' };
    let issuer = authority === 'connection' ? connect(paths.pipe, issuerHello) : null;
    if (issuer) await issuer;
    const ticket = args => {
      // Chained so concurrent calls share one reconnect after a lost transport.
      issuer = issuer.catch(() => null).then(current => (current && !current.closed ? current : connect(paths.pipe, issuerHello)));
      return issuer.then(current => current.request('issue', {
        sessionId: CONNECTION_CALLER, callId: randomUUID(), toolName: BROWSER_TOOL, args,
      }, { timeoutMs: 2000 })).then(response => response.ticket);
    };
    const livePeer = async () => {
      if (terminated || closing || terminationReason) throw new Error('Browser connection ended; reconnect the plugin explicitly');
      if (peer.closed) {
        // Reconnect the transport for NEW calls only; never replay the lost call.
        peer = await connect(paths.pipe, hello);
        watch(peer);
      }
      return peer;
    };
    return {
      channel,
      authority,
      async status() {
        if (terminated || terminationReason) return { channel, state: 'connection-ended', terminationReason, process: terminated };
        return { channel, ...await (await livePeer()).request('status', {}) };
      },
      async execute(args, signal) {
        if (authority === 'hook' && args?._channel !== channel) throw new Error('Missing, foreign or replaced browser channel');
        if (authority === 'connection' && Object.hasOwn(args, '_lease')) {
          fail('INVALID_ARGUMENT', 'This server issues its own caller tickets; send the call without _lease',
            { requestedInputDispatched: false });
        }
        const current = await livePeer();
        let call = args;
        if (authority === 'connection') {
          // This process owns exactly one companion, so it addresses the call itself.
          // A host that kept an earlier process's schema still sends that _channel.
          const own = { ...args, _channel: channel };
          try { call = { ...own, _lease: await ticket(own) }; }
          catch (error) {
            // No call was sent: the companion admits nothing without a ticket.
            throw Object.assign(error, { code: error.code ?? 'UNAUTHENTICATED_CALLER', requestedInputDispatched: false });
          }
        }
        try {
          const result = await current.request('call', { args: call }, { signal, timeoutMs: 120000 });
          if (args.action === 'revoke' && result?.closesConnection) {
            const process = await bounded(exit, 8000, 'Companion teardown');
            return {
              disposition: 'connection-terminated', processTeardownConfirmed: process.code === 0,
              scope: 'all pages of this connection', physicalDeviceIo: 'NOT_MEASURED',
              reason: 'The owned companion job ended; live device handle/reconnect checks remain separate.',
            };
          }
          return result;
        } catch (error) {
          // Transport failure is NOT evidence that an input did not run.
          throw Object.assign(error, { replaySafe: false });
        }
      },
      async close() {
        if (closing) return;
        closing = true;
        if (!terminated) {
          try { await peer.request('shutdown', {}, { timeoutMs: 2000 }); }
          catch { if (!terminated) child.kill(); }
          try { await bounded(exit, 8000, 'Owned companion shutdown', undefined, () => child.kill()); }
          catch { child.kill(); }
        }
        peer.close();
        if (issuer) (await issuer.catch(() => null))?.close();
        // Only the endpoint created by THIS gateway is removed. Profiles stay.
        if (authority === 'hook') await unlink(paths.endpoint);
      },
    };
  } catch (error) {
    peer?.close();
    child.kill();
    throw error;
  }
}
