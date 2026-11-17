import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAppServer } from '../server/server.mjs';
import { resolveFfmpeg, checkFfmpeg } from '../server/encoder.mjs';
import { createProviders, redactError } from '../server/providers.mjs';

const run = promisify(execFile);
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type);
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([header, name, bytes, crc]);
}
function png(width, height, gray) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, gray);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
async function setup(t, options = {}) {
  const dataDir = options.dataDir || await mkdtemp(join(tmpdir(), 'spatial-studio-test-'));
  const server = await createAppServer({ dataDir, env: {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (!options.dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  return { server, base, dataDir };
}
function post(base, pathname, data) {
  return fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}
const spec = { scene: { version: 1, cameras: [{ id: 'camera-1', position: [0, 2, 5], target: [0, 1, 0], fov: 48 }] }, cameraId: 'camera-1', width: 32, height: 24, fps: 16, numFrames: 3, depthNear: 0.2, depthFar: 12, motion: 'arc', amount: 90 };

test('exports encode ordered PNG frames, serve seekable MP4, and survive restart', async t => {
  const ffmpeg = await resolveFfmpeg();
  assert.equal(await checkFfmpeg(ffmpeg), true, 'FFmpeg is required for the video export integration test');
  const { base, dataDir } = await setup(t);
  const created = await post(base, '/api/exports', spec);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await post(base, `/api/exports/${id}/complete`, {})).status, 400, 'incomplete exports must not encode');
  const wrongSize = await fetch(`${base}/api/exports/${id}/frames/0`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png(16, 16, 0) });
  assert.equal(wrongSize.status, 400);
  for (const [i, gray] of [15, 120, 235].entries()) {
    const response = await fetch(`${base}/api/exports/${id}/frames/${i}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png(spec.width, spec.height, gray) });
    assert.equal(response.status, 200);
  }
  const finished = await post(base, `/api/exports/${id}/complete`, {});
  assert.equal(finished.status, 200, await finished.clone().text());
  const record = await finished.json();
  assert.equal(record.status, 'completed');
  assert.equal(record.cameraId, spec.cameraId);
  assert.equal(record.numFrames, 3);
  assert.equal(record.directory, undefined, 'internal filesystem paths stay private');
  const bytes = await readFile(join(dataDir, 'exports', id, 'depth.mp4'));
  assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
  const range = await fetch(base + record.videoUrl, { headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 32);
  const metadata = await (await fetch(base + record.metadataUrl)).json();
  assert.equal(metadata.depthEncoding, 'linear-camera-z-near-white-far-black');
  assert.deepEqual(metadata.scene, spec.scene);
  assert.equal(metadata.motion, 'arc');
  assert.equal(metadata.amount, 90);
  assert.equal(metadata.frameCameraPoses.length, spec.numFrames);
  assert.deepEqual(metadata.frameCameraPoses[0].position, [0, 2, 5]);
  assert.ok(Math.abs(metadata.frameCameraPoses[2].position[0] + 5) < 1e-9);
  assert.ok(Math.abs(metadata.frameCameraPoses[2].position[2]) < 1e-9);
  assert.equal(metadata.frameCameraPoses[2].timeSeconds, 2 / spec.fps);
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', join(dataDir, 'exports', id, 'depth.mp4'), '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { encoding: 'buffer', windowsHide: true });
  const pixels = spec.width * spec.height;
  assert.equal(stdout.length, pixels * spec.numFrames, 'decoded frame count and dimensions');
  const means = Array.from({ length: 3 }, (_, i) => stdout.subarray(i * pixels, (i + 1) * pixels).reduce((sum, v) => sum + v, 0) / pixels);
  assert.ok(means[0] < means[1] && means[1] < means[2], 'grayscale depth ordering survives encoding');
  const restarted = await setup(t, { dataDir });
  const listed = await (await fetch(restarted.base + '/api/exports')).json();
  assert.equal(listed.exports[0].id, id);
  const jobResponse = await post(restarted.base, '/api/generations', { provider: 'mock', exportId: id, prompt: '保持人物位置' });
  assert.equal(jobResponse.status, 202);
  const jobId = (await jobResponse.json()).id;
  let job;
  for (let i = 0; i < 20; i++) {
    job = await (await fetch(restarted.base + `/api/generations/${jobId}`)).json();
    if (job.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'completed');
  assert.equal(job.mock, true, 'mock output must be explicitly identified');
  assert.equal(job.videoUrl, record.videoUrl);
});

test('validates settings and refuses cross-origin writes and traversal', async t => {
  const { base } = await setup(t);
  for (const invalid of [{ width: 33 }, { numFrames: 242 }, { fps: 31 }, { depthFar: 0.1 }]) {
    assert.equal((await post(base, '/api/exports', { ...spec, ...invalid })).status, 400);
  }
  const foreign = await fetch(base + '/api/exports', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
  assert.equal(foreign.status, 403);
  assert.equal((await fetch(base + '/artifacts/%2e%2e%2fpackage.json')).status, 404);
  assert.equal((await fetch(base + '/api/generations/unknown')).status, 404);
  const providers = await (await fetch(base + '/api/providers')).json();
  assert.equal(providers.providers.find(p => p.id === 'mock').configured, true);
  assert.equal(providers.providers.find(p => p.id === 'fal').configured, false);
  assert.equal((await post(base, '/api/generations', { provider: 'fal', exportId: 'bad', prompt: 'test' })).status, 400);
});

test('provider failures do not expose configured credentials', () => {
  const safe = redactError(new Error('Key secret-value; Bearer access-token'), { FAL_KEY: 'secret-value' });
  assert.ok(!safe.includes('secret-value'));
  assert.ok(!safe.includes('access-token'));
});

test('HTTP adapter accepts a local replacement provider with multipart contract', async t => {
  const http = await import('node:http');
  let captured;
  const upstream = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    captured = { headers: req.headers, body: Buffer.concat(parts).toString() };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ videoUrl: 'https://example.com/result.mp4' }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'spatial-provider-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const videoPath = join(directory, 'depth.mp4'); await writeFile(videoPath, 'local test bytes');
  const provider = createProviders({ VIDEO_API_URL: `http://127.0.0.1:${upstream.address().port}/generate`, VIDEO_API_KEY: 'test-token' }).find(p => p.id === 'http');
  const result = await provider.generate({ exported: { ...spec, id: 'example-export', videoPath }, input: { prompt: '人物位置保持一致', seed: 42 } });
  assert.equal(result.videoUrl, 'https://example.com/result.mp4');
  assert.equal(captured.headers.authorization, 'Bearer test-token');
  assert.match(captured.headers['content-type'], /^multipart\/form-data;/);
  assert.match(captured.body, /name="video"; filename="depth.mp4"/);
  assert.match(captured.body, /linear-camera-z-near-white-far-black/);
});
