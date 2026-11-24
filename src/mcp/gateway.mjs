import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { RpcPeer } from '../shared/rpc.mjs';
import { bounded } from '../shared/async.mjs';
import { BROWSER_TOOL } from '../shared/authority.mjs';
import { fail, validateArgs } from '../shared/contract.mjs';
import { automationMode, camoufoxExecutable, connectionPaths, engineMode, persistentProfilesEnabled } from '../shared/paths.mjs';
import { BrowserPolicy, ELECTRON_LIST_PROFILES, camoufoxCapabilities, electronCapabilities } from '../shared/policy.mjs';
import { inspectProfiles } from '../shared/profile-lock.mjs';
import { loadUserPreferences, resolveAutomationMode } from '../shared/preferences.mjs';

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

function abortError(signal) {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error(typeof reason === 'string' && reason ? reason : 'Browser call cancelled');
  return Object.assign(error, { code: error.code ?? 'ABORTED', requestedInputDispatched: false });
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export async function createGateway(root, data, { authority = 'hook' } = {}) {
  if (authority !== 'hook' && authority !== 'connection') throw new Error('Unknown caller authority');
  const policy = await BrowserPolicy.load(root);
  const engine = engineMode() ?? policy.engine;
  // Connection authority defers spawning the companion (both Camoufox and
  // Electron) until the first operational call so idle MCP registrations keep
  // zero companion processes; hook authority stays eager for PreToolUse endpoint.json.
  const lazy = authority === 'connection';
  const channel = randomUUID();
  const connectionId = randomUUID();
  const paths = connectionPaths(data, channel);
  const key = randomBytes(32).toString('base64url');
  const flag = engine === 'electron' ? '--browser-electron' : '--browser';

  // Freeze the trusted configuration snapshot once before admitting any call so
  // cold metadata (`status`/`list_profiles`) and a lazily spawned companion agree.
  const camoufoxMeta = lazy && engine === 'camoufox' ? camoufoxExecutable(root) : null;
  const usePersistent = lazy && engine === 'camoufox' ? persistentProfilesEnabled(authority) : false;
  const profilesRoot = path.join(data, 'profiles');
  const prefs = lazy ? await loadUserPreferences(data) : null;
  const resolvedMode = lazy ? resolveAutomationMode({ envMode: automationMode(), policy, prefs }) : null;
  const initSnapshot = lazy ? { connectionId, policy: policy.toSnapshot(), prefs } : null;

  let child = null, exit = null, peer = null, issuer = null;
  let started = false, startFlight = null, startFailed = null;
  let terminated = null, closing = false, terminationReason = null;

  const helloBase = { channel, key, role: 'gateway' };
  const issuerHello = { channel, key, role: 'hook' };
  const ended = () => Boolean(terminated || closing || terminationReason || startFailed);
  const connectionClosedError = () => Object.assign(
    new Error('Browser connection ended; reconnect the plugin explicitly'),
    { code: 'CONNECTION_CLOSED', requestedInputDispatched: false },
  );
  const watch = current => current.on('event', (event, params) => {
    if (event === 'terminating') terminationReason = params?.reason;
  });

  async function startCompanion() {
    if (ended()) throw connectionClosedError();
    await mkdir(path.dirname(paths.directory), { recursive: true });
    await mkdir(paths.directory); // Fresh allocation; never reuse a previous connection.
    let startup = '', errors = '';
    const proc = spawn(path.join(root, 'bin', 'bridge.exe'), [flag], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WB_CHANNEL: channel, WB_IPC_KEY: key, ...(lazy ? { WB_LAZY_INIT: '1' } : {}) },
    });
    child = proc;
    const procExit = new Promise(resolve => {
      proc.once('exit', (code, signal) => {
        terminated = { code, signal };
        resolve(terminated);
      });
    });
    exit = procExit;
    let cleanupStartup = () => {};
    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanupStartup();
        fn(value);
      };
      const onError = error => done(reject, error);
      const onExit = (code, signal) => done(reject, new Error(`Browser companion startup exited (${code ?? signal})${errors ? `\n${errors}` : ''}`));
      const onStderr = bytes => {
        errors = (errors + bytes.toString('utf8')).slice(-16384);
      };
      const onStdout = bytes => {
        startup += bytes.toString('utf8');
        if (startup.includes(`WB_READY ${channel}\n`)) { done(resolve); return; }
        if (startup.length > 65536) { proc.kill(); done(reject, new Error('Invalid companion startup output')); }
      };
      cleanupStartup = () => {
        proc.removeListener('error', onError);
        proc.removeListener('exit', onExit);
        proc.stderr.removeListener('data', onStderr);
        proc.stdout.removeListener('data', onStdout);
        startup = '';
        errors = '';
        proc.stdout.resume();
        proc.stderr.resume();
      };
      proc.once('error', onError);
      proc.once('exit', onExit);
      proc.stderr.on('data', onStderr);
      proc.stdout.on('data', onStdout);
    });
    try {
      await bounded(ready, 20000, 'Browser companion startup', undefined, () => { cleanupStartup(); proc.kill(); });
      if (closing) throw new Error('Browser connection closed during startup');
      peer = await connect(paths.pipe, lazy ? { ...helloBase, snapshot: initSnapshot } : helloBase);
      watch(peer);
      if (closing) throw new Error('Browser connection closed during startup');
      // Host hooks find the pipe and key through endpoint.json. Connection
      // authority has no hooks, so its key never touches the disk.
      if (authority === 'hook') {
        await writeFile(`${paths.endpoint}.tmp`, JSON.stringify({ channel, key, pipe: paths.pipe, protocol: 1 }), { mode: 0o600, flag: 'wx' });
        await rename(`${paths.endpoint}.tmp`, paths.endpoint);
      }
      // Connection authority: this process issues each call's single-use ticket
      // over its own hook-role connection, so the companion admits every call
      // through CallerAuthority.consume exactly as under host hooks.
      issuer = authority === 'connection' ? connect(paths.pipe, issuerHello) : null;
      if (issuer) await issuer;
      if (closing) throw new Error('Browser connection closed during startup');
      started = true;
    } catch (error) {
      peer?.close();
      peer = null;
      if (issuer) (await issuer.catch(() => null))?.close();
      issuer = null;
      if (!terminated) proc.kill();
      await bounded(procExit, 4000, 'Failed companion cleanup').catch(() => {});
      throw Object.assign(error, { requestedInputDispatched: false });
    }
  }

  async function ensureStarted(signal) {
    if (signal?.aborted) throw abortError(signal);
    if (ended()) throw connectionClosedError();
    if (started) return;
    if (!startFlight) {
      startFlight = startCompanion().catch(error => {
        startFailed = error;
        throw error;
      });
      // Prevent unhandled rejection when a caller cancels before startup finishes.
      startFlight.catch(() => {});
    }
    await awaitWithSignal(startFlight, signal);
    if (signal?.aborted) throw abortError(signal);
    if (ended()) throw connectionClosedError();
  }

  // Hook authority needs endpoint.json before PreToolUse arrives; connection
  // authority (both Camoufox and Electron) starts lazily on the first call.
  if (!lazy) {
    await startCompanion();
  }

  const ticket = args => {
    // Chained so concurrent calls share one reconnect after a lost transport.
    issuer = issuer.catch(() => null).then(current => (current && !current.closed ? current : connect(paths.pipe, issuerHello)));
    return issuer.then(current => current.request('issue', {
      sessionId: CONNECTION_CALLER, callId: randomUUID(), toolName: BROWSER_TOOL, args,
    }, { timeoutMs: 2000 })).then(response => response.ticket);
  };

  const livePeer = async () => {
    if (ended()) throw connectionClosedError();
    if (!peer || peer.closed) {
      // Reconnect the transport for NEW calls only; never replay the lost call.
      peer = await connect(paths.pipe, helloBase);
      watch(peer);
    }
    return peer;
  };

  return {
    channel,
    authority,
    engine,
    async status() {
      if (terminated || terminationReason || startFailed) {
        return {
          channel,
          engine,
          ...(lazy ? { connectionId } : {}),
          state: 'connection-ended',
          companionState: 'ended',
          terminationReason: terminationReason ?? (startFailed ? 'startup-failed' : undefined),
          process: terminated,
        };
      }
      if (lazy && !started) {
        const companionState = startFlight ? 'starting' : 'not-started';
        const canElevate = resolvedMode.mode === 'standard' && !resolvedMode.pinned && Boolean(data);
        if (engine === 'camoufox') {
          return {
            channel,
            state: 'connected',
            companionState,
            engine: 'camoufox',
            runtime: `Camoufox ${camoufoxMeta.version}`,
            connectionId,
            automationMode: resolvedMode.mode,
            profilePersistence: usePersistent ? 'persistent-pending' : 'ephemeral',
            tabCount: 0,
            pausedCount: 0,
            capabilities: camoufoxCapabilities({
              policy,
              automationMode: resolvedMode.mode,
              configuredAutomationMode: resolvedMode.mode,
              automationModeSource: resolvedMode.source,
              automationModePinned: resolvedMode.pinned,
              automationPreferenceReason: resolvedMode.preferenceReason,
              canElevate,
              persistentPreference: Boolean(data),
              enableRdp: true,
              rdpConnected: false,
              namedPersistentProfiles: usePersistent,
            }),
          };
        }
        return {
          channel,
          state: 'connected',
          companionState,
          engine: 'electron',
          connectionId,
          automationMode: resolvedMode.mode,
          tabCount: 0,
          pausedCount: 0,
          capabilities: electronCapabilities({
            policy,
            automationMode: resolvedMode.mode,
            configuredAutomationMode: resolvedMode.mode,
            automationModeSource: resolvedMode.source,
            automationModePinned: resolvedMode.pinned,
            automationPreferenceReason: resolvedMode.preferenceReason,
            canElevate,
            persistentPreference: Boolean(data),
          }),
        };
      }
      return { channel, companionState: 'running', ...await (await livePeer()).request('status', {}) };
    },
    async execute(args, signal) {
      if (authority === 'hook' && args?._channel !== channel) throw new Error('Missing, foreign or replaced browser channel');
      if (authority === 'connection' && Object.hasOwn(args, '_lease')) {
        fail('INVALID_ARGUMENT', 'This server issues its own caller tickets; send the call without _lease',
          { requestedInputDispatched: false });
      }
      if (ended()) throw connectionClosedError();
      // Narrow connection-authority metadata exception alongside `status`:
      // cold `list_profiles` is strictly read-only (no companion spawn, lock,
      // or connection directory creation) on both Electron and Camoufox.
      if (lazy && !started && args?.action === 'list_profiles') {
        const { _channel: _ignored, ...cleaned } = args;
        try { validateArgs(cleaned); }
        catch (error) { throw Object.assign(error, { requestedInputDispatched: false }); }
        if (engine === 'camoufox') {
          const profiles = await inspectProfiles(profilesRoot, { persistenceEnabled: usePersistent });
          return { supported: true, engine: 'camoufox', persistenceEnabled: usePersistent, profiles };
        }
        return { ...ELECTRON_LIST_PROFILES, profiles: [] };
      }
      if (lazy && !started) {
        await ensureStarted(signal);
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
      if (signal?.aborted) throw abortError(signal);
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
      if (lazy && !started && !startFlight && !child) return;
      if (startFlight) {
        if (child && !terminated && !started) child.kill();
        await startFlight.catch(() => {});
      }
      if (child && !terminated) {
        try {
          if (peer && !peer.closed) await peer.request('shutdown', {}, { timeoutMs: 2000 });
          else child.kill();
        } catch {
          if (!terminated) child.kill();
        }
        if (exit) {
          try { await bounded(exit, 8000, 'Owned companion shutdown', undefined, () => child.kill()); }
          catch { child.kill(); }
        }
      }
      peer?.close();
      if (issuer) (await issuer.catch(() => null))?.close();
      // Only the endpoint created by THIS gateway is removed. Profiles stay.
      if (authority === 'hook' && started) await unlink(paths.endpoint).catch(() => {});
    },
  };
}
