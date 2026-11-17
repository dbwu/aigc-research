import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultScene, depthIntensity, parseScene } from '../src/model.ts';

test('scene round-trip preserves independent objects and cameras', () => {
  const original = createDefaultScene();
  const parsed = parseScene(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(parsed, original);
  assert.equal(parsed.people.length, 2);
  assert.equal(parsed.cameras.length, 3);
  parsed.people[0].position[0] = 4;
  assert.notEqual(original.people[0].position[0], 4);
});

test('invalid camera matrices and ambiguous identities are rejected before rendering', () => {
  const scene = createDefaultScene();
  scene.cameras[0].target = [...scene.cameras[0].position];
  assert.throws(() => parseScene(scene), /不能重合/);
  const duplicate = createDefaultScene();
  duplicate.people[1].id = duplicate.people[0].id;
  assert.throws(() => parseScene(duplicate), /ID 重复/);
  const invalid = createDefaultScene();
  invalid.people[0].position[0] = Number.NaN;
  assert.throws(() => parseScene(invalid), /有限数值/);
});

test('depth convention is linear view-Z, near white, far black, with fixed bounds', () => {
  assert.equal(depthIntensity(0.2, 0.2, 12), 1);
  assert.equal(depthIntensity(12, 0.2, 12), 0);
  assert.equal(depthIntensity(6.1, 0.2, 12), 0.5);
  assert.equal(depthIntensity(0.1, 0.2, 12), 1);
  assert.equal(depthIntensity(15, 0.2, 12), 0);
  assert.throws(() => depthIntensity(5, 12, 12), /无效/);
  const scene = createDefaultScene();
  scene.depth.far = scene.depth.near;
  assert.throws(() => parseScene(scene), /远端必须大于/);
});
