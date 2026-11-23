// Named persistent Camoufox profile directory management and cross-process
// lock coordination under the owned `profiles/` root.
// Shared between `src/mcp/gateway.mjs` (read-only cold `list_profiles`) and
// `src/browser/camoufox/host.mjs` (full lock acquisition/release); zero Electron
// or browser-layer dependencies.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pause } from './async.mjs';
import { PROFILE_SLUG } from './contract.mjs';

export const DEFAULT_PROFILES = Object.freeze(['default', 'work', 'personal']);
const DIR_PREFIX = 'camoufox-';
const DIR_PATTERN = /^camoufox-([a-z0-9][a-z0-9_-]{0,39})$/;
const FRESH_EMPTY_LOCK_MS = 2000;
const STALE_RECOVERY_LOCK_MS = 10000;

export function profileDirName(slug) {
  if (typeof slug !== 'string' || !PROFILE_SLUG.test(slug)) {
    throw new TypeError(`Invalid profile slug: ${String(slug)}`);
  }
  return `${DIR_PREFIX}${slug}`;
}

export function slugFromDirName(name) {
  const match = typeof name === 'string' ? DIR_PATTERN.exec(name) : null;
  return match ? match[1] : null;
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function samePath(a, b) {
  const pa = path.resolve(a), pb = path.resolve(b);
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

async function assertNotSymlinkIfExists(targetPath, kind = 'any') {
  try {
    const st = await lstat(targetPath);
    if (st.isSymbolicLink()) {
      throw Object.assign(new Error(`Refusing symlink or junction at ${targetPath}`), { code: 'PROFILE_UNSAFE_PATH' });
    }
    if (kind === 'dir' && !st.isDirectory()) {
      throw Object.assign(new Error(`Expected directory at ${targetPath}`), { code: 'PROFILE_UNSAFE_PATH' });
    }
    if (kind === 'file' && !st.isFile()) {
      throw Object.assign(new Error(`Expected regular file at ${targetPath}`), { code: 'PROFILE_UNSAFE_PATH' });
    }
    return st;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function resolveOwnedProfileDir(profilesRoot, slug, { createRoot = false } = {}) {
  if (typeof profilesRoot !== 'string' || !path.isAbsolute(profilesRoot)) {
    throw new TypeError('Absolute profilesRoot is required');
  }
  const dirName = profileDirName(slug);
  const normalizedRoot = path.resolve(profilesRoot);
  if (createRoot) await mkdir(normalizedRoot, { recursive: true });
  const rootStat = await assertNotSymlinkIfExists(normalizedRoot, 'dir');
  const candidate = path.resolve(normalizedRoot, dirName);
  if (!samePath(path.dirname(candidate), normalizedRoot)) {
    throw Object.assign(new Error('Profile path escaped owned profiles root'), { code: 'PROFILE_UNSAFE_PATH' });
  }
  const dirStat = await assertNotSymlinkIfExists(candidate, 'dir');
  if (rootStat && dirStat) {
    const [realRoot, realCandidate] = await Promise.all([realpath(normalizedRoot), realpath(candidate)]);
    if (!samePath(path.dirname(realCandidate), realRoot)) {
      throw Object.assign(new Error('Canonical profile path escaped owned profiles root'), { code: 'PROFILE_UNSAFE_PATH' });
    }
  }
  const lockPath = `${candidate}.lock`;
  await assertNotSymlinkIfExists(lockPath, 'file');
  return { profileDir: candidate, lockPath, dirName };
}

async function readLockMeta(lockPath) {
  try {
    await assertNotSymlinkIfExists(lockPath, 'file');
    const raw = await readFile(lockPath, 'utf8');
    if (!raw.trim()) return { empty: true, pid: 0, token: null, meta: null };
    const meta = JSON.parse(raw);
    return {
      empty: false,
      pid: Number.isInteger(meta?.pid) ? meta.pid : 0,
      token: typeof meta?.token === 'string' ? meta.token : null,
      meta,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true, pid: 0, token: null, meta: null };
    if (error?.code === 'PROFILE_UNSAFE_PATH') throw error;
    return { corrupt: true, pid: 0, token: null, meta: null };
  }
}

async function isLockActive(lockPath) {
  const first = await readLockMeta(lockPath);
  if (first.missing) return { active: false, meta: first };
  if (first.pid > 0 && pidAlive(first.pid)) return { active: true, pid: first.pid, meta: first };
  if (first.empty || first.corrupt || first.pid === 0) {
    const info = await stat(lockPath).catch(() => null);
    if (info && Date.now() - info.mtimeMs < FRESH_EMPTY_LOCK_MS) {
      await pause(50);
      const second = await readLockMeta(lockPath);
      if (second.missing) return { active: false, meta: second };
      if (second.pid > 0 && pidAlive(second.pid)) return { active: true, pid: second.pid, meta: second };
      if (second.empty || second.corrupt || second.pid === 0) {
        return { active: true, pid: 0, meta: second };
      }
    }
  }
  return { active: false, pid: first.pid, meta: first };
}

/**
 * Acquire an exclusive cross-process lock for `profiles/camoufox-<slug>` under
 * `profilesRoot`. Serializes stale-lock recovery via `<lockPath>.recovery` so
 * two simultaneous contenders cannot unlink each other's fresh lock, and tags
 * the lock with a per-acquisition random token verified on release.
 */
export async function acquireProfileLock(profilesRoot, slug, { connectionId = '', pid = process.pid } = {}) {
  const { profileDir, lockPath, dirName } = await resolveOwnedProfileDir(profilesRoot, slug, { createRoot: true });
  const recoveryPath = `${lockPath}.recovery`;
  const token = randomBytes(16).toString('hex');

  for (let attempt = 0; attempt < 6; attempt++) {
    await assertNotSymlinkIfExists(lockPath, 'file');
    try {
      const fh = await open(lockPath, 'wx');
      try {
        await fh.writeFile(JSON.stringify({ pid, connectionId, slug, token, acquiredAt: Date.now() }), 'utf8');
      } finally {
        await fh.close();
      }
      await mkdir(profileDir, { recursive: true });
      await assertNotSymlinkIfExists(profileDir, 'dir');
      return { ok: true, slug, dirName, profileDir, lockPath, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: 'io-error', slug, profileDir, lockPath, error };
      }
      const state = await isLockActive(lockPath);
      if (state.active) {
        return { ok: false, reason: 'busy', slug, profileDir, lockPath, ownerPid: state.pid ?? 0 };
      }
      await assertNotSymlinkIfExists(recoveryPath, 'file');
      let recoveryHeld = false;
      try {
        const rfh = await open(recoveryPath, 'wx');
        try {
          await rfh.writeFile(JSON.stringify({ pid, token, at: Date.now() }), 'utf8');
        } finally {
          await rfh.close();
        }
        recoveryHeld = true;
      } catch (recErr) {
        if (recErr?.code === 'EEXIST') {
          const info = await stat(recoveryPath).catch(() => null);
          if (info && Date.now() - info.mtimeMs > STALE_RECOVERY_LOCK_MS) {
            await unlink(recoveryPath).catch(() => {});
          } else {
            await pause(40);
          }
          continue;
        }
        return { ok: false, reason: 'io-error', slug, profileDir, lockPath, error: recErr };
      }
      try {
        const recheck = await isLockActive(lockPath);
        if (recheck.active) {
          return { ok: false, reason: 'busy', slug, profileDir, lockPath, ownerPid: recheck.pid ?? 0 };
        }
        if (!recheck.meta?.missing) {
          await unlink(lockPath).catch(() => {});
        }
      } finally {
        if (recoveryHeld) await unlink(recoveryPath).catch(() => {});
      }
    }
  }
  return { ok: false, reason: 'busy', slug, profileDir, lockPath, ownerPid: 0 };
}

/**
 * Release a previously acquired profile lock ONLY if the lock file still holds
 * our exact acquisition token (never blindly unlink another contender's lock).
 */
export async function releaseProfileLock(handle) {
  if (!handle?.lockPath || !handle?.token) return false;
  try {
    const current = await readLockMeta(handle.lockPath);
    if (current.missing) return false;
    if (!current.token || current.token !== handle.token) return false;
    await unlink(handle.lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strictly read-only profile discovery: never creates directories, acquires
 * locks, or spawns browsers. Lists the pre-seeded defaults (`default`, `work`,
 * `personal`) plus any valid existing `camoufox-<slug>` directories on disk.
 */
export async function inspectProfiles(profilesRoot, { activeBySlug = new Map(), persistenceEnabled = true } = {}) {
  const discovered = new Set(DEFAULT_PROFILES);
  const onDisk = new Set();

  if (profilesRoot) {
    try {
      const rootStat = await lstat(profilesRoot);
      if (!rootStat.isSymbolicLink() && rootStat.isDirectory()) {
        const entries = await readdir(profilesRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const slug = slugFromDirName(entry.name);
          if (slug) {
            discovered.add(slug);
            onDisk.add(slug);
          }
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') { /* read-only best effort */ }
    }
  }

  for (const slug of activeBySlug.keys()) discovered.add(slug);

  const defaultsOrder = new Map(DEFAULT_PROFILES.map((s, i) => [s, i]));
  const ordered = [...discovered].sort((a, b) => {
    const ia = defaultsOrder.has(a) ? defaultsOrder.get(a) : Number.MAX_SAFE_INTEGER;
    const ib = defaultsOrder.has(b) ? defaultsOrder.get(b) : Number.MAX_SAFE_INTEGER;
    return ia !== ib ? ia - ib : a.localeCompare(b);
  });

  const profiles = [];
  for (const slug of ordered) {
    const dirName = profileDirName(slug);
    const active = activeBySlug.get(slug) ?? null;
    let state = persistenceEnabled ? 'available' : 'disabled';
    if (active) {
      state = 'in-use-here';
    } else if (persistenceEnabled && profilesRoot) {
      const lockPath = path.join(profilesRoot, `${dirName}.lock`);
      const lockState = await readLockMeta(lockPath).catch(() => ({ missing: true }));
      if (!lockState.missing) {
        if (lockState.pid > 0 && pidAlive(lockState.pid)) {
          state = 'in-use-other';
        } else if (lockState.empty || lockState.corrupt || lockState.pid === 0) {
          const info = await stat(lockPath).catch(() => null);
          if (info && Date.now() - info.mtimeMs < FRESH_EMPTY_LOCK_MS) state = 'in-use-other';
        }
      }
    }
    profiles.push({
      profile: slug,
      directoryName: dirName,
      isDefault: slug === 'default',
      existsOnDisk: onDisk.has(slug),
      state,
      sessionId: active?.sessionId ?? null,
      sessionName: active?.sessionName ?? null,
      ...(active?.runtimeState ? { runtimeState: active.runtimeState } : {}),
      tabCount: active?.tabCount ?? 0,
    });
  }
  return profiles;
}
