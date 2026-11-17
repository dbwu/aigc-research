# Video API adapters

`server.mjs` serves the local API on `127.0.0.1:8787`. In development, Vite on port 3210 proxies `/api` and `/artifacts` to it. After a frontend build the same server can serve `dist/` directly. `.env` is loaded only by the executable entrypoint, never exposed to the browser.

## Export API

1. `POST /api/exports`, JSON: `{scene,cameraId,width,height,fps,numFrames,depthNear,depthFar,motion,amount}` → `{id}`. Motion is `static`, `dolly` (scene units), or `arc` (degrees). Metadata includes sampled `frameCameraPoses`, using Y up, position/target, vertical FOV and aspect ratio for every frame.
2. `POST /api/exports/:id/frames/:index`, `Content-Type: image/png`, PNG bytes; index begins at zero. Dimensions must match the session.
3. `POST /api/exports/:id/complete` → completed record with `videoUrl`, `metadataUrl`, `framesUrl` (first lossless frame). Completion is idempotent after success.
4. `GET /api/exports` lists completed exports, newest first, including after a restart.

Files are stored in `data/exports/<id>/`. `metadata.json` retains the complete scene snapshot, camera ID, frame count, frame rate and fixed depth encoding range. The PNG sequence is lossless. `depth.mp4` uses H.264 CRF 12 and yuv420p for hosted-video compatibility, so it is **not a metric depth archive**. Use PNGs and scene data when exact sample values matter. FFmpeg is resolved from `FFMPEG_PATH`, the `ffmpeg-static` package, then `PATH`.

## Generation API

`GET /api/providers` reports available adapters and configuration state; it never returns keys.

`POST /api/generations` accepts `{provider,exportId,prompt,referenceImageUrl?,seed?}` and returns `{id,status}`. Poll `GET /api/generations/:id` until `completed` or `failed`. Successful jobs return `videoUrl`. Jobs are in memory; exported media survives restarts. Only explicit POST requests start generation. The UI must distinguish the mock output from AI-generated video.

Each adapter in `providers.mjs` has `id`, `name`, `description`, `configured()`, and `async generate({exported,input,signal})`. It returns `{videoUrl}` and may also return provider request metadata. Adapters receive the local exported video path; the frontend does not need provider-specific fields.

### mock

No credentials, network generation or cost. Returns the already exported depth video with `mock:true` to test the whole submission and preview flow.

### fal

Set `FAL_KEY` server-side. The default `FAL_ENDPOINT` is `fal-ai/wan-22-vace-fun-a14b/depth`; the hosted endpoint is scheduled to retire on **2027-01-04**. Use it only for short-term validation. A replacement must expose a compatible **depth-control** contract; a generic video editing model is not automatically interchangeable.

The adapter uploads the rendered MP4 through fal storage and submits a depth-conditioned job with `preprocess:false`, matching frame count and rate. A supplied `referenceImageUrl` becomes `ref_image_urls`. `enable_safety_checker:true` is explicit. Current default VACE experiments should use 81–241 frames. Actual external generation was not executed during local tests; valid credentials and paid service access are needed.

### http

Set `VIDEO_API_URL` and optionally `VIDEO_API_KEY`. The adapter sends one multipart POST:

- `video`: MP4 file named `depth.mp4`.
- `prompt`: generation text.
- `metadata`: JSON with `exportId`, `cameraId`, `width`, `height`, `fps`, `numFrames`, `depthNear`, `depthFar`, `depthEncoding`, `referenceImageUrl`, and `seed`.

If configured, the key is sent as `Authorization: Bearer …`. The service must finish the job and return JSON `{ "videoUrl": "https://…/result.mp4" }` within 15 minutes. Services with a job queue can be integrated by replacing this adapter with their submit/poll protocol. This minimal adapter deliberately does not guess a vendor's schema.

## Local security and resource bounds

The server binds to loopback, rejects foreign-origin writes, caps uploads and concurrent jobs, validates frame dimensions and artifact paths, and redacts configured keys from errors. Run as a local development tool, not an internet-facing server. Do not expose port 8787 publicly without adding authentication, quotas and durable job storage.
