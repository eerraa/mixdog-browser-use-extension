import { app, BrowserWindow, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BrowserHost } from '../../src/browser/host.mjs';
import { FrameDriver } from '../../src/browser/frames.mjs';
import { fileURLToPath } from 'node:url';
import { presentationOf, toolbarPreloadPath } from './presentation.mjs';

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
const checkpoint = FrameDriver.prototype.checkpoint;
const message = FrameDriver.prototype.onMessage;
const drivers = [];
FrameDriver.prototype.start = async function() {
  drivers.push(this);
  this.diagnostic = { checkpoints: [], events: [], captures: [] };
  const capturePage = this.wc.capturePage.bind(this.wc);
  this.wc.capturePage = async (...args) => {
    const record = { before: coverage(this.wc) };
    this.diagnostic.captures.push(record);
    if (this.injectCaptureAt === this.diagnostic.captures.length) {
      await this.wc.debugger.sendCommand('Runtime.evaluate', {
        expression: 'document.body.setAttribute("data-fixture-checkpoint","changed")', returnByValue: true,
      });
    }
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
FrameDriver.prototype.checkpoint = async function(frame) {
  const result = await checkpoint.call(this, frame);
  this.diagnostic.checkpoints.push({ frameId: frame.id, contextId: frame.contextId, ...result,
    viewBounds: this.page.view.getBounds(), hostStamp: this.page.stamp, hostChange: this.page.lastChange });
  return result;
};
FrameDriver.prototype.onMessage = function(method, params, sessionId) {
  if (method.startsWith('Page.frame') || method === 'Runtime.executionContextsCleared'
    || (method === 'Runtime.bindingCalled' && params.name === '__independentChanged')) {
    this.diagnostic?.events.push({ method, sessionId: sessionId || null,
      payload: method === 'Runtime.bindingCalled' ? params.payload : undefined });
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
    const result = await host.execute({ action: 'open', url }, caller);
    console.log('OPEN_RESULT', JSON.stringify({ tabId: result.tabId, disposition: result.disposition, code: result.code }));
    if (result.disposition === 'uncertain') {
      console.log('DIAGNOSTIC', JSON.stringify(drivers[0].diagnostic));
      const recovered = await host.execute({ action: 'observe', tabId: result.tabId }, caller);
      console.log('RECOVERY', recovered.disposition);
    }
    console.log('VIEWPORT_EVIDENCE', JSON.stringify({
      capture: drivers[0].diagnostic.captures[0], firstCheckpoint: drivers[0].diagnostic.checkpoints[0],
    }));
    const assertPixel = (observation, bgr) => {
      const png = observation.screenshot;
      const image = nativeImage.createFromBuffer(Buffer.from(png.data, 'base64')).toBitmap();
      const x = Math.round(820 * png.pixelsPerCssX), y = Math.round(40 * png.pixelsPerCssY);
      assert.deepEqual([...image.subarray((y * png.pixelWidth + x) * 4, (y * png.pixelWidth + x) * 4 + 3)], bgr);
    };
    assertPixel(result, [0, 0, 220]);
    assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT_PASSWORD'), false);
    drivers[0].injectCaptureAt = drivers[0].diagnostic.captures.length + 1;
    const changed = await host.execute({ action: 'evaluate', tabId: result.tabId,
      expression: 'document.querySelector("#paint").style.background="rgb(0,190,0)";document.querySelector("output").textContent=String(Number(document.querySelector("output").textContent)+1)' }, caller);
    console.log('CONTROLLED_CHANGE', JSON.stringify({ disposition: changed.disposition, code: changed.code }));
    assert.equal(changed.disposition, 'uncertain');
    assert.equal(changed.code, 'STALE_OBSERVATION');
    assert.equal(changed.replaySafe, false);
    const recovery = await host.execute({ action: 'observe', tabId: changed.tabId }, caller);
    assert.equal(recovery.disposition, 'observed');
    assertPixel(recovery, [0, 190, 0]);
    assert.equal(JSON.stringify(recovery).includes('DO_NOT_EXPORT_PASSWORD'), false);
    console.log('ONE_OBSERVE_RECOVERY', recovery.disposition);
    assert.equal(await drivers[0].wc.executeJavaScript('document.querySelector("output").textContent'), '1');
    console.log('EFFECT_COUNT', 1);
    assert.equal(result.disposition, 'observed', 'Initial native capture still uncertain even though explicit observe recovery succeeded');
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
