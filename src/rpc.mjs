import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const failure = (code, message) => Object.assign(new Error(message), { code });
function errorData(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'RPC_ERROR',
    message: String(error?.message ?? error),
    ...(typeof error?.snapshotId === 'string' ? { snapshotId: error.snapshotId } : {}),
    ...(Array.isArray(error?.candidates) ? { candidates: error.candidates } : {}),
  };
}

/** Private, bounded JSON-lines transport over an owned stream. Authentication
 * belongs to the companion's hello handler, never to a web page. Cancellation
 * releases a waiting client but does not claim that dispatched browser work
 * stopped; the browser's actual-operation fence remains authoritative.
 */
export class RpcPeer extends EventEmitter {
  #stream;
  #handler;
  #decoder = new StringDecoder('utf8');
  #buffer = '';
  #pending = new Map();
  #incoming = new Map();
  #closed = false;
  #max;

  constructor(stream, onRequest = null, { maxFrameBytes = 16 * 1024 * 1024 } = {}) {
    super();
    this.#stream = stream;
    this.#handler = onRequest;
    this.#max = maxFrameBytes;
    stream.on('data', bytes => {
      try { this.#receive(bytes); } catch (error) { this.close(error); }
    });
    stream.on('error', error => this.close(error));
    stream.on('end', () => this.close(failure('CONNECTION_LOST', 'Local connection closed')));
    stream.on('close', () => this.close(failure('CONNECTION_LOST', 'Local connection closed')));
  }

  get closed() { return this.#closed; }

  #send(message) {
    if (this.#closed) throw failure('CONNECTION_LOST', 'Local connection closed');
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > this.#max) throw failure('FRAME_TOO_LARGE', 'Local message exceeds its byte limit');
    this.#stream.write(frame, error => { if (error) this.close(error); });
  }

  request(method, params, { signal, timeoutMs = 30_000 } = {}) {
    if (this.#closed) return Promise.reject(failure('CONNECTION_LOST', 'Local connection closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#pending.size >= 256) return Promise.reject(failure('RESOURCE_LIMIT', 'Too many local requests'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer, written = false;
      const finish = (settle, value) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        settle(value);
      };
      const cancel = error => {
        finish(reject, error);
        if (written && !this.#closed) {
          try { this.#send({ cancel: id }); } catch (sendError) { this.close(sendError); }
        }
      };
      const abort = () => cancel(signal.reason);
      this.#pending.set(id, {
        resolve: value => finish(resolve, value),
        reject: error => finish(reject, error),
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => cancel(failure('RPC_TIMEOUT', 'Local request timed out; do not replay browser input')), timeoutMs);
      try {
        this.#send({ id, method, params });
        written = true;
      } catch (error) { finish(reject, error); }
    });
  }

  event(name, params) { this.#send({ event: name, params }); }

  flush() {
    if (this.#closed) return Promise.reject(failure('CONNECTION_LOST', 'Local connection closed'));
    return new Promise((resolve, reject) => this.#stream.write('', error => error ? reject(error) : resolve()));
  }

  #receive(bytes) {
    if (this.#closed) return;
    this.#buffer += this.#decoder.write(bytes);
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.#max) throw failure('FRAME_TOO_LARGE', 'Local input exceeds its byte limit');
      const message = JSON.parse(line);
      if (!plain(message)) throw failure('INVALID_FRAME', 'Invalid local message');
      this.#message(message);
    }
    if (Buffer.byteLength(this.#buffer) > this.#max) throw failure('FRAME_TOO_LARGE', 'Local input exceeds its byte limit');
  }

  #message(message) {
    if (identifier(message.cancel)) {
      this.#incoming.get(message.cancel)?.abort(failure('REQUEST_CANCELLED', 'Local caller cancelled'));
      return;
    }
    if (identifier(message.event)) {
      this.emit('event', message.event, message.params);
      return;
    }
    if (!identifier(message.id)) throw failure('INVALID_FRAME', 'Local request identity is missing');
    if (typeof message.method !== 'string') {
      const pending = this.#pending.get(message.id);
      if (!pending) return; // A late response cannot resurrect a cancelled call.
      if (plain(message.error)) {
        pending.reject(Object.assign(new Error(String(message.error.message)), message.error));
      } else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
      else throw failure('INVALID_FRAME', 'Invalid local response');
      return;
    }
    if (!/^[a-z][a-z_]{0,31}$/.test(message.method) || !this.#handler) {
      throw failure('INVALID_METHOD', 'Unsupported local method');
    }
    if (this.#incoming.has(message.id)) throw failure('DUPLICATE_REQUEST', 'Duplicate local request identity');
    if (this.#incoming.size >= 256) throw failure('RESOURCE_LIMIT', 'Too many incoming local requests');
    const controller = new AbortController();
    this.#incoming.set(message.id, controller);
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.#handler(message.method, message.params, controller.signal);
    }).then(result => {
      if (!this.#closed && !controller.signal.aborted) this.#send({ id: message.id, result: result ?? null });
    }, error => {
      if (!this.#closed && !controller.signal.aborted) this.#send({ id: message.id, error: errorData(error) });
    }).catch(error => this.close(error)).finally(() => this.#incoming.delete(message.id));
  }

  close(reason = failure('CONNECTION_LOST', 'Local connection closed')) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(reason);
    for (const controller of this.#incoming.values()) controller.abort(reason);
    this.#incoming.clear();
    this.#stream.destroy();
    this.emit('closed', reason);
  }
}
