// Shared companion named-pipe RPC server, gateway PSK authentication, and
// teardown lifecycle for both the pure-Node Camoufox companion and the Electron
// fallback companion. Keeps security-critical auth/teardown logic in one place.
import net from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BrowserPolicy } from '../shared/policy.mjs';
import { loadUserPreferences } from '../shared/preferences.mjs';
import { RpcPeer } from '../shared/rpc.mjs';

// Under MCP stdio connection authority the gateway connection is the sole caller.
export const CONNECTION_CALLER = 'mcp-connection';

export function normalizePrefsSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const ok = snapshot.ok === true;
  const found = snapshot.found === true;
  const mode = snapshot.automationMode === 'standard' || snapshot.automationMode === 'elevated'
    ? snapshot.automationMode
    : null;
  const reason = typeof snapshot.reason === 'string' ? snapshot.reason : null;
  return { ok, found, automationMode: ok ? mode : null, reason };
}

export function createCompanionServer({ root, channel, key, pipe, dataRoot, lazyInit = false, buildHost, onExit }) {
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Companion launch credential is missing');

  const connectionController = new AbortController();
  const peers = new Set();
  let primary = null;
  let host = null;
  let listener = null;
  let terminating = false;

  const sameKey = supplied => typeof supplied === 'string' && supplied.length === key.length
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(key));

  const loadConfig = () => Promise.all([BrowserPolicy.load(root), loadUserPreferences(dataRoot)]);

  function terminate(reason) {
    if (terminating) return;
    terminating = true;
    connectionController.abort(new Error(`Browser connection ended: ${reason}`));
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
        await host?.close();
      } finally {
        for (const peer of peers) peer.close();
        listener?.close();
        onExit(0);
      }
    });
  }

  async function start() {
    if (!lazyInit) {
      const [policy, prefs] = await loadConfig();
      host = buildHost({ policy, prefs });
    }

    listener = net.createServer(socket => {
      let role = null;
      const peer = new RpcPeer(socket, async (method, params, signal) => {
        if (!role) {
          if (method !== 'hello' || params?.channel !== channel || !sameKey(params?.key)
            || params?.role !== 'gateway') throw new Error('Unauthenticated local connection');
          if (primary && !primary.closed) throw new Error('Gateway already connected');
          if (!host) {
            const snap = params?.snapshot;
            if (snap && typeof snap === 'object') {
              const policy = BrowserPolicy.fromSnapshot(snap.policy);
              const prefs = normalizePrefsSnapshot(snap.prefs) ?? await loadUserPreferences(dataRoot);
              host = buildHost({ policy, prefs, connectionId: snap.connectionId });
            } else {
              const [policy, prefs] = await loadConfig();
              host = buildHost({ policy, prefs });
            }
          }
          role = 'gateway';
          primary = peer;
          return { channel, protocol: 1 };
        }
        if (method === 'shutdown') {
          terminate('gateway-shutdown');
          return { terminating: true };
        }
        if (terminating) throw new Error('Browser connection is terminating; it cannot be automatically resumed');
        if (!host) throw new Error('Browser companion host is not initialized');
        if (method === 'status') return host.status();
        if (method === 'call') {
          const args = params?.args;
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Browser arguments must be an object');
          if (args._channel !== channel) throw new Error('Foreign or replaced browser channel');
          const { _channel, _lease, ...body } = args;
          const caller = {
            sessionId: CONNECTION_CALLER,
            callId: randomUUID(),
            signal: connectionController.signal,
            assertLive() {
              if (terminating) throw new Error('Browser connection is terminating');
              connectionController.signal.throwIfAborted();
            },
          };
          return host.execute(body, caller, signal);
        }
        throw new Error('Unsupported local operation for this connection role');
      });
      peers.add(peer);
      peer.once('closed', () => peers.delete(peer));
    });

    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(pipe, resolve);
    });
    process.stdout.write(`WB_READY ${channel}\n`);
  }

  return { start, terminate };
}
