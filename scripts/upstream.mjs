import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(resolve(root, 'upstream.lock.json'), 'utf8'));
// These are untouched, content-verified upstream artifacts, not an old plugin
// checkout or an import of Mixdog's runtime/agent infrastructure.
for (const [path, expected] of Object.entries(lock.files)) {
  const response = await fetch(
    `https://raw.githubusercontent.com/tribgames/mixdog/${lock.commit}/${path}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error(`Upstream ${path}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Upstream integrity mismatch: ${path}`);
  const destination = resolve(root, 'vendor/mixdog', path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  console.log(`Verified upstream artifact: ${path}`);
}
