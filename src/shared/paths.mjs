import path from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/** Optional connection-wide automation opt-in from the server registration:
 * unset/empty defers to browser-policy.json (default `standard`); `standard` or
 * `elevated` overrides it. Unknown values fail closed before companion startup. */
export function automationMode(env = process.env) {
  const mode = env.WB_AUTOMATION_MODE;
  if (mode === undefined || mode === '') return null;
  if (mode !== 'standard' && mode !== 'elevated') {
    throw new Error('WB_AUTOMATION_MODE must be standard or elevated');
  }
  return mode;
}

/** Optional browser engine override from the server registration:
 * unset/empty defers to browser-policy.json (default `camoufox`); `camoufox`
 * (patched Firefox 158) or `electron` (Chromium 44.9.1 fallback for WebHID/WebUSB).
 * Unknown values fail closed before companion startup. */
export function engineMode(env = process.env) {
  const engine = env.WB_ENGINE;
  if (engine === undefined || engine === '') return null;
  if (engine !== 'camoufox' && engine !== 'electron') {
    throw new Error('WB_ENGINE must be camoufox or electron');
  }
  return engine;
}

function resolveCamoufoxDir(dir) {
  if (!dir) return null;
  const resolved = path.resolve(dir);
  const exe = resolved.toLowerCase().endsWith('.exe') ? resolved : path.join(resolved, 'camoufox.exe');
  if (!existsSync(exe)) return null;
  const directory = path.dirname(exe);
  let version = 'unknown';
  try {
    const versionFile = path.join(directory, 'version.json');
    if (existsSync(versionFile)) {
      const meta = JSON.parse(readFileSync(versionFile, 'utf8'));
      const rel = meta.release || meta.build;
      if (meta.version) version = rel ? `${meta.version}-${rel}` : String(meta.version);
    }
  } catch { /* ignore version metadata errors */ }
  return { executablePath: exe, directory, version };
}

/** Resolve the Camoufox runtime executable:
 * 1. Explicit WB_CAMOUFOX_PATH (fails closed if set but missing);
 * 2. Bundled or junctioned <root>/camoufox/camoufox.exe (packaged / shared runtime);
 * 3. Shared install root <root>/../win-browser-runtime/camoufox or ../../win-browser-runtime/camoufox;
 * 4. Local Camoufox cache (%LOCALAPPDATA%/camoufox/camoufox/Cache/browsers/official/*) for repo dev runs. */
export function camoufoxExecutable(root, env = process.env) {
  const explicit = env.WB_CAMOUFOX_PATH;
  if (explicit !== undefined && explicit !== '') {
    if (!path.isAbsolute(explicit)) throw new Error('WB_CAMOUFOX_PATH must be an absolute path');
    const found = resolveCamoufoxDir(explicit);
    if (!found) throw new Error(`WB_CAMOUFOX_PATH does not contain camoufox.exe: ${explicit}`);
    return { ...found, source: 'env' };
  }
  if (root) {
    for (const [candidate, source] of [
      [path.join(root, 'camoufox'), 'package'],
      [path.join(root, 'runtime', 'camoufox'), 'package'],
      [path.resolve(root, '..', 'win-browser-runtime', 'camoufox'), 'shared-runtime'],
      [path.resolve(root, '..', '..', 'win-browser-runtime', 'camoufox'), 'shared-runtime'],
      [path.resolve(root, '..', '..', '..', 'win-browser-runtime', 'camoufox'), 'shared-runtime'],
    ]) {
      const found = resolveCamoufoxDir(candidate);
      if (found) return { ...found, source };
    }
  }
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    const official = path.join(localAppData, 'camoufox', 'camoufox', 'Cache', 'browsers', 'official');
    if (existsSync(official)) {
      const dirs = readdirSync(official, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ name: e.name, full: path.join(official, e.name), mtime: statSync(path.join(official, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
      for (const entry of dirs) {
        const found = resolveCamoufoxDir(entry.full);
        if (found) return { ...found, source: 'local-cache' };
      }
    }
  }
  throw new Error('Camoufox runtime not found. Bundle camoufox/ in the package, install into win-browser-runtime/camoufox, or set WB_CAMOUFOX_PATH');
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
