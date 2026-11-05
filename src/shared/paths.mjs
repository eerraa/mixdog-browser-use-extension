import path from 'node:path';
import { createHash } from 'node:crypto';

export const validChannel = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** Who proves the caller of a browser call (contracts.md Authority and isolation):
 * `hook` (default), the Mixdog host's PreToolUse hook issues one ticket per call;
 * `connection`, a plain MCP registration such as Claude Code's `claude mcp add`,
 * where the MCP connection itself is the caller. Set only by the registration. */
export function authorityMode(env = process.env) {
  const mode = env.WB_AUTHORITY || 'hook';
  if (mode !== 'hook' && mode !== 'connection') {
    throw new Error('WB_AUTHORITY must be hook or connection');
  }
  return mode;
}

/** The data root: `MIXDOG_PLUGIN_DATA` under hook authority (assigned by Mixdog
 * per registered folder), `WB_DATA_DIR` under connection authority. */
export function pluginData(env = process.env) {
  if (authorityMode(env) === 'connection') {
    const directory = env.WB_DATA_DIR;
    if (!directory || !path.isAbsolute(directory)) {
      throw new Error('WB_DATA_DIR must be an absolute directory when WB_AUTHORITY=connection');
    }
    return path.resolve(directory);
  }
  const directory = env.MIXDOG_PLUGIN_DATA;
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error('MIXDOG_PLUGIN_DATA is required; register the packaged folder as a Mixdog plugin, '
      + 'or register bin/bridge.exe --mcp as a plain MCP server with WB_AUTHORITY=connection and WB_DATA_DIR');
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
