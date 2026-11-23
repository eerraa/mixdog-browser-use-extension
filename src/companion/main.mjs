import { app } from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { BrowserHost } from '../browser/host.mjs';
import { configureBrowserIdentity } from '../browser/user-agent.mjs';
import { resolveAutomationMode } from '../shared/preferences.mjs';
import { automationMode, connectionPaths, pluginData, validChannel } from '../shared/paths.mjs';
import { createCompanionServer } from './server.mjs';

const root = path.resolve(path.dirname(process.argv[1]), '..');
const channel = process.env.WB_CHANNEL;
const key = process.env.WB_IPC_KEY;
const lazyInit = process.env.WB_LAZY_INIT === '1';
const envAutomationMode = automationMode();
const dataRoot = pluginData();
const paths = connectionPaths(dataRoot, channel);

const userData = path.join(paths.directory, 'electron');
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setName('Independent Windows Browser');
configureBrowserIdentity(app);
// The companion lives as long as its MCP connection. Without this listener
// Electron quits when the last page window closes, which would end the
// connection for every later call; gateway shutdown and revocation end it.
app.on('window-all-closed', () => {});

const server = createCompanionServer({
  root,
  channel,
  key,
  pipe: paths.pipe,
  dataRoot,
  lazyInit,
  onExit: code => app.exit(code),
  buildHost: ({ policy, prefs, connectionId = null }) => {
    const resolvedMode = resolveAutomationMode({ envMode: envAutomationMode, policy, prefs });
    return new BrowserHost({
      dataDir: paths.directory,
      dataRoot,
      connectionId: validChannel(connectionId) ? connectionId : null,
      consentHelperPath: path.join(root, 'bin', 'native-consent.exe'),
      toolbarPreloadPath: path.join(root, 'app', 'toolbar-preload.cjs'),
      runnerPreloadPath: path.join(root, 'app', 'runner-preload.cjs'),
      policy,
      automationMode: resolvedMode.mode,
      automationModeSource: resolvedMode.source,
      automationModePinned: resolvedMode.pinned,
      automationPreferenceReason: resolvedMode.preferenceReason,
      onRevokeConnection: () => server.terminate('permission-revocation'),
    });
  },
});

app.whenReady().then(() => server.start()).catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
