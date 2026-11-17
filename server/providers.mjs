import { readFile } from 'node:fs/promises';

/** Each adapter implements configured(env) and generate(context), returning { videoUrl }.
 * Credentials stay server-side. Adding an adapter only requires registering it here.
 */
export function createProviders(env = process.env) {
  return [
    {
      id: 'mock',
      name: '本地模拟',
      description: '验证提交与结果回传，返回已有深度视频，不调用 AI，也不产生费用。',
      configured: () => true,
      async generate({ exported }) {
        return { videoUrl: exported.videoUrl, mock: true };
      },
    },
    {
      id: 'fal',
      name: 'fal · VACE 深度控制',
      description: '需在服务端配置 FAL_KEY。默认托管接口将于 2027-01-04 下线，可用 FAL_ENDPOINT 替换兼容接口。',
      configured: () => Boolean(env.FAL_KEY),
      async generate({ exported, input, signal }) {
        if (!env.FAL_KEY) throw new Error('尚未配置 FAL_KEY。');
        if (exported.numFrames < 81) throw new Error('默认 VACE 接口需要至少 81 帧，请重新导出。');
        const { createFalClient } = await import('@fal-ai/client');
        const fal = createFalClient({ credentials: env.FAL_KEY });
        const bytes = await readFile(exported.videoPath);
        if (signal?.aborted) throw new Error('任务已停止。');
        const videoUrl = await fal.storage.upload(new Blob([bytes], { type: 'video/mp4' }));
        const result = await fal.subscribe(env.FAL_ENDPOINT || 'fal-ai/wan-22-vace-fun-a14b/depth', {
          input: {
            prompt: input.prompt,
            video_url: videoUrl,
            preprocess: false,
            num_frames: exported.numFrames,
            frames_per_second: exported.fps,
            match_input_num_frames: true,
            match_input_frames_per_second: true,
            resolution: 'auto',
            aspect_ratio: 'auto',
            enable_safety_checker: true,
            enable_prompt_expansion: false,
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
            ...(input.referenceImageUrl ? { ref_image_urls: [input.referenceImageUrl] } : {}),
          },
          pollInterval: 2000,
          ...(signal ? { abortSignal: signal } : {}),
        });
        const output = result.data?.video?.url;
        if (!isHttpUrl(output)) throw new Error('视频接口没有返回有效的 video.url。');
        return { videoUrl: output, requestId: result.requestId };
      },
    },
    {
      id: 'http',
      name: '自定义 HTTP 服务',
      description: '服务端配置 VIDEO_API_URL；接收 multipart 视频与参数，返回 {videoUrl}。',
      configured: () => isHttpUrl(env.VIDEO_API_URL),
      async generate({ exported, input, signal }) {
        if (!isHttpUrl(env.VIDEO_API_URL)) throw new Error('尚未配置有效的 VIDEO_API_URL。');
        const form = new FormData();
        form.set('video', new Blob([await readFile(exported.videoPath)], { type: 'video/mp4' }), 'depth.mp4');
        form.set('prompt', input.prompt);
        form.set('metadata', JSON.stringify({
          exportId: exported.id,
          cameraId: exported.cameraId,
          width: exported.width,
          height: exported.height,
          fps: exported.fps,
          numFrames: exported.numFrames,
          depthNear: exported.depthNear,
          depthFar: exported.depthFar,
          depthEncoding: 'linear-camera-z-near-white-far-black',
          referenceImageUrl: input.referenceImageUrl || null,
          seed: input.seed ?? null,
        }));
        const response = await fetch(env.VIDEO_API_URL, {
          method: 'POST',
          headers: env.VIDEO_API_KEY ? { Authorization: `Bearer ${env.VIDEO_API_KEY}` } : {},
          body: form,
          signal: signal || AbortSignal.timeout(15 * 60 * 1000),
        });
        if (!response.ok) throw new Error(`自定义服务返回 HTTP ${response.status}。`);
        const result = await response.json();
        if (!isHttpUrl(result.videoUrl)) throw new Error('自定义服务必须返回 {videoUrl: "https://…"}。');
        return { videoUrl: result.videoUrl };
      },
    },
  ];
}

export function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export function redactError(error, env = process.env) {
  let text = error instanceof Error ? error.message : '任务失败。';
  for (const key of ['FAL_KEY', 'VIDEO_API_KEY', 'COMFYUI_API_KEY']) {
    if (env[key]) text = text.split(env[key]).join('[redacted]');
  }
  text = text.replace(/(Bearer|Key)\s+[^\s"'<>]+/gi, '$1 [redacted]');
  return text.slice(0, 500);
}
