// Shared companion named-pipe RPC server, caller-authority authentication, and
// teardown lifecycle for both the pure-Node Camoufox companion and the Electron
// fallback companion. Keeps security-critical auth/ticket logic in one place.
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { CallerAuthority, withoutLease } from '../shared/authority.mjs';
import { BrowserPolicy } from '../shared/policy.mjs';
import { loadUserPreferences } from '../shared/preferences.mjs';
import { RpcPeer } from '../shared/rpc.mjs';

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

  const authority = new CallerAuthority();
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
            || !['gateway', 'hook'].includes(params?.role)) throw new Error('Unauthenticated local connection');
          if (params.role === 'gateway' && primary && !primary.closed) throw new Error('Gateway already connected');
          if (params.role === 'gateway' && !host) {
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
          role = params.role;
          if (role === 'gateway') primary = peer;
          return { channel, protocol: 1 };
        }
        if (role === 'gateway' && method === 'shutdown') {
          terminate('gateway-shutdown');
          return { terminating: true };
        }
        if (terminating) throw new Error('Browser connection is terminating; it cannot be automatically resumed');
        if (!host) throw new Error('Browser companion host is not initialized');
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
            host.endSession(params.sessionId);
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
      listener.listen(pipe, resolve);
    });
    process.stdout.write(`WB_READY ${channel}\n`);
  }

  return { start, terminate };
}
