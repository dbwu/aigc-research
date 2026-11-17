# 空间片场 · Spatial Video Lab

本地空间一致性验证原型：一间房、两个人、一张桌子、正面／侧面／过肩三个机位。调整人物和相机，预览共用场景，逐帧导出深度视频，再交给可替换的视频生成服务。场景编辑、导出和本地模拟均不需要模型密钥。

## 启动

需要 **Node.js 22.12 或更高版本**、pnpm（也可以使用 npm），以及支持 WebGL 2 的现代浏览器。

```powershell
pnpm install
pnpm dev
```

打开 **http://127.0.0.1:3210**。开发命令同时启动前端和 `127.0.0.1:8787` 本地服务。使用 npm 时，对应命令为 `npm install`、`npm run dev`。

依赖安装完成后，也可以直接运行 `node scripts/dev.mjs`，无需依赖包管理器的启动命令。

依赖中的 `ffmpeg-static` 会在安装时下载视频编码器。如果下载失败或安装器禁用了安装脚本，可以安装系统 FFmpeg，或复制环境配置并设置可执行文件路径：

```powershell
Copy-Item .env.example .env
```

```dotenv
FFMPEG_PATH=C:/tools/ffmpeg/bin/ffmpeg.exe
```

修改 `.env` 后重启服务。没有 FFmpeg 时仍可编辑场景，但不能合成 MP4。

构建后只运行本地服务：

```powershell
pnpm build
pnpm start
```

此时打开 **http://127.0.0.1:8787**。服务仅监听本机，不是已部署的公网应用。

## 一次完整实验

1. 在左侧选择人物，修改位置、朝向和身高；选择相机，修改位置、注视目标和视场角。在总览中可拖动旋转、滚轮缩放，也可点击人物或相机选中。
2. 点击三个镜头卡片，比较相同布局在不同机位下的投影。右侧可切换白模和深度预览。
3. 选择固定机位、缓慢推进或小幅环绕；拖动时间条或播放预览。运动只作用于当前相机，人物保持站位。
4. 设置共同的深度近端／远端，选择导出尺寸与帧数，点击「导出当前机位深度视频」。导出使用固定时间采样，不依赖界面实际播放帧率。
5. 导出完成后下载 MP4 和场景参数，或选择「本地模拟」检查提交、任务状态和视频回传流程。**模拟返回已有深度视频，不是 AI 生成结果。**
6. 接入生成服务后填写画面描述，再提交视频生成。支持外观参考图的服务会显示对应输入框。修改场景、机位、运动或导出参数后，需要重新导出，避免提交旧的控制视频。

场景会自动保存在当前浏览器的 `localStorage`。顶部「保存场景」导出 JSON，「导入」恢复 JSON，「恢复默认场景」重置当前布局。浏览器场景保存不包含外部密钥，也不等于保存生成任务。

## 场景与深度约定

- 坐标系为 **Y 轴向上**，房间以 XZ 平面原点为中心，正面是 +Z；数值单位约定为米。人物位置表示脚底位置，朝向是绕 Y 轴的角度，0° 面向 +Z。
- 房间采用无天花板、正面开放的剖视表达；侧墙和后墙只显示内侧，便于从室外机位观察室内。这不是封闭建筑模型。
- 深度取相机空间中的 **Z 向距离**，不是到相机光心的欧氏距离。编码为 `I = 1 - clamp((z - near) / (far - near), 0, 1)`：近处白、远处黑。所有帧使用同一组 near／far，不逐帧自动拉伸灰度。
- 导出不包含编辑器的网格、选中标记和相机辅助线；深度不经过光照、色调映射或显示伽马处理。
- 每次导出的 `metadata.json` 保存场景快照、运动类型与幅度，以及 `frameCameraPoses` 逐帧位置、注视目标、视场角和时间戳，便于重现实验。
- PNG 是 **8 位灰度值以 RGB 通道保存的无损压缩帧**；MP4 为 H.264 CRF 12、yuv420p，有损压缩方便外部视频服务使用。MP4 不能作为精确深度数据存档；PNG 同样存在 8 位量化，超出范围会截断。空背景与远端均为黑色。

本原型的几何是已知粗场景。没有从真实照片恢复尺度，也没有实现自动建图、骨骼动作、物理碰撞或人物身份保持。

## 外部视频服务

服务配置放在项目根目录的 `.env`，仅由服务端读取。前端只获取服务名称和是否已配置；不要给密钥添加 `VITE_` 前缀。

### fal 深度控制

```dotenv
FAL_KEY=填写你的服务密钥
FAL_ENDPOINT=fal-ai/wan-22-vace-fun-a14b/depth
```

适配器上传本地深度 MP4，按导出帧数和帧率提交；`preprocess:false` 表示已提供控制深度，外观参考图映射到 `ref_image_urls`。界面默认的 81／161 帧适用于当前适配器，外部请求只会在点击提交后发生。

**此默认 fal 托管接口已公告将于 2027-01-04 下线，适合短期验证。** `FAL_ENDPOINT` 只能直接替换为输入输出契约兼容的接口；如果新服务没有相同的深度控制能力，应修改适配器，不能把普通参考视频接口当作等价替换。[接口文档与下线公告](https://fal.ai/models/fal-ai/wan-22-vace-fun-a14b/depth/api)

真实外部生成需要相应服务权限和额度。项目本地测试不会调用付费模型；未配置有效密钥时，真实生成效果未验证。

### 自定义 HTTP 服务

```dotenv
VIDEO_API_URL=https://your-service.example/generate
VIDEO_API_KEY=可选的服务密钥
```

适配器向此地址发送一次 `multipart/form-data` POST：

| 字段 | 内容 |
| --- | --- |
| `video` | 名为 `depth.mp4` 的控制视频文件 |
| `prompt` | 画面描述文本 |
| `metadata` | JSON 字符串：导出 ID、机位、宽高、帧率、帧数、深度范围与编码、参考图 URL 和 seed |

配置密钥时使用 `Authorization: Bearer …`。服务必须在 15 分钟内返回 HTTP JSON：

```json
{ "videoUrl": "https://your-service.example/results/video.mp4" }
```

需要提交／轮询的第三方队列，应该在适配器内部处理。浏览器始终通过统一的本地任务接口查询状态。

### 自建 ComfyUI · MiniMax H3 深度控制

1. 在运行 ComfyUI 的机器上打开模板库，加载 **MiniMax H3 Fun ControlNet Union**，在模板中选好本机可用的 H3、VAE、文本编码器和 ControlNet 权重。保留原生 **Load Video**、**MiniMax H3 Reference to Video**、**Apply MiniMax H3 Fun ControlNet** 和 **Save Video**。将 Save Video 的格式设为 MP4、编码设为 H.264，保留 Create Video 的 24 fps。
2. 在 ComfyUI 选择 **文件 → 导出 (API)**。将 JSON 复制到运行空间片场的机器，放在本项目根目录并命名为 `comfyui-h3.api.json`。API 文件以节点 ID 为键，值包含 `class_type` 和 `inputs`。
3. 在项目根目录 `.env` 填写 ComfyUI 服务地址并重启空间片场。空间片场的后端需要能访问这个地址，工作流 JSON 放在空间片场所在的机器上即可。

   ```dotenv
   COMFYUI_URL=http://你的ComfyUI内网地址:8188
   COMFYUI_WORKFLOW_PATH=./comfyui-h3.api.json
   ```

   默认自动找唯一的 Load Video 和 Save Video。如有多个，分别用 `COMFYUI_VIDEO_NODE` 和 `COMFYUI_OUTPUT_NODE` 指定 API JSON 中的节点 ID。使用 Bearer 鉴权的反向代理可设置 `COMFYUI_API_KEY`。
4. 在空间片场导出一个机位的深度视频，选择 **ComfyUI · MiniMax H3**，填写画面描述并点击「提交视频生成」。完成后，生成 MP4 会保存在 `data/generations/`，并出现在页面的视频播放器里。

桥接将深度视频重采样为 24 fps。默认的 81 帧和 161 帧导出分别适配为 124 和 243 帧，尾部不足时补最后一帧。每次只运行选定 Save Video 所需的节点，并把上传视频的帧直接连到 ControlNet。官方模板里用于示例的姿态提取会被跳过，工作流文件可继续在 ComfyUI 编辑。页面传入画面描述，分辨率及模型权重由工作流决定。等待上限为 30 分钟，超时后可在 ComfyUI 队列查看原任务。

[ComfyUI 官方模板说明](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-fun-controlnet) · [自建 API 文档](https://docs.comfy.org/development/comfyui-server/comms_routes)

### 新增适配器

在 `server/providers.mjs` 的 `createProviders()` 中注册对象，实现 `id`、`name`、`description`、`configured()` 和 `async generate({ exported, input, signal })`。成功时返回 `{ videoUrl }`；失败时抛出错误。`exported.videoPath` 指向本地深度视频，`input` 包含提示词、参考图和 seed。无需修改场景渲染或导出模块。

## 文件与模块

| 位置 | 用途 |
| --- | --- |
| `src/model.ts` | 场景结构、默认布局、输入校验 |
| `src/scene.ts` | Three.js 场景、相机、线性深度渲染与 PNG 捕获 |
| `src/motion.ts` | 预览与导出共用的相机运动采样 |
| `src/export.ts` | 固定时间步逐帧渲染、上传和合成请求 |
| `src/main.ts` | 编辑界面、场景保存、导出与生成状态 |
| `server/server.mjs` | 本地 API、文件服务与生成任务管理 |
| `server/encoder.mjs` | FFmpeg 查找与 MP4 编码 |
| `server/providers.mjs` | 本地模拟、fal、自定义 HTTP 适配器 |
| `server/comfyui.mjs` | MiniMax H3 控制工作流、上传、任务查询与结果回传 |
| `data/exports/<id>/` | `depth.mp4`、`metadata.json`、`frames/00000.png` 等原始帧 |

完成的导出保留在磁盘，服务重启后可以通过 `GET /api/exports` 查询。生成任务状态仅存于服务进程内。ComfyUI 的结果下载到本地，fal 和自定义 HTTP 接口的结果沿用服务商 URL。浏览器刷新后，需重新导出才能通过当前界面提交下一次生成。

## 检查

```powershell
pnpm test
pnpm build
```

测试覆盖场景校验、深度编码与运动采样，以及本地导出／模拟服务流程。三维渲染仍应在浏览器中检查：对比三个机位的白模与深度预览，导出一段视频，确认画面方向、遮挡关系和相机运动一致。真实视频模型是否遵守结构控制需要单独做对照实验。
