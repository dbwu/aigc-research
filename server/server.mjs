import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat, access } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createProviders, isHttpUrl, redactError } from './providers.mjs';
import { createComfyUIProvider } from './comfyui.mjs';
import { resolveFfmpeg, checkFfmpeg, encodeVideo } from './encoder.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(condition, message, status = 400) { if (condition) throw new ApiError(status, message); }
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}
async function body(request, limit = 2 * 1024 * 1024) {
  fail(Number(request.headers['content-length']) > limit, '请求内容过大。', 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    fail(length > limit, '请求内容过大。', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(request) {
  fail(!request.headers['content-type']?.startsWith('application/json'), '需要 application/json 请求。', 415);
  try { return JSON.parse((await body(request)).toString('utf8')); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'JSON 格式不正确。'); }
}
function validateExport(input) {
  fail(!input || typeof input !== 'object', '导出参数缺失。');
  for (const [key, min, max] of [['width', 16, 1280], ['height', 16, 720], ['fps', 1, 30], ['numFrames', 1, 241]]) {
    fail(!Number.isInteger(input[key]) || input[key] < min || input[key] > max, `${key} 必须是 ${min}–${max} 的整数。`);
  }
  fail(input.width % 2 !== 0 || input.height % 2 !== 0, '视频宽高必须为偶数。');
  fail(typeof input.cameraId !== 'string' || input.cameraId.length > 100 || !input.cameraId, '请选择有效机位。');
  fail(!input.scene || typeof input.scene !== 'object' || Array.isArray(input.scene), '场景数据缺失。');
  fail(!Number.isFinite(input.depthNear) || !Number.isFinite(input.depthFar) || input.depthNear < 0 || input.depthFar <= input.depthNear || input.depthFar > 1000, '深度范围不正确。');
  const motion = input.motion ?? 'static';
  const amount = input.amount ?? 0;
  fail(!['static', 'dolly', 'arc'].includes(motion), '不支持的相机运动。');
  fail(!Number.isFinite(amount) || Math.abs(amount) > 360, '相机运动幅度不正确。');
  const camera = input.scene.cameras?.find(item => item.id === input.cameraId);
  const validVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  fail(!camera || !validVector(camera.position) || !validVector(camera.target) || !Number.isFinite(camera.fov) || camera.fov <= 0 || camera.fov >= 180, '相机参数不完整。');
  const frameCameraPoses = Array.from({ length: input.numFrames }, (_, index) => {
    const t = index / Math.max(1, input.numFrames - 1);
    const position = [...camera.position];
    if (motion === 'dolly') {
      const delta = camera.target.map((value, i) => value - camera.position[i]);
      const length = Math.hypot(...delta);
      const travel = Math.min(Math.max(0, amount), Math.max(0, length - 0.3)) * t;
      if (length > 0) for (let i = 0; i < 3; i++) position[i] += delta[i] / length * travel;
    } else if (motion === 'arc') {
      const dx = camera.position[0] - camera.target[0];
      const dz = camera.position[2] - camera.target[2];
      const angle = amount * t * Math.PI / 180;
      position[0] = camera.target[0] + dx * Math.cos(angle) - dz * Math.sin(angle);
      position[2] = camera.target[2] + dx * Math.sin(angle) + dz * Math.cos(angle);
    }
    return { index, timeSeconds: index / input.fps, position, target: [...camera.target], up: [0, 1, 0], fov: camera.fov, aspect: input.width / input.height };
  });
  return { scene: input.scene, cameraId: input.cameraId, width: input.width, height: input.height, fps: input.fps, numFrames: input.numFrames, depthNear: input.depthNear, depthFar: input.depthFar, motion, amount, frameCameraPoses };
}
function publicExport(item) {
  const { directory, videoPath, frames, ...visible } = item;
  return visible;
}
async function persist(item) {
  await writeFile(join(item.directory, 'metadata.json'), JSON.stringify(publicExport(item), null, 2));
}
async function sendFile(request, response, filePath) {
  let info;
  try { info = await stat(filePath); } catch { throw new ApiError(404, '文件不存在。'); }
  fail(!info.isFile(), '文件不存在。', 404);
  const headers = { 'Content-Type': mime[extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
    const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
    response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    if (request.method === 'HEAD') response.end(); else createReadStream(filePath, { start, end }).pipe(response);
  } else {
    response.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (request.method === 'HEAD') response.end(); else createReadStream(filePath).pipe(response);
  }
}

export async function createAppServer(options = {}) {
  const env = options.env || process.env;
  const dataDir = resolve(options.dataDir || join(root, 'data'));
  const exportDir = join(dataDir, 'exports');
  const generationDir = join(dataDir, 'generations');
  const distDir = resolve(options.distDir || join(root, 'dist'));
  const ffmpeg = await resolveFfmpeg(options.ffmpegPath || env.FFMPEG_PATH);
  const ffmpegReady = checkFfmpeg(ffmpeg);
  const providers = options.providers || [...createProviders(env), await createComfyUIProvider(env, {
    ffmpeg, generationDir, workflowPath: join(root, 'comfyui-h3.api.json'),
  })];
  const exports = new Map();
  const generations = new Map();
  const controllers = new Set();
  await mkdir(exportDir, { recursive: true });
  for (const id of await readdir(exportDir)) {
    if (!idPattern.test(id)) continue;
    try {
      const directory = join(exportDir, id);
      const saved = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
      if (saved.id === id && saved.status === 'completed') {
        await access(join(directory, 'depth.mp4'));
        exports.set(id, { ...saved, directory, videoPath: join(directory, 'depth.mp4') });
      }
    } catch { /* Ignore abandoned or incomplete exports after restart. */ }
  }
  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host || 'localhost';
      const hostname = new URL(`http://${host}`).hostname;
      fail(!['localhost', '127.0.0.1', '[::1]'].includes(hostname), '仅接受本机请求。', 403);
      const origin = request.headers.origin;
      if (!['GET', 'HEAD'].includes(request.method) && origin) {
        const allowed = new Set([`http://${host}`, 'http://localhost:3210', 'http://127.0.0.1:3210', ...(options.allowedOrigins || [])]);
        fail(!allowed.has(origin), '不允许此来源提交任务。', 403);
      }
      const url = new URL(request.url, `http://${host}`);
      const pathname = decodeURIComponent(url.pathname);
      const method = request.method;
      if (pathname === '/api/health' && method === 'GET') return json(response, 200, { ok: true, ffmpegAvailable: await ffmpegReady });
      if (pathname === '/api/providers' && method === 'GET') {
        return json(response, 200, { providers: providers.map(p => ({
          id: p.id, name: p.name, description: p.description, configured: Boolean(p.configured()),
          acceptsReferenceImage: p.acceptsReferenceImage,
        })) });
      }
      if (pathname === '/api/exports' && method === 'GET') return json(response, 200, { exports: [...exports.values()].filter(item => item.status === 'completed').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicExport) });
      if (pathname === '/api/exports' && method === 'POST') {
        const input = validateExport(await readJson(request));
        fail([...exports.values()].filter(item => item.status !== 'completed').length >= 8, '未完成导出过多，请重启服务清理未完成任务。', 429);
        const id = randomUUID();
        const directory = join(exportDir, id);
        await mkdir(join(directory, 'frames'), { recursive: true });
        const item = { ...input, id, status: 'uploading', createdAt: new Date().toISOString(), depthEncoding: 'linear-camera-z-near-white-far-black', compression: 'MP4 uses H.264 CRF 12, yuv420p. Original PNG frames are lossless.', directory, frames: new Set() };
        exports.set(id, item);
        await persist(item);
        return json(response, 201, { id });
      }
      const frameRoute = /^\/api\/exports\/([^/]+)\/frames\/(\d+)$/.exec(pathname);
      if (frameRoute && method === 'POST') {
        const item = exports.get(frameRoute[1]);
        fail(!item, '导出任务不存在。', 404);
        fail(item.status !== 'uploading', '此任务不再接收帧。', 409);
        const index = Number(frameRoute[2]);
        fail(!Number.isSafeInteger(index) || index >= item.numFrames, '帧编号超出范围。');
        fail(!request.headers['content-type']?.startsWith('image/png'), '帧必须为 PNG。', 415);
        const bytes = await body(request, 8 * 1024 * 1024);
        fail(bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature) || bytes.toString('ascii', 12, 16) !== 'IHDR', 'PNG 文件无效。');
        fail(bytes.readUInt32BE(16) !== item.width || bytes.readUInt32BE(20) !== item.height, 'PNG 尺寸与导出设置不一致。');
        await writeFile(join(item.directory, 'frames', `${String(index).padStart(5, '0')}.png`), bytes);
        item.frames.add(index);
        return json(response, 200, { ok: true });
      }
      const completeRoute = /^\/api\/exports\/([^/]+)\/complete$/.exec(pathname);
      if (completeRoute && method === 'POST') {
        const item = exports.get(completeRoute[1]);
        fail(!item, '导出任务不存在。', 404);
        if (item.status === 'completed') return json(response, 200, publicExport(item));
        fail(item.status === 'encoding', '视频正在编码。', 409);
        fail(item.frames.size !== item.numFrames, `帧不完整：收到 ${item.frames.size}/${item.numFrames} 帧。`);
        item.status = 'encoding';
        try {
          item.videoPath = await encodeVideo(item, ffmpeg);
          item.status = 'completed';
          item.videoUrl = `/artifacts/${item.id}/depth.mp4`;
          item.metadataUrl = `/artifacts/${item.id}/metadata.json`;
          item.framesUrl = `/artifacts/${item.id}/frames/00000.png`;
          item.completedAt = new Date().toISOString();
          await persist(item);
          return json(response, 200, publicExport(item));
        } catch (error) { item.status = 'uploading'; throw error; }
      }
      if (pathname === '/api/generations' && method === 'POST') {
        const input = await readJson(request);
        const provider = providers.find(p => p.id === input.provider);
        fail(!provider, '生成服务不存在。');
        fail(!provider.configured(), `服务尚未配置。${provider.description || ''}`);
        const exported = exports.get(input.exportId);
        fail(!exported || exported.status !== 'completed', '请先完成深度视频导出。');
        fail(typeof input.prompt !== 'string' || input.prompt.trim().length < 1 || input.prompt.length > 10000, '请输入 1–10000 字符的提示词。');
        fail(input.referenceImageUrl && provider.acceptsReferenceImage === false, '当前生成服务只接收深度视频和提示词。');
        fail(input.referenceImageUrl && !isHttpUrl(input.referenceImageUrl), '参考图片地址必须是 HTTP 或 HTTPS URL。');
        fail(input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 4294967295), 'seed 必须是 0–4294967295 的整数。');
        fail([...generations.values()].filter(g => ['queued', 'running'].includes(g.status)).length >= 4, '同时生成的任务过多。', 429);
        const job = { id: randomUUID(), provider: provider.id, exportId: exported.id, status: 'queued', createdAt: new Date().toISOString() };
        generations.set(job.id, job);
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(new Error('生成任务等待超时。')), provider.timeoutMs ?? 15 * 60 * 1000);
        timer.unref();
        setImmediate(async () => {
          job.status = 'running';
          try {
            Object.assign(job, await provider.generate({ exported, input, jobId: job.id, signal: controller.signal }), { status: 'completed', completedAt: new Date().toISOString() });
          } catch (error) { job.status = 'failed'; job.error = redactError(controller.signal.aborted ? controller.signal.reason : error, env); }
          finally { clearTimeout(timer); controllers.delete(controller); }
        });
        return json(response, 202, { ...job });
      }
      const generationRoute = /^\/api\/generations\/([^/]+)$/.exec(pathname);
      if (generationRoute && method === 'GET') {
        const job = generations.get(generationRoute[1]);
        fail(!job, '生成任务不存在。', 404);
        return json(response, 200, job);
      }
      if (pathname.startsWith('/api/')) throw new ApiError(404, '接口不存在。');
      if (pathname.startsWith('/artifacts/')) {
        fail(!['GET', 'HEAD'].includes(method), '不支持的请求方法。', 405);
        const generatedVideo = /^\/artifacts\/generations\/([0-9a-f-]+)\.mp4$/.exec(pathname);
        if (generatedVideo && idPattern.test(generatedVideo[1])) {
          return await sendFile(request, response, join(generationDir, `${generatedVideo[1]}.mp4`));
        }
        const artifact = /^\/artifacts\/([0-9a-f-]+)\/(depth\.mp4|metadata\.json|frames\/\d{5}\.png)$/.exec(pathname);
        fail(!artifact || !idPattern.test(artifact[1]), '文件不存在。', 404);
        return await sendFile(request, response, join(exportDir, artifact[1], artifact[2]));
      }
      fail(!['GET', 'HEAD'].includes(method), '不支持的请求方法。', 405);
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const filePath = resolve(distDir, relative);
      fail(!filePath.startsWith(distDir + sep), '文件不存在。', 404);
      return await sendFile(request, response, filePath);
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { error: redactError(error, env) });
      else response.destroy();
    }
  });
  server.on('close', () => { for (const controller of controllers) controller.abort(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = await createAppServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, '127.0.0.1', () => console.log(`Spatial Studio API: http://127.0.0.1:${port}`));
}
