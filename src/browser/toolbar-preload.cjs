'use strict';
// Trusted toolbar controller of a plugin-owned browser window. It runs only in
// this toolbar document's isolated preload world and exposes nothing to any
// page world. It renders state from the main process and sends fixed action
// names; the main process enforces every mode rule for those actions.
const { ipcRenderer } = require('electron');

const ACTION = 'independent-browser:toolbar';
const STATE = 'independent-browser:state';

window.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const address = $('address');
  let state = null;
  const send = (action, value, extra = null) => ipcRenderer.send(ACTION, {
    action,
    ...(value === undefined ? {} : { value }),
    ...(extra ?? {}),
  });
  const label = (element, text) => { element.title = text; element.setAttribute('aria-label', text); };
  const actionButton = (button, spec) => {
    if (!button) return;
    button.hidden = !spec;
    button.textContent = spec?.text ?? '';
    button.dataset.action = spec?.action ?? '';
    button.dataset.targetId = spec?.targetId ?? '';
    button.title = spec?.title ?? '';
    if (spec?.title) button.setAttribute('aria-label', spec.title);
    else button.removeAttribute('aria-label');
  };
  const render = () => {
    if (!state) return;
    const session = state.browserSession;
    $('session').textContent = session ? `${session.name} (${session.id})` : '';
    $('session').title = $('session').textContent;
    $('back').disabled = !state.canGoBack;
    $('forward').disabled = !state.canGoForward;
    $('reload').disabled = !state.navigable;
    label($('reload'), state.reloadTitle);
    $('reload-icon').hidden = state.loading;
    $('stop-icon').hidden = !state.loading;
    document.body.classList.toggle('loading', state.loading);
    address.readOnly = !state.editable;
    // Never overwrite text the person is still editing.
    if (document.activeElement !== address || !state.editable) address.value = state.url;
    $('security').hidden = !state.url;
    $('security').dataset.secure = String(state.secure);
    label($('security'), state.securityTitle);
    $('omnibox').classList.toggle('invalid', state.invalid);
    $('notice').textContent = state.notice ?? '';
    $('notice').title = state.notice ?? '';
    if ($('agent-bar')) $('agent-bar').dataset.tone = state.chip.tone;
    $('chip').textContent = state.chip.text;
    $('chip').dataset.tone = state.chip.tone;
    $('chip').title = state.chip.title ?? '';
    actionButton($('primary'), state.primary);
    actionButton($('return-all'), state.returnAll);
    actionButton($('secondary'), state.secondary);
    actionButton($('elevate'), state.elevate);
    actionButton($('elevated'), state.elevated);
    actionButton($('disconnect'), state.disconnect);
  };
  for (const id of ['back', 'forward']) $(id).addEventListener('click', () => send(id));
  $('reload').addEventListener('click', () => send(state?.loading ? 'stop-loading' : 'reload'));
  for (const id of ['primary', 'return-all', 'secondary', 'elevated']) {
    const btn = $(id);
    if (!btn) continue;
    btn.addEventListener('click', event => {
      const action = event.currentTarget.dataset.action;
      const targetId = event.currentTarget.dataset.targetId || undefined;
      if (action) send(action, targetId);
    });
  }
  for (const id of ['elevate', 'disconnect']) {
    const btn = $(id);
    if (!btn) continue;
    btn.addEventListener('click', event => {
      if (!event.isTrusted) return;
      const action = event.currentTarget.dataset.action;
      if (action) send(action, undefined, { trusted: true });
    });
  }
  address.addEventListener('focus', () => { if (state?.editable) address.select(); });
  address.addEventListener('blur', render);
  address.addEventListener('keydown', event => {
    if (!state?.editable) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      send('navigate', address.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      address.value = state.url;
      address.select();
    }
  });
  ipcRenderer.on(STATE, (_event, next) => { state = next; render(); });
  send('ready');
});
