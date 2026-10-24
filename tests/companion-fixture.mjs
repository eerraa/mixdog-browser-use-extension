import { EventEmitter } from 'node:events';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
export const state = { peers: [], listening: deferred(), exited: deferred() };
export const app = {
  userAgentFallback: 'Mozilla/5.0 IndependentWindowsBrowser/44.9.1 Chrome/152.0.7977.167 Electron/44.9.1 Safari/537.36',
  setPath() {}, setName() {}, whenReady: async () => {},
  exit(code) { state.exitCode = code; state.exited.resolve(code); },
};
export class BrowserHost {
  constructor(options) { this.options = options; this.closed = false; state.host = this; }
  async close() { this.closed = true; }
  endSession(sessionId) { (state.endedSessions ??= []).push(sessionId); }
}
export class RpcPeer extends EventEmitter {
  constructor(_socket, handler) {
    super();
    this.handler = handler;
    this.closed = false;
    state.peers.push(this);
  }
  event() {
    if (this.closed) throw Object.assign(new Error('Local connection closed'), { code: 'CONNECTION_LOST' });
  }
  async flush() {
    if (this.closed) throw Object.assign(new Error('Local connection closed'), { code: 'CONNECTION_LOST' });
  }
  close() { if (!this.closed) { this.closed = true; this.emit('closed'); } }
}
export default {
  createServer(accept) {
    const listener = new EventEmitter();
    listener.accept = accept;
    listener.listen = (_pipe, callback) => { callback(); state.listening.resolve(); };
    listener.close = () => { listener.closed = true; };
    state.listener = listener;
    return listener;
  },
};
