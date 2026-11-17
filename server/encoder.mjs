import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function resolveFfmpeg(explicit) {
  if (explicit) return explicit;
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const { default: installed } = await import('ffmpeg-static');
    if (installed) { await access(installed); return installed; }
  } catch { /* A system installation is also supported. */ }
  return 'ffmpeg';
}

function run(executable, args, { timeout = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('视频编码超时。')); }, timeout);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
    child.once('error', error => {
      clearTimeout(timer);
      if (signal?.aborted) { reject(signal.reason); return; }
      reject(new Error(error.code === 'ENOENT' ? '未找到 FFmpeg，请安装 ffmpeg-static 或配置 FFMPEG_PATH。' : '无法启动视频编码器。'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`视频编码失败（${code}）：${stderr.slice(-1000)}`));
    });
  });
}

export async function resampleControlVideo(executable, input, output, fps, frames, signal) {
  await run(executable, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vf', `fps=${fps},tpad=stop_mode=clone:stop_duration=15`,
    '-frames:v', String(frames), '-an', '-c:v', 'libx264', '-preset', 'fast',
    '-crf', '12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
  ], { signal });
}

export async function checkFfmpeg(executable) {
  try { await run(executable, ['-version'], { timeout: 5000 }); return true; }
  catch { return false; }
}

export async function encodeVideo(exported, executable) {
  const output = join(exported.directory, 'depth.mp4');
  await run(executable, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(exported.fps),
    '-start_number', '0',
    '-i', join(exported.directory, 'frames', '%05d.png'),
    '-frames:v', String(exported.numFrames),
    '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '12',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
  ]);
  if ((await stat(output)).size < 32) throw new Error('编码器没有生成有效视频。');
  return output;
}
