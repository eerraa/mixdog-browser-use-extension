import test from 'node:test';
import assert from 'node:assert/strict';
import { FenceQueue } from '../../src/core/queue.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('caller abort is prompt but actual work fences the lane until settlement', async () => {
  const queue = new FenceQueue();
  const work = deferred();
  const controller = new AbortController();
  const calls = [];
  const first = queue.run('a', signal => {
    calls.push('first');
    signal.addEventListener('abort', () => calls.push('abort'));
    return work.promise;
  }, controller.signal);
  await tick();
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  const second = queue.run('a', () => { calls.push('second'); return 42; });
  await tick();
  assert.deepEqual(calls, ['first', 'abort']);
  assert.equal(queue.isBusy('a'), true);
  work.resolve('late');
  assert.equal(await second, 42);
  assert.equal(queue.isBusy('a'), false);
});

test('queued abort never dispatches, and lane abort does not affect other keys', async () => {
  const queue = new FenceQueue();
  const work = deferred();
  const first = queue.run('a', () => work.promise);
  const controller = new AbortController();
  let dispatched = false;
  const queued = queue.run('a', () => { dispatched = true; }, controller.signal);
  await tick();
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  queue.abort('a');
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(await queue.run('b', () => 'independent'), 'independent');
  assert.equal(queue.isBusy('a'), true);
  work.resolve();
  await tick();
  assert.equal(dispatched, false);
  assert.equal(queue.isBusy('a'), false);
});

test('results and original failures are preserved without retries', async () => {
  const queue = new FenceQueue();
  const error = new Error('original');
  let calls = 0;
  await assert.rejects(queue.run('a', () => { calls++; throw error; }), e => e === error);
  assert.equal(calls, 1);
  assert.equal(await queue.run('a', () => 7), 7);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(queue.run('a', () => { calls++; }, controller.signal));
  assert.equal(calls, 1);
});
