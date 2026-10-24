export function pause(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function bounded(promise, timeoutMs, label, signal, onTimeout) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      finish(reject, new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const abort = () => finish(reject, signal.reason);
    const finish = (settle, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle(value);
    };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
