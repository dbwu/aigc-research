import type { SceneState } from './model';

export type Motion = 'static' | 'dolly' | 'arc';

/** Sample exactly the same world-space camera path for scrubbing and offline export. */
export function sampleScene(base: SceneState, cameraId: string, time: number, motion: Motion, distance: number): SceneState {
  const scene = structuredClone(base);
  const camera = scene.cameras.find(item => item.id === cameraId);
  if (!camera || motion === 'static') return scene;
  const t = Math.min(1, Math.max(0, time));
  if (motion === 'dolly') {
    const delta = camera.target.map((value, i) => value - camera.position[i]);
    const length = Math.hypot(...delta);
    const travel = Math.min(Math.max(0, distance), Math.max(0, length - 0.3)) * t;
    if (length > 0) camera.position = camera.position.map((value, i) => value + delta[i] / length * travel) as [number, number, number];
  } else {
    const dx = camera.position[0] - camera.target[0];
    const dz = camera.position[2] - camera.target[2];
    const angle = distance * t * Math.PI / 180;
    camera.position[0] = camera.target[0] + dx * Math.cos(angle) - dz * Math.sin(angle);
    camera.position[2] = camera.target[2] + dx * Math.sin(angle) + dz * Math.cos(angle);
  }
  return scene;
}
