import { readFile } from 'node:fs/promises';
import path from 'node:path';

const supported = Object.freeze(['hid', 'usb', 'notifications', 'geolocation']);
const delegatedFields = ['version', 'mode', 'permissions', 'origins', 'selection', 'lifetime', 'newGrants'];
const delegatedAllowed = new Set([...delegatedFields, 'automationMode', 'engine']);
const simpleAllowed = new Set(['version', 'mode', 'automationMode', 'engine']);
const automationModes = new Set(['standard', 'elevated']);
const engines = new Set(['camoufox', 'electron']);

export const ELECTRON_LIST_PROFILES = Object.freeze({
  supported: false,
  engine: 'electron',
  reason: 'Named persistent profiles require the default Camoufox engine; Electron supports only temporary sessions',
  profiles: Object.freeze([]),
});

// Shared capability snapshot for both live Electron BrowserHost.status() and
// cold connection-authority gateway status() before Electron is lazily started.
export function electronCapabilities({
  policy,
  automationMode = 'standard',
  configuredAutomationMode = automationMode,
  automationModeSource = 'default',
  automationModePinned = false,
  automationPreferenceReason = null,
  maxTemporarySessions = 16,
}) {
  const elevated = automationMode === 'elevated';
  return {
    engine: 'electron',
    automation: {
      mode: automationMode,
      configuredMode: configuredAutomationMode,
      source: automationModeSource,
      pinned: automationModePinned,
      ...(automationPreferenceReason ? { preferenceReason: automationPreferenceReason } : {}),
      scope: elevated
        ? 'connection-wide opt-in: login and sensitive fill/type/click/observe permitted without shield auto-handoff'
        : 'standard safety boundary: shield click/key triggers handoff; human handles sign-in and secrets',
      shieldAutoHandoff: !elevated,
      sensitiveInputAllowed: elevated,
      sensitiveValuesMasked: true,
      pageCodeBlockedBesideSecrets: true,
      manualHandoffRequiredFor: ['OS identity', 'CAPTCHA', 'human verification'],
      revocableByUser: true,
    },
    sessions: { temporary: true, namedPersistentProfiles: false, maxCreatedPerCaller: maxTemporarySessions, defaultClosable: false },
    nativeRequests: ['javascript-dialog', 'file-picker', 'hid', 'usb', 'notifications', 'geolocation'],
    javascriptDialogs: {
      supported: ['alert', 'confirm'],
      unsupported: { prompt: 'Electron 44.9.1 overrides window.prompt() and throws before native dialog creation.' },
      integration: 'Companion-local public-module adapter pinned to Electron 44.9.1; not a documented interception API',
    },
    filePickers: {
      supported: ['html-file-input'],
      unsupported: ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'],
    },
    unsupported: ['display-capture', 'serial', 'bluetooth', 'javascript-prompt'],
    mandatoryHuman: elevated
      ? ['OS identity', 'CAPTCHA', 'human Resume in the browser window after Stop/handoff']
      : ['OS identity', 'passwords', 'CAPTCHA', '2FA', 'human Resume in the browser window after Stop/handoff'],
    delegation: policy.describe('electron'),
  };
}

// A trusted package/host configuration, never an MCP argument or chat receipt.
// The companion loads one immutable snapshot before it admits tool calls.
export class BrowserPolicy {
  #raw;
  #problem;

  constructor(value, problem) {
    this.#raw = value && typeof value === 'object' ? structuredClone(value) : value ?? null;
    this.#problem = typeof problem === 'string' ? problem : null;
    this.valid = false;
    this.mode = 'disabled';
    this.permissions = Object.freeze([]);
    this.automationMode = 'standard';
    this.explicitAutomationMode = false;
    this.engine = 'camoufox';
    this.explicitEngine = false;
    this.reason = problem ?? 'No browser delegation policy was supplied';
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const fields = Object.keys(value);
      const hasAutomationMode = Object.hasOwn(value, 'automationMode');
      const validAutomationMode = !hasAutomationMode || automationModes.has(value.automationMode);
      const hasEngine = Object.hasOwn(value, 'engine');
      const validEngine = !hasEngine || engines.has(value.engine);
      if (validAutomationMode && validEngine && value.version === 1 && ['manual', 'disabled'].includes(value.mode)
        && fields.every(key => simpleAllowed.has(key))) {
        this.valid = true;
        this.mode = value.mode;
        this.automationMode = hasAutomationMode ? value.automationMode : 'standard';
        this.explicitAutomationMode = hasAutomationMode;
        this.engine = hasEngine ? value.engine : 'camoufox';
        this.explicitEngine = hasEngine;
        this.reason = value.mode === 'manual' ? 'Protected requests require native human selection' : 'Delegated protected requests are disabled';
      } else if (validAutomationMode && validEngine && value.version === 1 && value.mode === 'delegated'
        && delegatedFields.every(key => Object.hasOwn(value, key))
        && fields.every(key => delegatedAllowed.has(key))
        && Array.isArray(value.permissions) && value.permissions.length > 0
        && value.permissions.every(kind => supported.includes(kind))
        && new Set(value.permissions).size === value.permissions.length
        && value.origins === 'owned-pages' && value.selection === 'offered-option'
        && value.lifetime === 'caller-generation' && value.newGrants === true) {
        this.valid = true;
        this.mode = 'delegated';
        this.permissions = Object.freeze([...value.permissions]);
        this.automationMode = hasAutomationMode ? value.automationMode : 'standard';
        this.explicitAutomationMode = hasAutomationMode;
        this.engine = hasEngine ? value.engine : 'camoufox';
        this.explicitEngine = hasEngine;
        this.reason = 'Origin and offered-option choice delegated to live authenticated owners of their pages';
      } else this.reason = 'Malformed or unsupported browser delegation policy';
    }
    Object.freeze(this);
  }
  static manual() { return new BrowserPolicy({ version: 1, mode: 'manual' }); }
  static fromSnapshot(snapshot) {
    return new BrowserPolicy(snapshot?.value ?? null, typeof snapshot?.problem === 'string' ? snapshot.problem : undefined);
  }
  toSnapshot() {
    return { value: this.#raw ? structuredClone(this.#raw) : null, problem: this.#problem };
  }
  static async load(root) {
    try {
      return new BrowserPolicy(JSON.parse(await readFile(path.join(root, 'browser-policy.json'), 'utf8')));
    } catch (error) {
      const reason = error instanceof SyntaxError ? 'browser-policy.json is malformed JSON'
        : `browser-policy.json could not be read (${error.code})`;
      return new BrowserPolicy(null, reason);
    }
  }
  permits(kind) { return this.mode === 'delegated' && this.permissions.includes(kind); }
  describe(effectiveEngine = this.engine) {
    const engine = effectiveEngine === 'camoufox' || effectiveEngine === 'electron' ? effectiveEngine : this.engine;
    return {
      mode: this.mode, permissions: [...this.permissions], reason: this.reason,
      automationMode: this.automationMode, engine,
      ...(engine !== this.engine ? { configuredEngine: this.engine } : {}),
      origins: 'agent-owned pages', selection: 'explicit offered option',
      lifetime: 'current authenticated caller generation and connection',
      newGrants: this.mode === 'delegated',
      hardwareConfinement: 'Chromium origin/session grants; not document-exclusive or technically read-only',
    };
  }
}
