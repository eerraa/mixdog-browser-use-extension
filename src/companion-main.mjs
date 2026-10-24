import { app } from 'electron';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { CallerAuthority, withoutLease } from './authority.mjs';
import { BrowserHost } from './browser/host.mjs';
import { BrowserPolicy } from './browser/policy.mjs';
import { configureBrowserIdentity } from './browser/user-agent.mjs';
import { RpcPeer } from './rpc.mjs';
import { connectionPaths, pluginData } from './paths.mjs';

const root = path.resolve(path.dirname(process.argv[1]), '..');
const channel = process.env.WB_CHANNEL;
const key = process.env.WB_IPC_KEY;
const paths = connectionPaths(pluginData(), channel);
if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Companion launch credential is missing');
const userData = path.join(paths.directory, 'electron');
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setName('Independent Windows Browser');
configureBrowserIdentity(app);

const authority = new CallerAuthority();
const peers = new Set();
let primary, host, listener, terminating = false;
function sameKey(supplied) {
  return typeof supplied === 'string' && supplied.length === key.length
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(key));
}

function terminate(reason) {
  if (terminating) return;
  terminating = true;
  authority.close(reason);
  try {
    primary?.event('terminating', { reason, channel, scope: 'all pages of this connection' });
  } catch {
    process.stderr.write('Gateway shutdown notification unavailable; continuing companion teardown.\n');
  }
  // Let the revocation response's microtasks queue their bytes before flush.
  setImmediate(async () => {
    try {
      try { await primary?.flush(); }
      catch { process.stderr.write('Gateway flush unavailable; continuing browser cleanup.\n'); }
      await host.close();
    } finally {
      for (const peer of peers) peer.close();
      listener.close();
      app.exit(0);
    }
  });
}

app.whenReady().then(async () => {
  host = new BrowserHost({
    dataDir: paths.directory,
    consentHelperPath: path.join(root, 'bin', 'native-consent.exe'),
    policy: await BrowserPolicy.load(root),
    onRevokeConnection: () => terminate('permission-revocation'),
  });
  listener = net.createServer(socket => {
    let role = null;
    const peer = new RpcPeer(socket, async (method, params, signal) => {
      if (!role) {
        if (method !== 'hello' || params?.channel !== channel || !sameKey(params?.key)
          || !['gateway', 'hook'].includes(params?.role)) throw new Error('Unauthenticated local connection');
        if (params.role === 'gateway' && primary && !primary.closed) throw new Error('Gateway already connected');
        role = params.role;
        if (role === 'gateway') primary = peer;
        return { channel, protocol: 1 };
      }
      if (role === 'gateway' && method === 'shutdown') {
        terminate('gateway-shutdown');
        return { terminating: true };
      }
      if (terminating) throw new Error('Browser connection is terminating; it cannot be automatically resumed');
      if (role === 'gateway' && method === 'status') return host.status();
      if (role === 'gateway' && method === 'call') {
        const args = params?.args;
        if (args?._channel !== channel) throw new Error('Foreign or replaced browser channel');
        const caller = authority.consume(args?._lease, args);
        const { _channel, ...body } = withoutLease(args);
        return host.execute(body, caller, signal);
      }
      if (role === 'hook') {
        if (typeof params?.sessionId !== 'string' || !params.sessionId || params.sessionId.length > 256) {
          throw new Error('Host caller identity is missing');
        }
        if (method === 'begin') {
          authority.begin(params.sessionId, { newTurn: params.event === 'UserPromptSubmit' });
          return { active: true };
        }
        if (method === 'end') {
          // Keep tombstones even when end precedes the first tool request.
          authority.end(params.sessionId, params.event);
          return { ended: true };
        }
        if (method === 'issue') {
          if (params.args?._channel !== channel) throw new Error('Foreign or dead channel');
          return { ticket: authority.issue(params) };
        }
      }
      throw new Error('Unsupported local operation for this connection role');
    });
    peers.add(peer);
    peer.once('closed', () => peers.delete(peer));
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(paths.pipe, resolve);
  });
  process.stdout.write(`WB_READY ${channel}\n`);
}).catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
