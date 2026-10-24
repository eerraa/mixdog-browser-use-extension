import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

test('simple-page first observations across independent Electron connections', { timeout: 90000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'browser-observation-한글-'));
  const visits = new Map();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/fixture?')) visits.set(req.url, (visits.get(req.url) || 0) + 1);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Local MCP fixture</title><label>Name <input></label>
      <input type="password" value="DO_NOT_EXPORT_PASSWORD">
      <button onclick="document.querySelector('output').textContent=++window.count">Count</button>
      <div id="paint" style="position:absolute;left:800px;top:20px;width:80px;height:60px;background:rgb(220,0,0)"></div>
      <output>0</output><script>window.count=0</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  console.log(`Observation diagnostics: ${directory}`);
  const run = async id => {
    const data = await mkdtemp(path.join(directory, `connection-${id}-`));
    const route = `/fixture?connection=${id}`;
    const env = { ...process.env, PATH: path.join(process.env.SYSTEMROOT, 'System32') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [
      path.join(root, 'tests/live/observation-harness.mjs'), data,
      `http://127.0.0.1:${server.address().port}${route}`,
    ], { env, cwd: os.tmpdir(), windowsHide: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => child.kill(), 20000);
    const code = await new Promise(resolve => {
      child.once('error', error => { stderr += error.stack; resolve(-1); });
      child.once('exit', resolve);
    }).finally(() => clearTimeout(timer));
    await Promise.all([writeFile(path.join(data, 'stdout.log'), stdout), writeFile(path.join(data, 'stderr.log'), stderr)]);
    console.log(`Connection ${id}: ${data}`);
    return { code, stdout, stderr, route };
  };
  const results = [];
  for (let round = 0; round < 3; round++) {
    results.push(...await Promise.all([run(`${round}-a`), run(`${round}-b`)]));
  }
  console.log('NAVIGATION_REQUESTS', JSON.stringify(Object.fromEntries(visits)));
  for (const result of results) {
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(visits.get(result.route), 1, 'First observation/recovery must never repeat navigation');
  }
});
