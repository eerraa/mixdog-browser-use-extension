// Pure-Node companion entry point for the Camoufox engine (zero Electron GUI
// process spawned). Launched by `bin/bridge.exe --browser` under
// ELECTRON_RUN_AS_NODE=1 inside the launcher's kill-on-close Job object.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { CamoufoxHost } from '../browser/camoufox/host.mjs';
import { resolveAutomationMode } from '../shared/preferences.mjs';
import { authorityMode, automationMode, camoufoxExecutable, connectionPaths, persistentProfilesEnabled, pluginData, validChannel } from '../shared/paths.mjs';
import { createCompanionServer } from './server.mjs';

const root = path.resolve(path.dirname(process.argv[1]), '..');
const channel = process.env.WB_CHANNEL;
const key = process.env.WB_IPC_KEY;
const lazyInit = process.env.WB_LAZY_INIT === '1';
const authMode = authorityMode();
const dataRoot = pluginData();
const envAutomationMode = automationMode();
const paths = connectionPaths(dataRoot, channel);
mkdirSync(paths.directory, { recursive: true });

const camoufox = camoufoxExecutable(root);
const headless = process.env.WB_HEADLESS === '1' || process.env.WB_HEADLESS === 'true';
const usePersistent = persistentProfilesEnabled(authMode);
const profilesRoot = path.join(dataRoot, 'profiles');

const server = createCompanionServer({
  root,
  channel,
  key,
  pipe: paths.pipe,
  dataRoot,
  lazyInit,
  onExit: code => process.exit(code),
  buildHost: ({ policy, prefs, connectionId = null }) => {
    const resolvedMode = resolveAutomationMode({ envMode: envAutomationMode, policy, prefs });
    return new CamoufoxHost({
      dataDir: paths.directory,
      dataRoot,
      connectionId: validChannel(connectionId) ? connectionId : null,
      profilesRoot,
      persistentProfilesEnabled: usePersistent,
      authorityMode: authMode,
      executablePath: camoufox.executablePath,
      camoufoxVersion: camoufox.version,
      policy,
      automationMode: resolvedMode.mode,
      automationModeSource: resolvedMode.source,
      automationModePinned: resolvedMode.pinned,
      automationPreferenceReason: resolvedMode.preferenceReason,
      headless,
      onRevokeConnection: () => server.terminate('permission-revocation'),
    });
  },
});

server.start().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
