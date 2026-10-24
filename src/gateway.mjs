import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { RpcPeer } from './rpc.mjs';
import { bounded } from './async.mjs';
import { connectionPaths } from './paths.mjs';

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

export async function createGateway(root, data) {
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
    await writeFile(`${paths.endpoint}.tmp`, JSON.stringify({ channel, key, pipe: paths.pipe, protocol: 1 }), { mode: 0o600, flag: 'wx' });
    await rename(`${paths.endpoint}.tmp`, paths.endpoint);
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
      async status() {
        if (terminated || terminationReason) return { channel, state: 'connection-ended', terminationReason, process: terminated };
        return { channel, ...await (await livePeer()).request('status', {}) };
      },
      async execute(args, signal) {
        if (args?._channel !== channel) throw new Error('Missing, foreign or replaced browser channel');
        const current = await livePeer();
        try {
          const result = await current.request('call', { args }, { signal, timeoutMs: 120000 });
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
        // Only the endpoint created by THIS gateway is removed. Profiles stay.
        await unlink(paths.endpoint);
      },
    };
  } catch (error) {
    peer?.close();
    child.kill();
    throw error;
  }
}
