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
  const send = (action, value) => ipcRenderer.send(ACTION, value === undefined ? { action } : { action, value });
  const label = (element, text) => { element.title = text; element.setAttribute('aria-label', text); };
  const actionButton = (button, spec) => {
    button.hidden = !spec;
    button.textContent = spec?.text ?? '';
    button.dataset.action = spec?.action ?? '';
  };
  const render = () => {
    if (!state) return;
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
    $('chip').textContent = state.chip.text;
    $('chip').dataset.tone = state.chip.tone;
    $('chip').title = state.chip.title ?? '';
    actionButton($('primary'), state.primary);
    actionButton($('secondary'), state.secondary);
  };
  for (const id of ['back', 'forward']) $(id).addEventListener('click', () => send(id));
  $('reload').addEventListener('click', () => send(state?.loading ? 'stop-loading' : 'reload'));
  for (const id of ['primary', 'secondary']) {
    $(id).addEventListener('click', event => {
      const action = event.currentTarget.dataset.action;
      if (action) send(action);
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
