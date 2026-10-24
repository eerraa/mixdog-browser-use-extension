// Configure only the separately owned companion, immediately after app.setName
// and before sessions/WebContents exist. Keep the bundled engine and OS values.
export function configureBrowserIdentity(app) {
  app.userAgentFallback = app.userAgentFallback
    .replace(/ (?:IndependentWindowsBrowser|Electron)\/\S+/g, '');
}
