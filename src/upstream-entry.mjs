export { browserRefPointExpression } from '../vendor/mixdog/apps/desktop/src/main/browser/snapshot-scripts.ts';
export { rankBrowserSemanticMatch } from '../vendor/mixdog/apps/desktop/src/main/browser/semantic-query.ts';
export {
  BrowserActionabilityError,
  waitForBrowserActionable,
} from '../vendor/mixdog/apps/desktop/src/main/browser/actionability.ts';
export { createBrowserCdpExecution } from '../vendor/mixdog/apps/desktop/src/main/browser/cdp-execution.ts';
export { BROWSER_STABLE_RECT } from '../vendor/mixdog/apps/desktop/src/main/browser/stable-rect.ts';
// Role, name and state functions extracted from the vendored
// snapshot-scripts.ts at build time (scripts/build.mjs, walker.mjs).
export { PERCEPTION_UPSTREAM } from 'independent-browser:perception-upstream';
