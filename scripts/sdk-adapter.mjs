export function adaptSdkCancellation(source, version) {
  if (version !== '1.32.1') throw new Error('Recheck the MCP cancellation adapter for this SDK version');
  const original = 'async _oncancel(notification) {\n        if (!notification.params.requestId) {';
  if (source.split(original).length !== 2) throw new Error('MCP cancellation adapter source mismatch');
  return source.replace(original,
    'async _oncancel(notification) {\n        if (notification.params.requestId === undefined) {');
}
