import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BrowserHost } from '../../src/browser/host.mjs';
import { FrameDriver } from '../../src/browser/frames.mjs';
import { fileURLToPath } from 'node:url';
import { pixelAt, presentationOf, rendered, toolbarPreloadPath } from './presentation.mjs';

const dataDir = process.argv[2], url = process.argv[3];
app.setPath('userData', path.join(dataDir, 'electron'));
// The frame menu is installed right after the page view and its shield are
// attached, before the page loads anything: count every page focus from then on.
const pageExposure = new WeakMap();
const setMenu = BrowserWindow.prototype.setMenu;
BrowserWindow.prototype.setMenu = function(menu) {
  const page = this.contentView.children[0]?.webContents;
  if (page && !pageExposure.has(page)) {
    const record = { pageFocuses: 0, frameShows: 0 };
    pageExposure.set(page, record);
    page.on('focus', () => { record.pageFocuses++; });
    this.on('show', () => { record.frameShows++; });
  }
  return setMenu.call(this, menu);
};
const coverage = contents => {
  const { frame, view, shieldView } = presentationOf(contents);
  return { frameVisible: frame.isVisible(), shieldVisible: shieldView.getVisible(), viewBounds: view.getBounds(),
    shieldBounds: shieldView.getBounds(), pageFocused: contents.isFocused() };
};
const start = FrameDriver.prototype.start;
const message = FrameDriver.prototype.onMessage;
const drivers = [];
FrameDriver.prototype.start = async function() {
  drivers.push(this);
  this.diagnostic = { events: [], captures: [] };
  const capturePage = this.wc.capturePage.bind(this.wc);
  this.wc.capturePage = async (...args) => {
    const record = { before: coverage(this.wc) };
    this.diagnostic.captures.push(record);
    try {
      const image = await capturePage(...args);
      // Captures come from the visible page view only while its shield covers
      // it exactly and the page has never held keyboard focus.
      const after = coverage(this.wc);
      for (const state of [record.before, after]) {
        assert.equal(state.frameVisible, true, 'Capture requires the visible frame');
        assert.equal(state.shieldVisible, true, 'Capture requires the shield over the page');
        assert.deepEqual(state.shieldBounds, state.viewBounds, 'Shield must cover exactly the page view');
        assert.equal(state.pageFocused, false, 'Page must not be focused during capture');
      }
      const exposure = pageExposure.get(this.wc);
      assert.equal(exposure.pageFocuses, 0, 'Page must never receive focus during startup/capture');
      assert.equal(exposure.frameShows, 1, 'The frame is shown exactly once, at startup');
      record.exposure = { ...exposure };
      record.after = after;
      return image;
    } catch (error) {
      record.error = error.message; // private local fixture: native capture error, never page contents
      throw error;
    }
  };
  return start.call(this);
};
FrameDriver.prototype.onMessage = function(method, params, sessionId) {
  if (method.startsWith('Page.frame') || method === 'Runtime.executionContextsCleared') {
    this.diagnostic?.events.push({ method, sessionId: sessionId || null });
  }
  return message.call(this, method, params, sessionId);
};
async function run() {
  let host;
  try {
    await app.whenReady();
    host = new BrowserHost({
      dataDir: path.join(dataDir, 'profiles'),
      consentHelperPath: fileURLToPath(new URL('../../build/native-consent.exe', import.meta.url)),
      toolbarPreloadPath,
      onRevokeConnection: () => { throw new Error('No revocation in observation fixture'); },
    });
    const caller = { sessionId: 'fixture-owner', callId: 'first-open', signal: new AbortController().signal, assertLive() {} };
    const result = await host.execute({ action: 'open', url, screenshot: true }, caller);
    console.log('OPEN_RESULT', JSON.stringify({ tabId: result.tabId, disposition: result.disposition, observed: result.observed, cause: result.cause }));
    console.log('OPEN_TEXT', JSON.stringify(rendered(result)));
    // The first open is one executed step with its page: no uncertainty, no
    // recovery observe, no repeated navigation.
    assert.equal(result.disposition, 'executed');
    assert.equal(result.observed, undefined, 'the first result carries its observation');
    assert.match(rendered(result), /\npage "Local MCP fixture" http:\/\/127\.0\.0\.1:\d+\/fixture\?connection=/);
    assert.deepEqual(pixelAt(result.screenshot, 820, 40), [0, 0, 220]);
    assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT_PASSWORD'), false);
    const { frame } = presentationOf(drivers[0].wc);
    assert.equal(frame.isFocused(), false, 'An agent window opens without taking focus');
    // Page code is refused beside the filled password; clearing it is an ordinary fill.
    const password = rendered(result).match(/(e\d+) textbox(?: "[^"]*")? sensitive(?=\n|$)/m)[1];
    await host.execute({ action: 'fill', tabId: result.tabId, ref: password, text: '', snapshot: 'none' }, caller);
    // A page change made by the action is simply part of its result.
    const changed = await host.execute({ action: 'evaluate', tabId: result.tabId, screenshot: true,
      expression: 'document.querySelector("#paint").style.background="rgb(0,190,0)";document.querySelector("output").textContent=String(Number(document.querySelector("output").textContent)+1)' }, caller);
    console.log('CONTROLLED_CHANGE', JSON.stringify(rendered(changed)));
    assert.equal(changed.disposition, 'executed');
    assert.match(rendered(changed), /status ="1"/, 'the output change is in the action diff');
    assert.deepEqual(pixelAt(changed.screenshot, 820, 40), [0, 190, 0]);
    assert.equal(JSON.stringify(changed).includes('DO_NOT_EXPORT_PASSWORD'), false);
    assert.equal(await drivers[0].wc.executeJavaScript('document.querySelector("output").textContent'), '1');
    console.log('EFFECT_COUNT', 1);
    console.log('CAPTURES', JSON.stringify(drivers[0].diagnostic.captures.length));
    await host.close();
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    console.log('DIAGNOSTICS', JSON.stringify(drivers.map(driver => driver.diagnostic)));
    await host?.close();
    app.exit(1);
  }
}
void run();
