import { jsonPost, api, type ExportRecord } from './api';
import { sampleScene, type Motion } from './motion';
import type { SceneState } from './model';
import type { SceneViewport } from './scene';

export type ExportOptions = {
  width: number; height: number; fps: number; numFrames: number;
  cameraId: string; motion: Motion; amount: number;
};

export async function exportDepthVideo(
  viewport: SceneViewport, state: SceneState, options: ExportOptions,
  onProgress: (done: number, total: number, message: string) => void,
): Promise<ExportRecord> {
  const scene = structuredClone(state);
  onProgress(0, options.numFrames, '准备导出…');
  const { id } = await jsonPost<{ id: string }>('/api/exports', {
    scene, ...options, depthNear: scene.depth.near, depthFar: scene.depth.far,
  });
  try {
    for (let index = 0; index < options.numFrames; index++) {
      const sampled = sampleScene(scene, options.cameraId, index / Math.max(1, options.numFrames - 1), options.motion, options.amount);
      viewport.update(sampled);
      const png = await viewport.capture(options.cameraId, options.width, options.height, 'depth');
      await api(`/api/exports/${id}/frames/${index}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
      onProgress(index + 1, options.numFrames, `渲染深度帧 ${index + 1} / ${options.numFrames}`);
    }
    onProgress(options.numFrames, options.numFrames, '正在合成 MP4…');
    return await jsonPost<ExportRecord>(`/api/exports/${id}/complete`, {});
  } finally {
    viewport.update(scene);
  }
}
