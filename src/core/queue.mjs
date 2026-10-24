// Independently implemented invariant from Mixdog command-queue.ts and
// cdp-execution.ts at 968ee08965e75c3fa1999ab8d18d20e45229fc89:
// cancellation settles the caller, never the actual-dispatch fence.
export class FenceQueue {
  #lanes = new Map();

  isBusy(key) {
    return (this.#lanes.get(key)?.jobs.size ?? 0) > 0;
  }

  abort(key, reason = new DOMException('Lane aborted', 'AbortError')) {
    const lane = this.#lanes.get(key);
    if (!lane) return;
    for (const job of lane.jobs) job.controller.abort(reason);
  }

  run(key, operation, signal) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Operation must be a function'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), jobs: new Set() };
      this.#lanes.set(key, lane);
    }
    const controller = new AbortController();
    const job = { controller };
    lane.jobs.add(job);
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const callerAbort = () => controller.abort(signal.reason);
    const abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', callerAbort, { once: true });
    const actual = lane.tail.then(() => {
      if (controller.signal.aborted) return;
      return operation(controller.signal);
    });
    const finish = () => {
      signal?.removeEventListener('abort', callerAbort);
      controller.signal.removeEventListener('abort', abort);
      lane.jobs.delete(job);
      if (lane.jobs.size === 0) this.#lanes.delete(key);
    };
    // Both handlers consume actual failures, including late failures after abort.
    lane.tail = actual.then(value => {
      finish();
      resolve(value);
    }, error => {
      finish();
      reject(error);
    });
    return result;
  }
}
