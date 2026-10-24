import { build } from 'esbuild';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptSdkCancellation } from './sdk-adapter.mjs';
import { extractUpstreamSources } from '../src/browser/perception/walker.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotScripts = resolve(root, 'vendor/mixdog/apps/desktop/src/main/browser/snapshot-scripts.ts');
const shim = {
  name: 'explicit-browser-host-adapters',
  setup(builder) {
    // The perception walker's role, accessible-name and state functions come
    // from the pinned vendored source; extraction throws when they moved.
    builder.onResolve({ filter: /^independent-browser:perception-upstream$/ }, args => ({ path: args.path, namespace: 'perception-upstream' }));
    builder.onLoad({ filter: /.*/, namespace: 'perception-upstream' }, async () => ({
      contents: `// Extracted from ${JSON.stringify('vendor/mixdog/apps/desktop/src/main/browser/snapshot-scripts.ts')}; changed: accessible names from rendered text only (no textContent).\n`
        + `export const PERCEPTION_UPSTREAM = Object.freeze(${JSON.stringify(extractUpstreamSources(await readFile(snapshotScripts, 'utf8')))});`,
      loader: 'js', resolveDir: root, watchFiles: [snapshotScripts],
    }));
    builder.onResolve({ filter: /^\.\/(settle|command)$/ }, args => {
      if (!args.importer.replace(/\\/g, '/').includes('vendor/mixdog/')) return;
      return { path: args.path, namespace: 'browser-adapter' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'browser-adapter' }, args => ({
      contents: args.path === './command'
        ? 'export const CDP_REQUEST_TIMEOUT_MS = 15000;'
        : `export { pause } from ${JSON.stringify(resolve(root, 'src/async.mjs'))};`,
      resolveDir: root,
      loader: 'js',
    }));
    builder.onLoad({ filter: /stable-rect\.ts$/ }, async args => {
      const original = await readFile(args.path, 'utf8');
      const scrolling = `  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  for (const frame of frames) {
    frame.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }
`;
      if (original.split(scrolling).length !== 2) throw new Error('Upstream preparation adapter no longer applies exactly once');
      return {
        contents: '// Changed: host-owned target preparation; geometry measurement must not scroll.\n' + original.replace(scrolling, ''),
        loader: 'ts', resolveDir: dirname(args.path),
      };
    });
  },
};
await build({
  absWorkingDir: root,
  entryPoints: ['src/upstream-entry.mjs'],
  outfile: 'build/upstream.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  plugins: [shim],
  banner: {
    js: '// Derived from Mixdog 968ee08965e75c3fa1999ab8d18d20e45229fc89, Apache-2.0.\n'
      + '// Changed: standalone host shims, host-managed target preparation, mutation-free geometry measurement,\n'
      + '// role/name/state functions extracted for the perception walker, accessible names from rendered text only.\n'
      + '// Untouched source, LICENSE and NOTICE are shipped under vendor/mixdog/.',
  },
});
console.log('Built isolated browser observation and input-fence adapters.');
const sdkPath = resolve(root, 'node_modules/@modelcontextprotocol/sdk');
const sdkVersion = JSON.parse(await readFile(resolve(sdkPath, 'package.json'), 'utf8')).version;
const sdkProtocol = resolve(sdkPath, 'dist/esm/shared/protocol.js');
const sdkPatch = {
  name: 'pinned-sdk-cancellation-zero',
  setup(builder) {
    builder.onLoad({ filter: new RegExp(`^${sdkPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/].*\\.js$`) }, async args => {
      // The published SDK maps omit their TypeScript sources. Embed the real
      // JavaScript compilation inputs instead of chaining those incomplete maps.
      const source = (await readFile(args.path, 'utf8')).replace(/^\/\/# sourceMappingURL=.*$/gm, '');
      return {
        contents: args.path === sdkProtocol ? adaptSdkCancellation(source, sdkVersion) : source,
        loader: 'js', resolveDir: dirname(args.path),
      };
    });
  },
};
const bundleInputs = new Set();
for (const [entry, name] of [['src/mcp.mjs', 'mcp'], ['src/hook.mjs', 'hook'], ['src/companion-main.mjs', 'companion']]) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], outfile: `build/app/${name}.cjs`,
    bundle: true, format: 'cjs', platform: 'node', target: 'node22',
    external: ['electron'], sourcemap: true, metafile: true, plugins: [sdkPatch],
    banner: { js: '/*! Independent Windows Browser. See ../THIRD_PARTY_NOTICES.md. Browser derivatives: Mixdog 968ee08965e75c3fa1999ab8d18d20e45229fc89, Apache-2.0. Changes: standalone host/abort adapters, host-managed target preparation, extracted role/name/state functions for the perception walker. */' },
  });
  for (const input of Object.keys(result.metafile.inputs)) bundleInputs.add(input);
}
await writeFile(resolve(root, 'build/bundle-inputs.json'), JSON.stringify([...bundleInputs].sort(), null, 2));
// The sandboxed toolbar and script-runner preloads are standalone scripts.
await copyFile(resolve(root, 'src/browser/toolbar-preload.cjs'), resolve(root, 'build/app/toolbar-preload.cjs'));
await copyFile(resolve(root, 'src/browser/runner/preload.cjs'), resolve(root, 'build/app/runner-preload.cjs'));
console.log('Built independent MCP, host-hook and companion entry points and the toolbar and runner preloads.');
