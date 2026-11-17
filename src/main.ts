import './style.css';
import { createDefaultScene, parseScene, type SceneState, type Vec3 } from './model';
import { SceneViewport } from './scene';
import { api, jsonPost, type ExportRecord, type Provider, type GenerationJob } from './api';
import { exportDepthVideo } from './export';
import { sampleScene, type Motion } from './motion';

const icon = (name: string, size = 18) => {
  const paths: Record<string, string> = {
    box: '<path d="m12 3 9 5v8l-9 5-9-5V8z"/><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5"/>',
    camera: '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3z"/>',
    person: '<circle cx="12" cy="6" r="3"/><path d="M6 21v-5a6 6 0 0 1 12 0v5M9 14v7M15 14v7"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
    upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/>',
    reset: '<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8zm-10 9 10 5 10-5M2 17l10 5 10-5"/>',
    check: '<path d="m5 12 4 4 10-10"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
};
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let state = createDefaultScene();
try { const saved = localStorage.getItem('spatial-video-scene-v1'); if (saved) state = parseScene(JSON.parse(saved)); } catch { /* Recover safely from older or incomplete saved scenes. */ }
let selected: { kind: 'person' | 'camera'; id: string } = { kind: 'person', id: state.people[0].id };
let activeCameraId = state.cameras[0].id;
let mainCameraId: string | undefined;
let previewMode: 'beauty' | 'depth' = 'depth';
let motion: Motion = 'dolly';
let motionAmount = 0.6;
let timeline = 0;
let playing = false;
let exporting = false;
let generating = false;
let lastExport: ExportRecord | null = null;
let lastExportSignature = '';
let providers: Provider[] = [];
let toastTimer: ReturnType<typeof setTimeout>;
let thumbnailTimer: ReturnType<typeof setTimeout>;
let thumbnailRevision = 0;
const thumbnailUrls = new Map<string, string>();

$('#app').innerHTML = `
  <header class="app-header">
    <a class="brand" href="/" aria-label="空间片场首页"><span class="brand-mark">${icon('box', 25)}</span><span>空间片场<small>SPATIAL VIDEO LAB</small></span></a>
    <div class="project-title"><span class="project-dot"></span> 房间实验 <span class="slash">/</span> 场景 01</div>
    <div class="header-actions"><span id="service-state" class="status-pill"><i></i> 连接中</span><button id="import-scene" class="subtle" title="导入场景 JSON">${icon('upload')}<span>导入</span></button><button id="save-scene" class="subtle">${icon('download')}<span>保存场景</span></button><button id="reset-scene" class="icon-button" title="恢复默认场景" aria-label="恢复默认场景">${icon('reset')}</button></div>
  </header>
  <main class="workspace">
    <aside class="panel scene-panel">
      <div class="panel-heading"><span>场景对象</span><span class="tiny-label">SCENE</span></div>
      <div class="room-info">${icon('box', 20)}<div>室内 · 双人对话<small id="room-size"></small></div><span class="count-tag">01</span></div>
      <div class="section-label">人物 <span>02</span></div><div id="people-list" class="object-list"></div>
      <div class="static-object">${icon('layers', 16)}<span>中央桌子</span><span class="fixed-badge">固定</span></div>
      <div class="section-label cameras-label">摄像机 <span>03</span></div><div id="camera-list" class="object-list"></div>
      <div class="inspector-heading"><span>属性</span><span id="selection-kind" class="tiny-label"></span></div>
      <div id="inspector"></div>
      <div class="sidebar-note"><span class="note-symbol">↗</span><p>调整人物站位与机位。<br>所有镜头共享同一个场景。</p></div>
    </aside>
    <section class="stage-column">
      <div class="stage-toolbar"><div class="view-tabs" id="view-tabs"></div><span class="stage-label"><i></i> 实时预览</span></div>
      <div class="stage" id="stage">
        <div class="viewport" id="main-viewport" aria-label="三维场景编辑视图"></div>
        <div class="stage-caption"><span class="eyebrow">SCENE 01</span><strong id="view-title">场景总览</strong><span id="view-hint">拖动旋转 · 滚轮缩放 · 点击选中对象</span></div>
        <div class="axis-legend"><span class="x">X</span><span class="y">Y</span><span class="z">Z</span><small>米 · Y 轴向上</small></div>
        <div id="export-overlay" class="export-overlay" hidden><div class="spinner"></div><strong id="export-message">正在导出深度视频</strong><progress id="export-progress" max="100" value="0"></progress><span>按固定时间步长渲染，界面帧率不影响导出</span></div>
      </div>
      <div class="shots-heading"><span>镜头机位 <small>同一场景，三个视角</small></span><span class="tiny-label">03 SHOTS</span></div>
      <div id="shot-cards" class="shot-cards"></div>
      <div class="stage-footer"><span id="save-status">场景已自动保存到此浏览器</span><span>粗几何 · 独立对象 · 固定坐标系</span></div>
    </section>
    <aside class="panel workflow-panel">
      <div class="panel-heading"><span>镜头输出</span><span class="tiny-label">OUTPUT</span></div>
      <div class="preview-heading"><strong id="preview-title">01 · 正面</strong><div class="segmented"><button id="preview-depth" class="active">深度</button><button id="preview-beauty">白模</button></div></div>
      <div id="preview-viewport" class="preview-viewport" aria-label="当前机位的深度与白模预览"></div>
      <div class="depth-legend"><span>近 · 白</span><div></div><span>远 · 黑</span></div>
      <div class="timeline"><button id="play" class="icon-button" aria-label="播放机位运动">${icon('play', 14)}</button><input id="timeline" aria-label="镜头时间" type="range" min="0" max="1000" value="0"><span id="timeline-label">0.0s</span></div>
      <div class="output-settings">
        <div class="field-row"><label for="motion">机位运动</label><select id="motion"><option value="static">固定机位</option><option value="dolly" selected>缓慢推进</option><option value="arc">小幅环绕</option></select></div>
        <div class="field-row"><label id="amount-label" for="motion-amount">推进距离 / 米</label><input id="motion-amount" type="number" min="0" max="3" step="0.1" value="0.6"></div>
        <div class="field-row"><label>深度范围 / 米</label><div class="two-fields"><input id="depth-near" type="number" aria-label="深度近端" min="0.01" step="0.1"><span>—</span><input id="depth-far" type="number" aria-label="深度远端" min="0.1" step="0.5"></div></div>
        <div class="field-row"><label for="resolution">导出尺寸</label><select id="resolution"><option value="640x360">640 × 360 · 快速验证</option><option value="854x480">854 × 480</option><option value="1280x720">1280 × 720</option></select></div>
        <div class="field-row"><label for="frames">时长 / 16 fps</label><select id="frames"><option value="81">约 5 秒 · 81 帧</option><option value="161">约 10 秒 · 161 帧</option></select></div>
      </div>
      <button id="export-video" class="primary-button">${icon('download')} 导出当前机位深度视频</button>
      <div class="export-links" id="export-links" hidden></div>
      <p class="microcopy">MP4 + 场景与逐帧相机参数。原始 PNG 帧保存在本地。</p>
      <div class="generation-heading"><span class="step-number">02</span><strong>视频生成</strong><span class="optional-tag">可选</span></div>
      <label class="block-label" for="provider">生成服务</label><select id="provider"><option value="mock">本地模拟 · 无需密钥</option></select>
      <p id="provider-description" class="provider-note">验证任务流程，返回深度预览，不调用生成模型。</p>
      <label class="block-label" for="prompt">画面描述</label><textarea id="prompt" rows="3">明亮的现代房间，两个人站在桌子两侧交谈。保持人物站位、桌子位置和镜头构图，动作自然克制。</textarea>
      <div id="reference-fields"><label class="block-label" for="reference">外观参考图 URL <span>可选</span></label><input id="reference" type="url" placeholder="https://…" autocomplete="off"></div>
      <button id="generate" class="secondary-button" disabled>先导出深度视频 ${icon('arrow',16)}</button>
      <div id="generation-result" class="generation-result" hidden></div>
    </aside>
  </main>
  <input type="file" id="scene-file" accept="application/json,.json" hidden>
  <div id="toast" role="status" aria-live="polite" hidden></div>
`;

let viewport: SceneViewport;
let preview: SceneViewport;
try {
  viewport = new SceneViewport($('#main-viewport'), { interactive: true, onSelect: (kind, id) => { if (!exporting) selectObject(kind, id); } });
  preview = new SceneViewport($('#preview-viewport'), { interactive: false });
} catch (error) {
  $('#main-viewport').innerHTML = `<div class="webgl-error">无法启动三维预览，请使用支持 WebGL 2 的浏览器并开启硬件加速。<small>${esc(String(error))}</small></div>`;
  throw error;
}

function notify(message: string, error = false) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.toggle('error', error); toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 6500 : 3500);
}
function signature() {
  return JSON.stringify({ state, activeCameraId, motion, motionAmount, resolution: $<HTMLSelectElement>('#resolution').value, frames: $<HTMLSelectElement>('#frames').value });
}
function persist() {
  try { localStorage.setItem('spatial-video-scene-v1', JSON.stringify(state)); $('#save-status').textContent = '场景已自动保存到此浏览器'; }
  catch { $('#save-status').textContent = '浏览器存储不可用，请使用「保存场景」'; }
}
function updateGenerateButton() {
  const button = $<HTMLButtonElement>('#generate');
  const provider = providers.find(item => item.id === $<HTMLSelectElement>('#provider').value);
  const fresh = !!lastExport && signature() === lastExportSignature;
  button.disabled = !fresh || exporting || generating || !provider?.configured;
  button.innerHTML = `${generating ? '正在处理…' : !fresh ? (lastExport ? '场景已变化，请重新导出' : '先导出深度视频') : !provider?.configured ? '请先配置生成服务' : provider.id === 'mock' ? '运行本地模拟' : '提交视频生成'} ${icon('arrow', 16)}`;
}
function selectObject(kind: 'person' | 'camera', id: string) {
  selected = { kind, id };
  if (kind === 'camera') { activeCameraId = id; mainCameraId = id; timeline = 0; }
  renderLists(); renderInspector(); updateViews(); updateGenerateButton();
}
function renderLists() {
  $('#room-size').textContent = `${state.room.width} × ${state.room.depth} × ${state.room.height} m`;
  $('#people-list').innerHTML = state.people.map(person => `<button class="object-item ${selected.id === person.id ? 'selected' : ''}" data-select-person="${esc(person.id)}"><span class="person-dot" style="--person-color:${esc(person.color)}">${icon('person', 17)}</span><span>${esc(person.name)}</span><span class="item-end">人物</span></button>`).join('');
  $('#camera-list').innerHTML = state.cameras.map((camera, i) => `<button class="object-item ${selected.id === camera.id ? 'selected' : ''}" data-select-camera="${esc(camera.id)}"><span class="camera-number">0${i + 1}</span><span>${esc(camera.name)}</span>${icon('camera', 15)}</button>`).join('');
  $('#view-tabs').innerHTML = `<button data-view="overview" class="${!mainCameraId ? 'active' : ''}">${icon('box', 15)} 总览</button>` + state.cameras.map((camera, i) => `<button data-view="${esc(camera.id)}" class="${mainCameraId === camera.id ? 'active' : ''}">0${i + 1} ${esc(camera.name)}</button>`).join('');
  $('#shot-cards').innerHTML = state.cameras.map((camera, i) => `<button class="shot-card ${activeCameraId === camera.id ? 'active' : ''}" data-shot="${esc(camera.id)}"><div class="shot-image">${thumbnailUrls.get(camera.id) ? `<img src="${thumbnailUrls.get(camera.id)}" alt="${esc(camera.name)}机位预览">` : '<span>正在准备预览</span>'}<span class="shot-index">0${i + 1}</span>${activeCameraId === camera.id ? `<span class="shot-selected">${icon('check', 12)} 当前</span>` : ''}</div><div class="shot-info"><strong>${esc(camera.name)}</strong><span>${camera.fov}° FOV ${icon('arrow', 13)}</span></div></button>`).join('');
}
function vectorInputs(label: string, field: string, vec: Vec3) {
  return `<div class="property"><label>${label}<span>m</span></label><div class="vector-fields">${vec.map((v, i) => `<label class="vector-input axis-${i}"><span>${['X','Y','Z'][i]}</span><input type="number" step="0.1" value="${Number(v.toFixed(3))}" data-field="${field}" data-axis="${i}" aria-label="${label} ${['X','Y','Z'][i]}"></label>`).join('')}</div></div>`;
}
function renderInspector() {
  const person = state.people.find(item => item.id === selected.id);
  const camera = state.cameras.find(item => item.id === selected.id);
  $('#selection-kind').textContent = selected.kind === 'person' ? 'PERSON' : 'CAMERA';
  if (person && selected.kind === 'person') {
    $('#inspector').innerHTML = `<div class="selected-name"><span style="background:${esc(person.color)}"></span>${esc(person.name)}</div>${vectorInputs('位置', 'position', person.position)}<div class="property"><label>朝向<span>°</span></label><div class="heading-control"><input type="range" min="-180" max="180" value="${person.rotation}" data-field="rotation" aria-label="人物朝向滑杆"><input type="number" min="-180" max="180" step="5" value="${person.rotation}" data-field="rotation" aria-label="人物朝向"></div></div><div class="property"><label>身高<span>m</span></label><input type="number" min="0.5" max="2.5" step="0.05" value="${person.height}" data-field="height" aria-label="人物身高"></div><p class="inspector-hint">X / Z 控制地面上的站位，Y 控制高度。默认 Y = 0 表示站在地面上。</p>`;
  } else if (camera) {
    $('#inspector').innerHTML = `<div class="selected-name">${icon('camera',16)}${esc(camera.name)}</div>${vectorInputs('相机位置', 'position', camera.position)}${vectorInputs('注视目标', 'target', camera.target)}<div class="property"><label>视场角<span>°</span></label><div class="heading-control"><input type="range" min="20" max="100" step="1" value="${camera.fov}" data-field="fov" aria-label="视场角滑杆"><input type="number" min="20" max="100" value="${camera.fov}" data-field="fov" aria-label="视场角"></div></div><p class="inspector-hint">相机位置决定机位，注视目标决定镜头朝向。较小视场角会让构图更紧。</p>`;
  }
}
function refreshScene() {
  viewport.update(state); preview.update(state); renderLists(); renderInspector(); updateViews(); persist(); scheduleThumbnails(); updateGenerateButton();
  $<HTMLInputElement>('#depth-near').value = String(state.depth.near);
  $<HTMLInputElement>('#depth-far').value = String(state.depth.far);
}
function updateViews() {
  const camera = state.cameras.find(item => item.id === activeCameraId)!;
  viewport.render(mainCameraId, 'beauty');
  viewport.setSelected(selected.kind, selected.id);
  preview.update(sampleScene(state, activeCameraId, timeline, motion, motionAmount)); preview.render(activeCameraId, previewMode);
  $('#view-title').textContent = mainCameraId ? state.cameras.find(c => c.id === mainCameraId)!.name : '场景总览';
  $('#view-hint').textContent = mainCameraId ? '通过左侧属性调整机位与注视目标' : '拖动旋转 · 滚轮缩放 · 点击选中对象';
  $('#preview-title').textContent = `0${state.cameras.indexOf(camera) + 1} · ${camera.name}`;
  $<HTMLInputElement>('#timeline').value = String(Math.round(timeline * 1000));
  $('#timeline-label').textContent = `${(timeline * (Number($<HTMLSelectElement>('#frames').value) - 1) / 16).toFixed(1)}s`;
}
function scheduleThumbnails() {
  clearTimeout(thumbnailTimer); const revision = ++thumbnailRevision;
  thumbnailTimer = setTimeout(async () => {
    if (exporting) return;
    try {
      for (const camera of state.cameras) {
        if (revision !== thumbnailRevision || exporting) return;
        const blob = await viewport.capture(camera.id, 384, 216, 'beauty');
        if (revision !== thumbnailRevision || exporting) return;
        const old = thumbnailUrls.get(camera.id); if (old) URL.revokeObjectURL(old);
        thumbnailUrls.set(camera.id, URL.createObjectURL(blob));
      }
      renderLists();
    } catch (error) { console.warn('镜头缩略图未更新', error); }
  }, 180);
}

document.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-select-person],[data-select-camera],[data-view],[data-shot]');
  if (!target || exporting) return;
  if (target.dataset.selectPerson) selectObject('person', target.dataset.selectPerson);
  else if (target.dataset.selectCamera) selectObject('camera', target.dataset.selectCamera);
  else if (target.dataset.shot) selectObject('camera', target.dataset.shot);
  else if (target.dataset.view === 'overview') { mainCameraId = undefined; renderLists(); updateViews(); }
  else if (target.dataset.view) selectObject('camera', target.dataset.view);
});
$('#inspector').addEventListener('change', event => {
  if (exporting) return;
  const input = event.target as HTMLInputElement; const field = input.dataset.field;
  if (!field) return;
  const next = structuredClone(state);
  const obj = (selected.kind === 'person' ? next.people : next.cameras).find(item => item.id === selected.id)!;
  const value = Number(input.value);
  if (!Number.isFinite(value) || input.value.trim() === '') { notify('请输入有效的数值', true); renderInspector(); return; }
  if (input.dataset.axis !== undefined) (obj as unknown as Record<string, Vec3>)[field][Number(input.dataset.axis)] = value;
  else (obj as unknown as Record<string, number>)[field] = value;
  try { state = parseScene(next); timeline = 0; refreshScene(); }
  catch (error) { notify((error as Error).message, true); renderInspector(); }
});
for (const mode of ['depth', 'beauty'] as const) $(`#preview-${mode}`).addEventListener('click', () => {
  if (exporting) return;
  previewMode = mode; $('#preview-depth').classList.toggle('active', mode === 'depth'); $('#preview-beauty').classList.toggle('active', mode === 'beauty'); updateViews();
});
$<HTMLInputElement>('#timeline').addEventListener('input', event => { if (!exporting) { timeline = Number((event.target as HTMLInputElement).value) / 1000; updateViews(); } });
$('#play').addEventListener('click', () => { playing = !playing; if (timeline >= 1) timeline = 0; $('#play').innerHTML = icon(playing ? 'pause' : 'play', 14); $('#play').setAttribute('aria-label', playing ? '暂停机位运动' : '播放机位运动'); });
let previousTime = performance.now();
function tick(now: number) {
  const delta = (now - previousTime) / 1000; previousTime = now;
  if (playing && !exporting) {
    timeline += Math.min(delta, 0.1) / ((Number($<HTMLSelectElement>('#frames').value) - 1) / 16);
    if (timeline >= 1) timeline = 0;
    updateViews();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
$<HTMLSelectElement>('#motion').addEventListener('change', event => {
  motion = (event.target as HTMLSelectElement).value as Motion; motionAmount = motion === 'arc' ? 12 : 0.6;
  const input = $<HTMLInputElement>('#motion-amount'); input.value = String(motionAmount); input.max = motion === 'arc' ? '45' : '3'; input.step = motion === 'arc' ? '1' : '0.1'; input.disabled = motion === 'static';
  $('#amount-label').textContent = motion === 'arc' ? '环绕角度 / °' : '推进距离 / 米'; timeline = 0; updateViews(); updateGenerateButton();
});
$<HTMLInputElement>('#motion-amount').addEventListener('change', event => {
  const input = event.target as HTMLInputElement; const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0 || value > (motion === 'arc' ? 45 : 3)) { input.value = String(motionAmount); notify('运动幅度超出范围', true); return; }
  motionAmount = value; updateViews(); updateGenerateButton();
});
for (const key of ['near', 'far'] as const) $(`#depth-${key}`).addEventListener('change', event => {
  const next = structuredClone(state); next.depth[key] = Number((event.target as HTMLInputElement).value);
  try { state = parseScene(next); refreshScene(); } catch (error) { notify((error as Error).message, true); $<HTMLInputElement>(`#depth-${key}`).value = String(state.depth[key]); }
});
for (const id of ['resolution', 'frames']) $(`#${id}`).addEventListener('change', () => { updateViews(); updateGenerateButton(); });

function downloadJSON(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#save-scene').addEventListener('click', () => { downloadJSON(state, 'spatial-scene.json'); notify('场景已保存，包含人物与三个机位'); });
$('#import-scene').addEventListener('click', () => { if (!exporting) $<HTMLInputElement>('#scene-file').click(); });
$('#scene-file').addEventListener('change', async event => {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error('场景文件过大，请选择小于 1 MB 的 JSON');
    state = parseScene(JSON.parse(await file.text())); selected = { kind: 'person', id: state.people[0].id }; activeCameraId = state.cameras[0].id; mainCameraId = undefined; timeline = 0;
    refreshScene(); notify('已导入场景');
  } catch (error) { notify(`无法导入：${(error as Error).message}`, true); }
  input.value = '';
});
$('#reset-scene').addEventListener('click', () => {
  if (exporting) return;
  state = createDefaultScene(); selected = { kind: 'person', id: state.people[0].id }; activeCameraId = state.cameras[0].id; mainCameraId = undefined; timeline = 0; refreshScene(); notify('已恢复默认场景');
});
function setExporting(value: boolean) {
  exporting = value;
  $('#export-overlay').hidden = !value;
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('.scene-panel input,.scene-panel button,.stage-column button,.output-settings input,.output-settings select,#export-video,#timeline,#play,#preview-depth,#preview-beauty,#import-scene,#reset-scene').forEach(el => { el.disabled = value; });
  if (!value) $<HTMLInputElement>('#motion-amount').disabled = motion === 'static';
  updateGenerateButton();
}
$('#export-video').addEventListener('click', async () => {
  if (exporting) return;
  playing = false; $('#play').innerHTML = icon('play',14); timeline = 0; ++thumbnailRevision; clearTimeout(thumbnailTimer);
  const [width, height] = $<HTMLSelectElement>('#resolution').value.split('x').map(Number);
  const snapshotSignature = signature();
  const options = { width, height, fps: 16, numFrames: Number($<HTMLSelectElement>('#frames').value), cameraId: activeCameraId, motion, amount: motionAmount };
  setExporting(true);
  try {
    const result = await exportDepthVideo(viewport, state, options, (done, total, message) => { $('#export-message').textContent = message; $<HTMLProgressElement>('#export-progress').value = done / total * 100; });
    lastExport = { ...result, ...options }; lastExportSignature = snapshotSignature;
    const links = $('#export-links'); links.hidden = false;
    links.innerHTML = `<span>${icon('check',14)} 深度视频已导出</span><a href="${esc(result.videoUrl)}" download>下载 MP4</a><a href="${esc(result.metadataUrl)}" download>场景参数</a>`;
    notify('导出完成：深度 MP4、原始帧与场景参数已保存');
  } catch (error) { notify(`导出失败：${(error as Error).message}`, true); }
  finally { setExporting(false); viewport.update(state); updateViews(); scheduleThumbnails(); }
});

function updateProvider() {
  const provider = providers.find(item => item.id === $<HTMLSelectElement>('#provider').value);
  $('#reference-fields').hidden = provider?.acceptsReferenceImage === false;
  $('#provider-description').textContent = provider?.description || '正在读取服务配置'; updateGenerateButton();
}
$('#provider').addEventListener('change', updateProvider);
function safeVideoUrl(value: string) {
  const url = new URL(value, location.origin);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('生成服务返回了无效的视频地址');
  return url.href;
}
$('#generate').addEventListener('click', async () => {
  if (!lastExport || exporting || generating || signature() !== lastExportSignature) return;
  const prompt = $<HTMLTextAreaElement>('#prompt').value.trim();
  if (!prompt) { notify('请填写画面描述', true); return; }
  const referenceImageUrl = $('#reference-fields').hidden ? '' : $<HTMLInputElement>('#reference').value.trim();
  if (referenceImageUrl) { try { const u = new URL(referenceImageUrl); if (!['https:', 'http:'].includes(u.protocol)) throw new Error(); } catch { notify('参考图需要有效的 HTTP 或 HTTPS 地址', true); return; } }
  generating = true; updateGenerateButton();
  const panel = $('#generation-result'); panel.hidden = false; panel.textContent = '任务提交中…';
  try {
    let job = await jsonPost<GenerationJob>('/api/generations', { provider: $<HTMLSelectElement>('#provider').value, exportId: lastExport.id, prompt, referenceImageUrl: referenceImageUrl || undefined, seed: 42 });
    for (let attempt = 0; !['completed', 'failed'].includes(job.status); attempt++) {
      if (attempt >= 900) throw new Error(`任务 ${job.id} 尚未完成，请查询服务端任务状态`);
      panel.textContent = job.status === 'queued' ? '任务排队中…' : '正在生成视频…';
      await new Promise(resolve => setTimeout(resolve, 2000)); job = await api<GenerationJob>(`/api/generations/${job.id}`);
    }
    if (job.status === 'failed' || !job.videoUrl) throw new Error(job.error || '生成任务失败');
    const videoUrl = safeVideoUrl(job.videoUrl);
    const isMock = job.mock || job.provider === 'mock';
    panel.innerHTML = `<div class="result-label">${icon('check',14)} ${isMock ? '模拟完成 · 以下是深度预览' : '视频生成完成'}</div><video controls playsinline preload="metadata" src="${esc(videoUrl)}"></video><a href="${esc(videoUrl)}" target="_blank" rel="noopener noreferrer">打开视频 ${icon('arrow',12)}</a>${isMock ? '<p>已验证接口与任务流程，未调用外部模型。</p>' : ''}`;
    notify(isMock ? '本地模拟已完成，未产生模型调用' : '视频生成完成');
  } catch (error) { panel.textContent = (error as Error).message; notify(`任务失败：${(error as Error).message}`, true); }
  finally { generating = false; updateGenerateButton(); }
});

refreshScene();
async function connect() {
  try {
    const [health, listing] = await Promise.all([api<Record<string, unknown>>('/api/health'), api<{ providers: Provider[] }>('/api/providers')]);
    providers = listing.providers;
    $<HTMLSelectElement>('#provider').innerHTML = providers.map(provider => `<option value="${esc(provider.id)}">${esc(provider.name)}${provider.configured ? '' : ' · 未配置'}</option>`).join('');
    $('#service-state').innerHTML = '<i></i> 本地运行'; updateProvider();
    if (health.ffmpegAvailable === false) notify('未检测到视频编码器，请按 README 配置 FFMPEG_PATH', true);
  } catch (error) { $('#service-state').innerHTML = '<i></i> 服务未连接'; $('#service-state').classList.add('offline'); notify(`本地服务未连接：${(error as Error).message}`, true); }
}
void connect();
