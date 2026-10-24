// Script-runner sandbox preload (sandboxed, isolated world). Exposes exactly
// one function to the script's world: call(op, args), which forwards to the
// main process with this run's nonce. The nonce never enters the main world.
const { contextBridge, ipcRenderer } = require('electron');

const prefix = '--wb-runner-nonce=';
const argument = process.argv.find(value => value.startsWith(prefix));
const nonce = argument ? argument.slice(prefix.length) : '';
contextBridge.exposeInMainWorld('__wbBridge', Object.freeze({
  call: (op, args) => ipcRenderer.invoke('wb-runner:op', nonce, String(op), args),
}));
