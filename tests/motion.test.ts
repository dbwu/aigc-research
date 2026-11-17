import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleScene } from '../src/motion.ts';
import type { SceneState } from '../src/model.ts';

const base = { cameras: [{ id: 'c', position: [0, 1, 5], target: [0, 1, 0] }] } as unknown as SceneState;
test('dolly is deterministic, preserves the source, and stops before the target', () => {
  assert.deepEqual(sampleScene(base, 'c', 0.5, 'dolly', 2).cameras[0].position, [0, 1, 4]);
  assert.deepEqual(base.cameras[0].position, [0, 1, 5]);
  assert.ok(sampleScene(base, 'c', 1, 'dolly', 50).cameras[0].position[2] >= 0.29);
});
test('arc preserves target, elevation and orbit radius', () => {
  const result = sampleScene(base, 'c', 1, 'arc', 90).cameras[0];
  assert.ok(Math.abs(result.position[0] + 5) < 1e-9);
  assert.ok(Math.abs(result.position[2]) < 1e-9);
  assert.equal(result.position[1], 1);
  assert.deepEqual(result.target, [0, 1, 0]);
});
