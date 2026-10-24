import { bounded } from '../async.mjs';

// Subscribe immediately after constructing an owned hidden guest. Load
// completion is not first-paint completion; this latch never shows the window.
export function firstRender(window, timeoutMs = 15000) {
  const contents = window.webContents;
  let rendered, unavailable;
  const pending = new Promise((resolve, reject) => {
    rendered = resolve;
    unavailable = () => reject(new Error('Browser closed or renderer lost before first render'));
    window.once('ready-to-show', rendered);
    window.once('closed', unavailable);
    contents.once('render-process-gone', unavailable);
  });
  const promise = bounded(pending, timeoutMs, 'First browser render', undefined, () => window.destroy()).finally(() => {
    window.off('ready-to-show', rendered);
    window.off('closed', unavailable);
    contents.off('render-process-gone', unavailable);
  });
  // Startup can fail or be cancelled before its initialization awaits paint.
  void promise.catch(() => {});
  return promise;
}
