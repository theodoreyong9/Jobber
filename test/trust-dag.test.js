import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventDag, weightedMedian } from '../js/trust-dag.js';

test('EventDag: addEvent is content-addressed — the same payload from the same parents always yields the same id', async () => {
  const dag = new EventDag();
  const id1 = await dag.addEvent([], { type: 'a' });
  const dag2 = new EventDag();
  const id2 = await dag2.addEvent([], { type: 'a' });
  assert.equal(id1, id2);
});

test('EventDag: a different payload yields a different id', async () => {
  const dag = new EventDag();
  const id1 = await dag.addEvent([], { type: 'a' });
  const id2 = await dag.addEvent([], { type: 'b' });
  assert.notEqual(id1, id2);
});

test('EventDag: adding the identical event twice does not duplicate it', async () => {
  const dag = new EventDag();
  await dag.addEvent([], { type: 'a' });
  await dag.addEvent([], { type: 'a' });
  assert.equal(dag.size, 1);
});

test('EventDag: addEvent rejects an unknown parent', async () => {
  const dag = new EventDag();
  await assert.rejects(() => dag.addEvent(['nonexistent'], { type: 'a' }));
});

test('EventDag: topoOrder never puts a child before its parent', async () => {
  const dag = new EventDag();
  const id1 = await dag.addEvent([], { type: 'genesis' });
  const id2 = await dag.addEvent([id1], { type: 'child' });
  const order = dag.topoOrder();
  const genesisIndex = order.findIndex((ev) => ev.id === id1);
  const childIndex = order.findIndex((ev) => ev.id === id2);
  assert.ok(genesisIndex < childIndex);
});

test('EventDag: loadTrusted restores events without recomputing hashes, given causal order', () => {
  const dag = new EventDag();
  dag.loadTrusted([
    { id: 'genesis', parents: [], payload: { type: 'genesis' } },
    { id: 'child', parents: ['genesis'], payload: { type: 'child' } },
  ]);
  assert.equal(dag.size, 2);
  const order = dag.topoOrder();
  assert.deepEqual(order.map((ev) => ev.id), ['genesis', 'child']);
});

// A single, one-pass restore, not a fixed-point loop — an event is
// dropped, not merely deferred, if its parent hasn't already been loaded
// earlier in the same array. This is exactly why credibility.js's
// loadDag() sorts its rows by timestamp before calling loadTrusted: the
// caller's job is to hand events over already in causal order.
test('EventDag: loadTrusted drops an event whose parent appears later in the same array, rather than reordering for it', () => {
  const dag = new EventDag();
  dag.loadTrusted([
    { id: 'child', parents: ['genesis'], payload: { type: 'child' } }, // parent not loaded yet — dropped
    { id: 'genesis', parents: [], payload: { type: 'genesis' } },
  ]);
  assert.equal(dag.size, 1);
  assert.equal(dag.topoOrder()[0].id, 'genesis');
});

test('EventDag: loadTrusted silently skips an event whose parent never arrives at all', () => {
  const dag = new EventDag();
  dag.loadTrusted([{ id: 'orphan', parents: ['never-loaded'], payload: {} }]);
  assert.equal(dag.size, 0);
});

test('EventDag: merge is a commutative union — order of merging does not matter', async () => {
  const a = new EventDag();
  const idA = await a.addEvent([], { type: 'a' });
  const b = new EventDag();
  const idB = await b.addEvent([], { type: 'b' });

  const mergedAB = new EventDag();
  mergedAB.merge(a);
  mergedAB.merge(b);

  const mergedBA = new EventDag();
  mergedBA.merge(b);
  mergedBA.merge(a);

  assert.equal(mergedAB.size, 2);
  assert.equal(mergedBA.size, 2);
  assert.deepEqual(mergedAB.topoOrder().map((e) => e.id).sort(), mergedBA.topoOrder().map((e) => e.id).sort());
  assert.deepEqual(mergedAB.topoOrder().map((e) => e.id).sort(), [idA, idB].sort());
});

test('EventDag: materialize folds every event, in causal order, into one final state', async () => {
  const dag = new EventDag();
  const id1 = await dag.addEvent([], { n: 1 });
  await dag.addEvent([id1], { n: 2 });
  const sum = dag.materialize((state, ev) => state + ev.payload.n, 0);
  assert.equal(sum, 3);
});

test('weightedMedian: a minority of adversarial weight cannot pull the result past the honest majority', () => {
  const estimates = [
    { value: 10, weight: 1 },
    { value: 10, weight: 1 },
    { value: 10, weight: 1 },
    { value: 9999, weight: 2 }, // even a doubled single voice stays a minority against 3 honest ones
  ];
  assert.equal(weightedMedian(estimates), 10);
});

test('weightedMedian: a single estimate returns itself', () => {
  assert.equal(weightedMedian([{ value: 42, weight: 1 }]), 42);
});

test('weightedMedian: throws on empty input rather than returning a misleading number', () => {
  assert.throws(() => weightedMedian([]));
});

test('weightedMedian: throws when total weight is zero', () => {
  assert.throws(() => weightedMedian([{ value: 1, weight: 0 }]));
});
