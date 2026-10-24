import assert from 'node:assert/strict';
import { BrowserWindow, webContents } from 'electron';
import { fileURLToPath } from 'node:url';

// Test-only structural probes of the single-window presentation. A page is a
// WebContentsView inside its frame window: children are [page view, shield view]
// and the frame's own webContents is the trusted toolbar document.
export const toolbarPreloadPath = fileURLToPath(new URL('../../src/browser/toolbar-preload.cjs', import.meta.url));

export function frameOf(contents) {
  return BrowserWindow.getAllWindows().find(window => !window.isDestroyed()
    && window.contentView.children.some(view => view.webContents === contents));
}
export function pageContents(match) {
  const matches = typeof match === 'function' ? match : url => url === match;
  const pages = webContents.getAllWebContents().filter(contents => !contents.isDestroyed()
    && !contents.getURL().startsWith('data:') && matches(contents.getURL()) && frameOf(contents));
  assert.equal(pages.length, 1, `Expected exactly one owned page for ${match}`);
  return pages[0];
}
export function presentationOf(contents) {
  const frame = frameOf(contents);
  assert.ok(frame, 'The page must be hosted by a frame window');
  const [view, shieldView, ...rest] = frame.contentView.children;
  assert.equal(rest.length, 0, 'A frame hosts only the page view and its shield');
  assert.equal(view.webContents, contents, 'The page view must stay below its shield');
  return { frame, view, shieldView, toolbar: frame.webContents, shield: shieldView.webContents };
}
// Automation: the visible frame shows the page only beneath a shield of
// identical bounds, so OS input cannot reach the page, and it is never focused.
export function assertShielded(contents, label = 'automation page') {
  const { frame, view, shieldView } = presentationOf(contents);
  assert.equal(frame.isVisible(), true, `${label}: frame must be visible`);
  assert.equal(shieldView.getVisible(), true, `${label}: shield must cover the page`);
  assert.deepEqual(shieldView.getBounds(), view.getBounds(), `${label}: shield bounds must equal page bounds`);
  assert.equal(contents.isFocused(), false, `${label}: page must not be focused`);
}
// Native handoff: the shield is removed from the same live page.
export function assertNative(contents, label = 'native handoff page') {
  const { frame, shieldView } = presentationOf(contents);
  assert.equal(frame.isVisible(), true, `${label}: frame must stay visible`);
  assert.equal(shieldView.getVisible(), false, `${label}: shield must be hidden`);
}
export function menu(frame, label) {
  return frame.__independentBrowserTestMenu.items.find(item => item.label === label).click();
}

export function toolbarState(toolbar) {
  return toolbar.executeJavaScript(`(()=>{
    const $=id=>document.getElementById(id), action=b=>b.hidden?null:b.dataset.action;
    return {address:$('address').value,readOnly:$('address').readOnly,back:$('back').disabled,
      forward:$('forward').disabled,reload:$('reload').disabled,tone:$('chip').dataset.tone,
      primary:action($('primary')),secondary:action($('secondary'))};
  })()`);
}
// Actual pointer input to the toolbar document at the enabled control's centre.
export async function clickToolbar(toolbar, selector) {
  const point = await toolbar.executeJavaScript(`(()=>{
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element||element.hidden||element.disabled)return null;
    const r=element.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
  })()`);
  assert.ok(point, `Toolbar control ${selector} must be present and enabled`);
  toolbar.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  toolbar.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
}
export function pressToolbar(toolbar, keyCode, modifiers = []) {
  toolbar.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  toolbar.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}
