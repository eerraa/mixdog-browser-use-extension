import { app, BrowserWindow, nativeImage, session } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { FrameDriver } from '../../src/browser/frames.mjs';
import { firstRender } from '../../src/browser/readiness.mjs';
import { bounded } from '../../src/async.mjs';
import { WORKER_PROBE_EXPRESSION } from '../fixtures/worker-probe.mjs';

const directory = process.argv[2];
app.setPath('userData', path.join(directory, 'electron'));
const expected = { kind: 'diagnostic-worker-ready', value: 7 };
const workerScript = 'self.postMessage({kind:"diagnostic-worker-ready",value:3+4});';
let server, window;

function fixture(port) {
  return `<!doctype html><meta charset="utf-8"><title>Local Worker readiness fixture</title>
    <style>body{margin:0}#layout{position:absolute;left:20px;top:20px}</style>
    <div id="layout" hidden><canvas id="paint" width="80" height="60"></canvas></div>
    <iframe id="child"></iframe>
    <script>
    const workers=[], ports=[];let registration;
    const timeout=p=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Worker fixture timed out')),7000);
      p.then(resolve,reject).finally(()=>clearTimeout(timer)).catch(()=>{});
    });
    const message=port=>timeout(new Promise((resolve,reject)=>{
      port.onmessage=e=>resolve(e.data);
      port.onmessageerror=()=>reject(new Error('Worker message decode failed'));
      port.onerror=e=>reject(new Error(e.message));
    }));
    const worker=url=>{const w=new Worker(url);workers.push(w);return message(w)};
    window.probe=(async()=>{
      const frame=timeout(new Promise(resolve=>{
        addEventListener('message',function ready(e){
          if(e.origin!=='http://localhost:${port}'||e.data.kind!=='diagnostic-worker-ready')return;
          removeEventListener('message',ready);resolve(e.data);
        });
        document.querySelector('#child').src='http://localhost:${port}/frame';
      }));
      const shared=new SharedWorker('/shared.js');ports.push(shared.port);
      const sharedResult=message(shared.port);shared.port.start();
      const service=(async()=>{
        registration=await navigator.serviceWorker.register('/service.js');
        const active=registration.installing||registration.waiting||registration.active;
        if(active.state!=='activated')await timeout(new Promise((resolve,reject)=>{
          active.addEventListener('statechange',()=>{
            if(active.state==='activated')resolve();
            if(active.state==='redundant')reject(new Error('Service worker became redundant'));
          });
        }));
        const reply=message(navigator.serviceWorker);
        registration.active.postMessage('probe');return reply;
      })();
      try {
        const values=await Promise.all([worker('/worker.js'),worker('/nested.js'),frame,sharedResult,service]);
        document.querySelector('#paint').getContext('2d').fillStyle='rgb(0,190,0)';
        document.querySelector('#paint').getContext('2d').fillRect(0,0,80,60);
        document.querySelector('#layout').hidden=false;
        return values;
      } finally {
        for(const w of workers)w.terminate();
        for(const port of ports)port.close();
        if(registration)await registration.unregister();
      }
    })();
    </script>`;
}

async function run() {
  await app.whenReady();
  let port;
  server = http.createServer((request, response) => {
    response.setHeader('Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-src 'self' http://localhost:${port}; style-src 'unsafe-inline'`);
    const scripts = {
      '/worker.js': workerScript,
      '/nested.js': `const child=new Worker('/worker.js');child.onmessage=e=>{self.postMessage(e.data);child.terminate()};`,
      '/shared.js': `self.onconnect=e=>e.ports[0].postMessage({kind:"diagnostic-worker-ready",value:3+4});`,
      '/service.js': `self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
        self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
        self.addEventListener('message',e=>e.source.postMessage({kind:"diagnostic-worker-ready",value:3+4}));`,
    };
    response.setHeader('Content-Type', scripts[request.url] ? 'text/javascript' : 'text/html');
    if (scripts[request.url]) return response.end(scripts[request.url]);
    if (request.url === '/frame') return response.end(`<!doctype html><script>
      const child=new Worker('/worker.js');child.onmessage=e=>{parent.postMessage(e.data,'http://127.0.0.1:${port}');child.terminate()};
    </script>`);
    response.end(fixture(port));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  for (const visible of [false, true]) {
    const commands = [], attached = [];
    window = new BrowserWindow({ width: 1120, height: 820, show: visible, webPreferences: {
      session: session.fromPath(path.join(directory, visible ? 'visible' : 'hidden')),
      nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      navigateOnDragDrop: false, webviewTag: false, backgroundThrottling: false, preload: undefined,
    } });
    const rendered = firstRender(window);
    const page = { window, connected: true, closed: false };
    const driver = new FrameDriver(page, () => {});
    const wc = window.webContents;
    const send = wc.debugger.sendCommand.bind(wc.debugger);
    wc.debugger.sendCommand = (method, params, sessionId) => {
      commands.push({ method, sessionId });
      return send(method, params, sessionId);
    };
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Target.attachedToTarget') attached.push({
        type: params.targetInfo.type, sessionId: params.sessionId,
      });
    });
    try {
      await window.loadURL('about:blank');
      await rendered;
      await driver.start();
      await window.loadURL(`http://127.0.0.1:${port}/`);
      const main = await bounded(wc.executeJavaScript('window.probe'), 12000, 'Actual page Worker readiness');
      assert.deepEqual(main, Array.from({ length: 5 }, () => expected));
      await driver.refresh();
      const root = [...driver.frames.values()].find(frame => !frame.parentId);
      const isolated = await driver.evaluateUser(root, WORKER_PROBE_EXPRESSION);
      assert.deepEqual(isolated, expected);
      await driver.waitForIdle();
      assert.equal(page.frameFailure ?? null, null);
      for (const target of attached.filter(target => target.type !== 'iframe')) {
        assert.equal(driver.sessions.has(target.sessionId), false);
        assert.ok(commands.filter(command => command.sessionId === target.sessionId)
          .every(command => ['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'].includes(command.method)));
      }
      assert.ok(attached.filter(target => target.type === 'worker').length >= 4,
        'Dedicated, nested, iframe and isolated Worker sessions must really attach');
      const layout = await wc.executeJavaScript(`(() => {
        const canvas=document.querySelector('#paint'),rect=canvas.getBoundingClientRect();
        return {hidden:document.querySelector('#layout').hidden,visibility:getComputedStyle(canvas).visibility,
          rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
          topElement:document.elementFromPoint(30,30)?.tagName,
          pixel:[...canvas.getContext('2d').getImageData(10,10,1,1).data]};
      })()`);
      console.log('WORKER_RENDER_STATE', JSON.stringify({ visible, layout, attached }));
      assert.equal(layout.hidden, false);
      assert.equal(layout.visibility, 'visible');
      assert.deepEqual(layout.pixel, [0, 190, 0, 255]);
      if (!visible) {
        // Production observations require a hidden guest. Native handoff
        // deliberately forbids screenshots; visible Worker startup is still
        // checked above, without claiming human-visible paint was measured.
        const image = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
        await writeFile(path.join(directory, 'hidden.png'), image.toPNG());
        const { width, height } = image.getSize();
        const viewport = await wc.executeJavaScript('({width:innerWidth,height:innerHeight})');
        const offset = (Math.floor(30 * height / viewport.height) * width + Math.floor(30 * width / viewport.width)) * 4;
        assert.deepEqual([...image.toBitmap().subarray(offset, offset + 4)], [0, 190, 0, 255],
          'The worker-backed fixture layout must really appear in the captured image');
        assert.ok(nativeImage.createFromBuffer(image.toPNG()).getSize().width > 0);
      }
      console.log(JSON.stringify({ visible, workerKinds: [...new Set(attached.map(target => target.type))],
        main, isolated, physicalCapture: visible ? 'NOT RUN: outside automation observation contract' : 'passed' }));
    } finally {
      page.closed = true;
      window.destroy();
      window = undefined;
    }
  }
  console.log('WORKER_CONTRACT_PASSED');
}

app.on('window-all-closed', () => {});
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  if (window) window.destroy();
  server?.close();
  app.exit(process.exitCode ?? 0);
});
