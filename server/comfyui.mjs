import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resampleControlVideo } from './encoder.mjs';
import { isHttpUrl } from './providers.mjs';

const controlFps = 24;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNode(value) {
  return isRecord(value) && typeof value.class_type === 'string' && isRecord(value.inputs);
}

function selectNode(graph, classType, configuredId, envKey) {
  if (configuredId) {
    if (!Object.hasOwn(graph, configuredId) || graph[configuredId].class_type !== classType) {
      throw new Error(`${envKey} 必须指向 ${classType} 节点。`);
    }
    return configuredId;
  }
  const matches = Object.keys(graph).filter(id => graph[id].class_type === classType);
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length === 0
    ? `工作流缺少 ${classType} 节点。`
    : `工作流含多个 ${classType} 节点。${envKey ? `请设置 ${envKey}。` : '请为本次生成保留一个。'}`);
}

function dependencyGraph(graph, outputId) {
  const visited = new Set();
  const pending = [outputId];
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    if (!Object.hasOwn(graph, id)) throw new Error(`工作流缺少被引用的节点 ${id}。`);
    visited.add(id);
    for (const value of Object.values(graph[id].inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1])) {
        pending.push(value[0]);
      }
    }
  }
  return Object.fromEntries([...visited].map(id => [id, graph[id]]));
}

function prepareWorkflow(document, env) {
  const graph = document?.prompt ?? document;
  if (!isRecord(graph) || !Object.values(graph).length || !Object.values(graph).every(isNode)) {
    throw new Error('需要 ComfyUI 的 API 格式工作流，请使用「导出 (API)」。');
  }
  const outputId = selectNode(graph, 'SaveVideo', env.COMFYUI_OUTPUT_NODE, 'COMFYUI_OUTPUT_NODE');
  const videoId = selectNode(graph, 'LoadVideo', env.COMFYUI_VIDEO_NODE, 'COMFYUI_VIDEO_NODE');
  const active = dependencyGraph(graph, outputId);
  const h3Id = selectNode(active, 'MiniMaxH3ReferenceToVideo');
  const controlId = selectNode(active, 'MiniMaxH3FunControlNetApply');

  let decodeId = 1;
  while (Object.hasOwn(graph, decodeId)) decodeId++;
  graph[decodeId] = { class_type: 'GetVideoComponents', inputs: { video: [videoId, 0] } };
  graph[controlId].inputs.control_video = [String(decodeId), 0];
  // Only execute the selected result's ancestors. The template also saves a pose preview.
  const prompt = dependencyGraph(graph, outputId);
  const noiseIds = Object.keys(prompt).filter(id => prompt[id].class_type === 'RandomNoise');
  return { prompt, outputId, videoId, h3Id, noiseId: noiseIds.length === 1 ? noiseIds[0] : undefined };
}

function historyError(status) {
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const failure = messages.find(message => Array.isArray(message) && ['execution_error', 'execution_interrupted'].includes(message[0]));
  const detail = failure?.[1]?.exception_message;
  return typeof detail === 'string' && detail.trim() ? `ComfyUI 运行失败：${detail}` : 'ComfyUI 工作流失败或已中断，请查看 ComfyUI 的任务记录。';
}

function findVideo(outputs) {
  if (!isRecord(outputs)) return undefined;
  return Object.values(outputs).flatMap(value => Array.isArray(value) ? value : []).find(file =>
    file?.type === 'output' && typeof file.filename === 'string' && /\.mp4$/i.test(file.filename));
}

export async function createComfyUIProvider(env, { ffmpeg, generationDir, workflowPath }) {
  let config;
  let description = '请设置 COMFYUI_URL，并保存 MiniMax H3 的 API 格式工作流。';
  if (env.COMFYUI_URL) {
    try {
      if (!isHttpUrl(env.COMFYUI_URL)) throw new Error('COMFYUI_URL 必须是 HTTP 或 HTTPS 服务地址。');
      const base = new URL(env.COMFYUI_URL);
      if (base.search || base.hash) throw new Error('COMFYUI_URL 请填写服务根地址。');
      if (!base.pathname.endsWith('/')) base.pathname += '/';
      const source = await readFile(env.COMFYUI_WORKFLOW_PATH || workflowPath, 'utf8');
      const workflow = prepareWorkflow(JSON.parse(source.replace(/^\uFEFF/, '')), env);
      config = { base, ...workflow };
      description = '用当前的深度视频控制 MiniMax H3，完成后可在此播放。';
    } catch (error) {
      if (error.code === 'ENOENT') description = '未找到 API 工作流，请设置 COMFYUI_WORKFLOW_PATH 或保存为 comfyui-h3.api.json。';
      else if (error instanceof SyntaxError) description = 'ComfyUI 工作流 JSON 无法读取，请重新导出 API 格式。';
      else description = error.message;
    }
  }

  async function request(route, operation, signal, options = {}) {
    const headers = new Headers(options.headers);
    if (env.COMFYUI_API_KEY) headers.set('Authorization', `Bearer ${env.COMFYUI_API_KEY}`);
    let response;
    try {
      response = await fetch(new URL(route, config.base), { ...options, headers, signal, redirect: 'error' });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(`无法连接 ComfyUI，${operation}失败。`, { cause: error });
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const nodeErrors = Object.values(body?.node_errors || {}).flatMap(node => node?.errors || []);
      const detail = [body?.error?.message, nodeErrors[0]?.message, nodeErrors[0]?.details].filter(value => typeof value === 'string' && value).join(' · ');
      throw new Error(`ComfyUI ${operation}失败（HTTP ${response.status}）${detail ? `：${detail}` : '。'}`);
    }
    return response;
  }

  async function getJson(route, operation, signal, options) {
    const response = await request(route, operation, signal, options);
    return response.json().catch(() => { throw new Error(`ComfyUI ${operation}时未返回 JSON。`); });
  }

  return {
    id: 'comfyui',
    name: 'ComfyUI · MiniMax H3',
    description,
    acceptsReferenceImage: false,
    timeoutMs: 30 * 60 * 1000,
    configured: () => Boolean(config),
    async generate({ exported, input, jobId, signal }) {
      if (!config) throw new Error(description);
      const { videoId, h3Id, noiseId, outputId } = config;
      const prompt = structuredClone(config.prompt);
      const frames = Math.min(362, Math.max(124, 5 + 17 * Math.ceil((exported.numFrames * controlFps / exported.fps - 5) / 17)));
      prompt[h3Id].inputs.prompt = input.prompt;
      prompt[h3Id].inputs.length = frames;
      if (noiseId && input.seed !== undefined) prompt[noiseId].inputs.noise_seed = input.seed;

      await mkdir(generationDir, { recursive: true });
      const depthPath = join(generationDir, `${jobId}-depth.mp4`);
      const partialPath = join(generationDir, `${jobId}.part`);
      try {
        await resampleControlVideo(ffmpeg, exported.videoPath, depthPath, controlFps, frames, signal);
        const form = new FormData();
        form.set('image', new Blob([await readFile(depthPath)], { type: 'video/mp4' }), `spatial-depth-${jobId}.mp4`);
        form.set('type', 'input');
        const upload = await getJson('upload/image', '上传深度视频', signal, { method: 'POST', body: form });
        if (typeof upload?.name !== 'string' || !upload.name || upload.type !== 'input') {
          throw new Error('ComfyUI 没有返回已上传的深度视频文件名。');
        }
        prompt[videoId].inputs.file = [upload.subfolder, upload.name].filter(Boolean).join('/');

        const queued = await getJson('prompt', '提交工作流', signal, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
        const promptId = queued?.prompt_id;
        if (typeof promptId !== 'string' || !promptId) throw new Error('ComfyUI 没有返回任务 ID。');

        let file;
        while (!file) {
          const history = await getJson(`history/${encodeURIComponent(promptId)}`, '查询任务', signal);
          const entry = history?.[promptId];
          const status = entry?.status;
          if (['error', 'failed', 'interrupted'].includes(status?.status_str)) throw new Error(historyError(status));
          file = findVideo(entry?.outputs?.[outputId]);
          if (!file && (status?.completed || status?.status_str === 'success')) {
            throw new Error('ComfyUI 已完成，但 Save Video 没有生成 MP4。请将输出格式设为 MP4、编码设为 H.264。');
          }
          if (!file) await delay(1500, undefined, { signal }).catch(error => { throw signal.aborted ? signal.reason : error; });
        }

        const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type });
        const media = await request(`view?${query}`, '下载生成视频', signal);
        if (!media.body) throw new Error('ComfyUI 返回的视频为空。');
        await pipeline(media.body, createWriteStream(partialPath), { signal });
        const handle = await open(partialPath, 'r');
        try {
          const header = Buffer.alloc(8);
          const { bytesRead } = await handle.read(header);
          if (bytesRead !== 8 || header.toString('ascii', 4) !== 'ftyp') throw new Error('ComfyUI 返回的文件不是 MP4 视频。');
        } finally {
          await handle.close();
        }
        signal.throwIfAborted();
        await rename(partialPath, join(generationDir, `${jobId}.mp4`));
        return { videoUrl: `/artifacts/generations/${jobId}.mp4`, requestId: promptId };
      } finally {
        await Promise.allSettled([rm(depthPath, { force: true }), rm(partialPath, { force: true })]);
      }
    },
  };
}
