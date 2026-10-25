import { build } from 'esbuild';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptSdkCancellation } from './sdk-adapter.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
    banner: { js: '/*! Independent Windows Browser. See ../THIRD_PARTY_NOTICES.md. Includes code forked from Mixdog 1.3.4 (968ee08965e75c3fa1999ab8d18d20e45229fc89), Apache-2.0; Mixdog changes after that commit are not tracked. */' },
  });
  for (const input of Object.keys(result.metafile.inputs)) bundleInputs.add(input);
}
await writeFile(resolve(root, 'build/bundle-inputs.json'), JSON.stringify([...bundleInputs].sort(), null, 2));
// The sandboxed toolbar and script-runner preloads are standalone scripts.
await copyFile(resolve(root, 'src/browser/toolbar-preload.cjs'), resolve(root, 'build/app/toolbar-preload.cjs'));
await copyFile(resolve(root, 'src/browser/runner/preload.cjs'), resolve(root, 'build/app/runner-preload.cjs'));
console.log('Built independent MCP, host-hook and companion entry points and the toolbar and runner preloads.');
