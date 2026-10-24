import path from 'node:path';
import { createHash } from 'node:crypto';

export const validChannel = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export function pluginData() {
  const directory = process.env.MIXDOG_PLUGIN_DATA;
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error('MIXDOG_PLUGIN_DATA is required; register the packaged folder as a Mixdog plugin');
  }
  return path.resolve(directory);
}

export function connectionPaths(data, channel) {
  if (!validChannel(channel)) throw new Error('Missing, foreign or replaced browser channel');
  const directory = path.join(data, 'connections', channel);
  const digest = createHash('sha256').update(`${data}\0${channel}`).digest('hex').slice(0, 32);
  return {
    directory, endpoint: path.join(directory, 'endpoint.json'),
    pipe: `\\\\.\\pipe\\independent-browser-${digest}`,
  };
}
