// The same native Worker probe is exercised through the isolated driver and
// the packaged MCP tool. Expected data comes from the worker's explicit code.
export const WORKER_PROBE_EXPRESSION = `(async () => {
  const url = URL.createObjectURL(new Blob([
    'self.postMessage({kind:"diagnostic-worker-ready",value:3+4});'
  ], {type:'text/javascript'}));
  let worker, timer;
  try {
    return await new Promise((resolve, reject) => {
      worker = new Worker(url);
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessageerror = () => reject(new Error('Worker message could not be decoded'));
      timer = setTimeout(() => reject(new Error('WORKER_START_TIMEOUT')), 4000);
    });
  } finally {
    clearTimeout(timer);
    worker?.terminate();
    URL.revokeObjectURL(url);
  }
})()`;
