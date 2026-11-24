// Out-of-band user preferences stored in the configured data root
// (`WB_DATA_DIR/user-preferences.json`).
// Never writable by MCP arguments, page scripts, or the `run` sandbox: written
// only by direct user file edit or authenticated browser toolbar input.
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const PREFERENCES_FILE = 'user-preferences.json';
const ALLOWED_MODES = new Set(['standard', 'elevated']);
const ALLOWED_KEYS = new Set(['version', 'automationMode']);

// Serialize writes per file path inside this process so rapid clicks never race.
const writeQueues = new Map();

function normalizeForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinDir(candidatePath, dirPath) {
  const candidate = normalizeForCompare(candidatePath);
  const dir = normalizeForCompare(dirPath);
  const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  return candidate === dir || candidate.startsWith(prefix);
}

/**
 * Refuse uploading internal win-browser control, credential, preference, or
 * browser-profile files (cookies/SQLite DBs/IPC keys) to websites while still
 * allowing ordinary local files and saved browser downloads.
 */
export function isProtectedInternalPath(resolvedFile, { dataRoot = null, connectionDataDir = null } = {}) {
  const file = normalizeForCompare(resolvedFile);
  const base = path.basename(file);

  const checkConnectionDir = connDir => {
    if (!connDir) return false;
    const norm = normalizeForCompare(connDir);
    if (file === normalizeForCompare(path.join(norm, 'endpoint.json'))
      || (path.dirname(file) === norm && base.startsWith('endpoint.json.'))) return true;
    if (isWithinDir(file, path.join(norm, 'profiles'))) return true;
    if (isWithinDir(file, path.join(norm, 'electron'))) return true;
    return false;
  };

  if (dataRoot) {
    const root = normalizeForCompare(dataRoot);
    if (file === normalizeForCompare(path.join(root, PREFERENCES_FILE))
      || (path.dirname(file) === root && base.startsWith(`${PREFERENCES_FILE}.`))) return true;
    if (isWithinDir(file, path.join(root, 'profiles'))) return true;
    const connectionsRoot = path.join(root, 'connections');
    if (isWithinDir(file, connectionsRoot)) {
      const rel = path.relative(connectionsRoot, file);
      const firstSegment = rel.split(path.sep)[0];
      if (firstSegment && checkConnectionDir(path.join(connectionsRoot, firstSegment))) return true;
    }
  }

  if (connectionDataDir) {
    const conn = normalizeForCompare(connectionDataDir);
    if (file === normalizeForCompare(path.join(conn, PREFERENCES_FILE))
      || (path.dirname(file) === conn && base.startsWith(`${PREFERENCES_FILE}.`))) return true;
    if (checkConnectionDir(conn)) return true;
  }

  return false;
}

export function preferencesPath(dataRoot) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    throw new TypeError('Absolute dataRoot is required for user preferences');
  }
  return path.join(path.resolve(dataRoot), PREFERENCES_FILE);
}

export async function loadUserPreferences(dataRoot) {
  if (!dataRoot) return { ok: true, found: false, automationMode: null, reason: null };
  const filePath = preferencesPath(dataRoot);
  try {
    const st = await lstat(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { ok: false, found: true, automationMode: null, reason: 'user-preferences.json must be a regular non-symlink file' };
    }
    const rootReal = await realpath(dataRoot);
    const fileReal = await realpath(filePath);
    if (normalizeForCompare(path.dirname(fileReal)) !== normalizeForCompare(rootReal)) {
      return { ok: false, found: true, automationMode: null, reason: 'user-preferences.json escaped its owned data directory' };
    }
    const raw = await readFile(filePath, 'utf8');
    if (raw.length > 16384) {
      return { ok: false, found: true, automationMode: null, reason: 'user-preferences.json exceeds size limit' };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, found: true, automationMode: null, reason: 'user-preferences.json must be a JSON object' };
    }
    const keys = Object.keys(parsed);
    if (parsed.version !== 1
      || !keys.every(k => ALLOWED_KEYS.has(k))
      || (Object.hasOwn(parsed, 'automationMode') && !ALLOWED_MODES.has(parsed.automationMode))) {
      return { ok: false, found: true, automationMode: null, reason: 'user-preferences.json has invalid schema or automationMode' };
    }
    return {
      ok: true,
      found: true,
      automationMode: Object.hasOwn(parsed, 'automationMode') ? parsed.automationMode : null,
      reason: null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, found: false, automationMode: null, reason: null };
    }
    const reason = error instanceof SyntaxError
      ? 'user-preferences.json is malformed JSON'
      : `user-preferences.json could not be read (${error?.code ?? error?.message})`;
    return { ok: false, found: true, automationMode: null, reason };
  }
}

export async function saveUserPreferences(dataRoot, { automationMode }) {
  if (!ALLOWED_MODES.has(automationMode)) {
    throw new TypeError('automationMode must be standard or elevated');
  }
  const filePath = preferencesPath(dataRoot);
  const key = normalizeForCompare(filePath);
  const prior = writeQueues.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    const dirStat = await lstat(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error('Data root must be a real non-symlink directory');
    }
    try {
      const existing = await lstat(filePath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error('Refusing to overwrite symlink or non-file user-preferences.json');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const payload = `${JSON.stringify({ version: 1, automationMode }, null, 2)}\n`;
    const fh = await open(tmpPath, 'wx', 0o600);
    try {
      await fh.writeFile(payload, 'utf8');
      await fh.sync().catch(() => {});
    } finally {
      await fh.close();
    }
    try {
      await rename(tmpPath, filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
    return { version: 1, automationMode, path: filePath };
  });
  writeQueues.set(key, next);
  next.finally(() => { if (writeQueues.get(key) === next) writeQueues.delete(key); });
  return next;
}

/**
 * Shared startup precedence across Camoufox and Electron companions:
 *   1. Explicit WB_AUTOMATION_MODE env var (hard pin; overrides policy & user pref)
 *   2. Malformed browser-policy.json → fail closed to standard (never fall through to saved elevated!)
 *   3. Explicit valid browser-policy.json automationMode (policy pin)
 *   4. Valid <dataRoot>/user-preferences.json automationMode
 *   5. Default: standard
 */
export function resolveAutomationMode({ envMode = null, policy = null, prefs = null } = {}) {
  if (envMode === 'standard' || envMode === 'elevated') {
    return {
      mode: envMode,
      source: 'env',
      pinned: true,
      pinnedStandard: envMode === 'standard',
      preferenceReason: prefs && !prefs.ok ? prefs.reason : null,
    };
  }
  if (policy && policy.valid === false) {
    return {
      mode: 'standard',
      source: 'policy-invalid',
      pinned: true,
      pinnedStandard: true,
      preferenceReason: policy.reason ?? 'Invalid browser-policy.json',
    };
  }
  if (policy?.explicitAutomationMode) {
    return {
      mode: policy.automationMode,
      source: 'policy',
      pinned: true,
      pinnedStandard: policy.automationMode === 'standard',
      preferenceReason: prefs && !prefs.ok ? prefs.reason : null,
    };
  }
  if (prefs && !prefs.ok) {
    return {
      mode: 'standard',
      source: 'user-preference-invalid',
      pinned: false,
      pinnedStandard: false,
      preferenceReason: prefs.reason,
    };
  }
  if (prefs?.ok && (prefs.automationMode === 'standard' || prefs.automationMode === 'elevated')) {
    return {
      mode: prefs.automationMode,
      source: 'user-preference',
      pinned: false,
      pinnedStandard: false,
      preferenceReason: null,
    };
  }
  return {
    mode: 'standard',
    source: 'default',
    pinned: false,
    pinnedStandard: false,
    preferenceReason: null,
  };
}
