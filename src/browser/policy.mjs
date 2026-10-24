import { readFile } from 'node:fs/promises';
import path from 'node:path';

const supported = Object.freeze(['hid', 'usb', 'notifications', 'geolocation']);
const delegatedFields = new Set(['version', 'mode', 'permissions', 'origins', 'selection', 'lifetime', 'newGrants']);

// A trusted package/host configuration, never an MCP argument or chat receipt.
// The companion loads one immutable snapshot before it admits tool calls.
export class BrowserPolicy {
  constructor(value, problem) {
    this.mode = 'disabled';
    this.permissions = Object.freeze([]);
    this.reason = problem ?? 'No browser delegation policy was supplied';
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const fields = Object.keys(value);
      if (value.version === 1 && ['manual', 'disabled'].includes(value.mode)
        && fields.every(key => ['version', 'mode'].includes(key))) {
        this.mode = value.mode;
        this.reason = value.mode === 'manual' ? 'Protected requests require native human selection' : 'Delegated protected requests are disabled';
      } else if (value.version === 1 && value.mode === 'delegated'
        && fields.length === delegatedFields.size && fields.every(key => delegatedFields.has(key))
        && Array.isArray(value.permissions) && value.permissions.length > 0
        && value.permissions.every(kind => supported.includes(kind))
        && new Set(value.permissions).size === value.permissions.length
        && value.origins === 'owned-pages' && value.selection === 'offered-option'
        && value.lifetime === 'caller-generation' && value.newGrants === true) {
        this.mode = 'delegated';
        this.permissions = Object.freeze([...value.permissions]);
        this.reason = 'Origin and offered-option choice delegated to live authenticated owners of their pages';
      } else this.reason = 'Malformed or unsupported browser delegation policy';
    }
    Object.freeze(this);
  }
  static manual() { return new BrowserPolicy({ version: 1, mode: 'manual' }); }
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
  describe() {
    return {
      mode: this.mode, permissions: [...this.permissions], reason: this.reason,
      origins: 'agent-owned pages', selection: 'explicit offered option',
      lifetime: 'current authenticated caller generation and connection',
      newGrants: this.mode === 'delegated',
      hardwareConfinement: 'Chromium origin/session grants; not document-exclusive or technically read-only',
    };
  }
}
