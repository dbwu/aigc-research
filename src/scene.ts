import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createDefaultScene, type PersonState, type SceneState } from './model';

type SelectionKind = 'person' | 'camera';
type RenderMode = 'beauty' | 'depth';
interface ViewportOptions {
  interactive?: boolean;
  onSelect?: (kind: SelectionKind, id: string) => void;
}

const editorBackground = new THREE.Color('#19272f');
const depthBackground = new THREE.Color(0x000000);

function material(color: string, roughness = 0.82): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
}

function mesh(geometry: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const result = new THREE.Mesh(geometry, mat);
  result.position.set(x, y, z);
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

function disposeObjects(group: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Line) {
      geometries.add(object.geometry);
      for (const mat of Array.isArray(object.material) ? object.material : [object.material]) materials.add(mat);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((mat) => mat.dispose());
  group.clear();
}

function createPerson(person: PersonState): THREE.Group {
  const body = new THREE.Group();
  body.userData = { kind: 'person', id: person.id };
  const shirt = material(person.color);
  const skin = material('#ead3b7');
  const trousers = material('#455763');
  const shoes = material('#303c45');
  const hair = material('#574d46');

  // Lightweight articulated proxy: flat feet, separate limbs, shoulders and a head.
  for (const side of [-1, 1]) {
    body.add(mesh(new THREE.BoxGeometry(0.14, 0.09, 0.25), shoes, side * 0.115, 0.045, 0.045));
    body.add(mesh(new THREE.CapsuleGeometry(0.067, 0.27, 4, 10), trousers, side * 0.115, 0.29));
    body.add(mesh(new THREE.CapsuleGeometry(0.085, 0.28, 4, 10), trousers, side * 0.115, 0.65));
    const upperArm = mesh(new THREE.CapsuleGeometry(0.067, 0.22, 4, 10), shirt, side * 0.235, 1.2);
    upperArm.rotation.z = side * 0.12;
    body.add(upperArm);
    const lowerArm = mesh(new THREE.CapsuleGeometry(0.053, 0.22, 4, 10), skin, side * 0.27, 0.91, 0.035);
    lowerArm.rotation.x = -0.08;
    body.add(lowerArm);
    body.add(mesh(new THREE.SphereGeometry(0.062, 12, 10), skin, side * 0.27, 0.73, 0.05));
  }
  body.add(mesh(new THREE.BoxGeometry(0.31, 0.18, 0.21), trousers, 0, 0.87));
  const torso = mesh(new THREE.CylinderGeometry(0.2, 0.155, 0.49, 12), shirt, 0, 1.19);
  torso.scale.z = 0.66;
  body.add(torso);
  body.add(mesh(new THREE.CylinderGeometry(0.067, 0.07, 0.11, 12), skin, 0, 1.48));
  const head = mesh(new THREE.SphereGeometry(0.137, 20, 16), skin, 0, 1.64);
  head.scale.y = 1.1;
  body.add(head);
  body.add(mesh(new THREE.SphereGeometry(0.139, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), hair, 0, 1.67));
  body.add(mesh(new THREE.SphereGeometry(0.027, 8, 6), skin, 0, 1.635, 0.135));
  for (const side of [-1, 1]) body.add(mesh(new THREE.SphereGeometry(0.009, 6, 5), shoes, side * 0.047, 1.67, 0.124));

  body.position.fromArray(person.position);
  body.rotation.y = THREE.MathUtils.degToRad(person.rotation);
  body.scale.setScalar(person.height / 1.81);
  return body;
}

/** A true scene renderer; UI helpers never participate in depth output. */
export class SceneViewport {
  readonly canvas: HTMLCanvasElement;
  private readonly host: HTMLElement;
  private readonly options: ViewportOptions;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world = new THREE.Scene();
  private readonly content = new THREE.Group();
  private readonly helpers = new THREE.Group();
  private readonly selection = new THREE.Group();
  private readonly overview = new THREE.PerspectiveCamera(43, 1, 0.05, 200);
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  private readonly cameras = new Map<string, THREE.PerspectiveCamera>();
  private readonly cameraGuides = new Map<string, { camera: THREE.PerspectiveCamera; helper: THREE.CameraHelper; icon: THREE.Group }>();
  private readonly pickables: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly depthMaterial: THREE.ShaderMaterial;
  private state = createDefaultScene();
  private width = 1;
  private height = 1;
  private cameraId?: string;
  private mode: RenderMode = 'beauty';
  private selected?: { kind: SelectionKind; id: string };
  private pointerStart?: { x: number; y: number };
  private raf = 0;
  private disposed = false;
  private dirty = true;
  private contentSignature = '';

  constructor(host: HTMLElement, options: ViewportOptions = {}) {
    this.host = host;
    this.options = options;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.setAttribute('aria-label', options.interactive === false ? '相机画面预览' : '可旋转的三维场景，拖动查看，点击人物或相机进行编辑');
    host.appendChild(this.canvas);

    this.world.background = editorBackground;
    this.world.add(this.content, this.helpers, this.selection);
    this.world.add(new THREE.HemisphereLight('#eaf4ff', '#7a8077', 2.4));
    const key = new THREE.DirectionalLight('#fff4dc', 3.5);
    key.position.set(3.5, 7.5, 4.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 0.1, far: 25 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.025;
    this.world.add(key);
    const fill = new THREE.DirectionalLight('#d7e9ff', 1.1);
    fill.position.set(-4, 3.5, -2);
    this.world.add(fill);

    this.overview.position.set(8.8, 8.1, 10.8);
    this.controls = new OrbitControls(this.overview, this.canvas);
    this.controls.target.set(0, 0.65, 0.55);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 50;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.enabled = options.interactive !== false;
    this.controls.update();
    this.controls.addEventListener('change', this.markDirty);

    this.depthMaterial = new THREE.ShaderMaterial({
      uniforms: { depthNear: { value: 0.2 }, depthFar: { value: 12 } },
      vertexShader: `
        varying float viewDepth;
        void main() {
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          viewDepth = -viewPosition.z;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform float depthNear;
        uniform float depthFar;
        varying float viewDepth;
        void main() {
          float value = 1.0 - clamp((viewDepth - depthNear) / (depthFar - depthNear), 0.0, 1.0);
          gl_FragColor = vec4(vec3(value), 1.0);
        }
      `,
      toneMapped: false,
      side: THREE.FrontSide,
    });

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.update(this.state);
    this.resize();
    const tick = () => {
      if (this.disposed) return;
      this.controls.update();
      if (this.dirty) this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private markDirty = (): void => { this.dirty = true; };

  update(state: SceneState): void {
    this.state = structuredClone(state);
    const signature = JSON.stringify([state.room, state.table, state.people, state.cameras.map((camera) => camera.id)]);
    if (signature === this.contentSignature) {
      // Camera animation should move matrices, not rebuild all the scene geometry every frame.
      for (const cameraState of state.cameras) {
        const camera = this.cameras.get(cameraState.id)!;
        camera.position.fromArray(cameraState.position);
        camera.lookAt(new THREE.Vector3(...cameraState.target));
        camera.fov = cameraState.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        const guide = this.cameraGuides.get(cameraState.id)!;
        guide.camera.position.copy(camera.position);
        guide.camera.quaternion.copy(camera.quaternion);
        guide.camera.fov = camera.fov;
        guide.camera.updateProjectionMatrix();
        guide.camera.updateMatrixWorld(true);
        guide.helper.update();
        guide.icon.position.copy(camera.position);
        guide.icon.quaternion.copy(camera.quaternion);
      }
      this.depthMaterial.uniforms.depthNear.value = state.depth.near;
      this.depthMaterial.uniforms.depthFar.value = state.depth.far;
      this.updateSelection();
      this.dirty = true;
      return;
    }
    this.contentSignature = signature;
    disposeObjects(this.content);
    disposeObjects(this.helpers);
    this.cameras.clear();
    this.cameraGuides.clear();
    this.pickables.length = 0;
    const { width, depth, height } = state.room;
    const floorMaterial = material('#c3ccc6');
    const wallMaterial = material('#e4e6dc');
    const sideWallMaterial = material('#d3ddd8');
    const floor = mesh(new THREE.PlaneGeometry(width, depth), floorMaterial, 0, 0, 0);
    floor.rotation.x = -Math.PI / 2;
    floor.castShadow = false;
    this.content.add(floor);

    // One-sided interior walls let the overview camera see inside from outside.
    const rear = mesh(new THREE.PlaneGeometry(width, height), wallMaterial, 0, height / 2, -depth / 2);
    const left = mesh(new THREE.PlaneGeometry(depth, height), sideWallMaterial, -width / 2, height / 2, 0);
    left.rotation.y = Math.PI / 2;
    const right = mesh(new THREE.PlaneGeometry(depth, height), sideWallMaterial, width / 2, height / 2, 0);
    right.rotation.y = -Math.PI / 2;
    // Interior-only planes should not cast the outside of a wall over the stage.
    rear.castShadow = left.castShadow = right.castShadow = false;
    this.content.add(rear, left, right);
    const trim = material('#abbab3');
    this.content.add(mesh(new THREE.BoxGeometry(width, 0.08, 0.035), trim, 0, 0.04, -depth / 2 + 0.02));
    this.content.add(mesh(new THREE.BoxGeometry(0.035, 0.08, depth), trim, -width / 2 + 0.02, 0.04, 0));
    this.content.add(mesh(new THREE.BoxGeometry(0.035, 0.08, depth), trim, width / 2 - 0.02, 0.04, 0));

    // The door is a visual anchor, located on the same rear wall in every shot.
    const doorWidth = Math.min(1.05, width * 0.25);
    const doorHeight = Math.min(2.25, height * 0.85);
    const doorX = width * 0.28;
    const door = mesh(new THREE.BoxGeometry(doorWidth, doorHeight, 0.035), material('#b4a994'), doorX, doorHeight / 2, -depth / 2 + 0.025);
    this.content.add(door);
    const frame = material('#f1efe4');
    for (const side of [-1, 1]) this.content.add(mesh(new THREE.BoxGeometry(0.055, doorHeight + 0.055, 0.065), frame, doorX + side * (doorWidth / 2 + 0.02), doorHeight / 2, -depth / 2 + 0.055));
    this.content.add(mesh(new THREE.BoxGeometry(doorWidth + 0.1, 0.055, 0.065), frame, doorX, doorHeight + 0.025, -depth / 2 + 0.055));
    this.content.add(mesh(new THREE.BoxGeometry(0.13, 0.025, 0.05), material('#59666a'), doorX - doorWidth * 0.34, doorHeight * 0.46, -depth / 2 + 0.075));

    const table = new THREE.Group();
    const [tw, th, td] = state.table.size;
    const topThickness = Math.min(0.065, th * 0.2);
    table.add(mesh(new THREE.BoxGeometry(tw, topThickness, td), material('#ae8966'), 0, th - topThickness / 2));
    const legWidth = Math.min(0.075, tw * 0.1, td * 0.1);
    const legMat = material('#66716a');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      table.add(mesh(new THREE.BoxGeometry(legWidth, th - topThickness, legWidth), legMat,
        sx * (tw / 2 - legWidth), (th - topThickness) / 2, sz * (td / 2 - legWidth)));
    }
    table.position.fromArray(state.table.position);
    this.content.add(table);

    for (const person of state.people) {
      const body = createPerson(person);
      this.content.add(body);
      this.pickables.push(body);
      const direction = new THREE.ArrowHelper(
        new THREE.Vector3(Math.sin(THREE.MathUtils.degToRad(person.rotation)), 0, Math.cos(THREE.MathUtils.degToRad(person.rotation))),
        new THREE.Vector3(...person.position).add(new THREE.Vector3(0, 0.035, 0)),
        0.65, person.color, 0.14, 0.085,
      );
      this.helpers.add(direction);
    }

    const grid = new THREE.GridHelper(Math.max(width, depth) + 3, Math.round((Math.max(width, depth) + 3) * 2), '#566f78', '#344c56');
    grid.position.y = -0.008;
    this.helpers.add(grid);

    state.cameras.forEach((cameraState) => {
      const camera = new THREE.PerspectiveCamera(cameraState.fov, 16 / 9, 0.05, 200);
      camera.position.fromArray(cameraState.position);
      camera.lookAt(new THREE.Vector3(...cameraState.target));
      camera.updateMatrixWorld(true);
      this.cameras.set(cameraState.id, camera);

      // A short frustum keeps the editor readable; the actual render camera uses a far plane of 200.
      const guideCamera = camera.clone();
      guideCamera.far = 1.15;
      guideCamera.updateProjectionMatrix();
      const guide = new THREE.CameraHelper(guideCamera);
      this.helpers.add(guide);
      const icon = new THREE.Group();
      icon.userData = { kind: 'camera', id: cameraState.id };
      icon.position.copy(camera.position);
      icon.quaternion.copy(camera.quaternion);
      const cameraMat = material('#e1b673');
      icon.add(mesh(new THREE.BoxGeometry(0.24, 0.15, 0.16), cameraMat));
      const lens = mesh(new THREE.CylinderGeometry(0.065, 0.08, 0.12, 12), cameraMat, 0, 0, -0.13);
      lens.rotation.x = Math.PI / 2;
      icon.add(lens);
      this.helpers.add(icon);
      this.pickables.push(icon);
      this.cameraGuides.set(cameraState.id, { camera: guideCamera, helper: guide, icon });
    });

    this.depthMaterial.uniforms.depthNear.value = state.depth.near;
    this.depthMaterial.uniforms.depthFar.value = state.depth.far;
    if (this.cameraId && !this.cameras.has(this.cameraId)) this.cameraId = undefined;
    this.updateSelection();
    this.dirty = true;
  }

  setSelected(kind: SelectionKind, id: string): void {
    if (this.selected?.kind === kind && this.selected.id === id) return;
    this.selected = { kind, id };
    this.updateSelection();
    this.dirty = true;
  }

  private updateSelection(): void {
    disposeObjects(this.selection);
    if (!this.selected) return;
    const item = this.selected.kind === 'person'
      ? this.state.people.find((person) => person.id === this.selected?.id)
      : this.state.cameras.find((camera) => camera.id === this.selected?.id);
    if (!item) return;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(this.selected.kind === 'person' ? 0.34 : 0.22, this.selected.kind === 'person' ? 0.37 : 0.25, 48),
      new THREE.MeshBasicMaterial({ color: '#b6edc8', side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.fromArray(item.position);
    ring.position.y += 0.015;
    this.selection.add(ring);
  }

  render(cameraId?: string, mode: RenderMode = 'beauty'): void {
    if (cameraId && !this.cameras.has(cameraId)) throw new Error('未找到所选机位');
    this.cameraId = cameraId;
    this.mode = mode;
    this.controls.enabled = !cameraId && this.options.interactive !== false;
    this.dirty = true;
    this.draw();
  }

  resize(): void {
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.overview.aspect = this.width / this.height;
    this.overview.updateProjectionMatrix();
    this.dirty = true;
  }

  private setRenderMode(mode: RenderMode, showHelpers: boolean): void {
    const depth = mode === 'depth';
    this.world.overrideMaterial = depth ? this.depthMaterial : null;
    this.world.background = depth ? depthBackground : editorBackground;
    this.helpers.visible = showHelpers && !depth;
    this.selection.visible = showHelpers && !depth;
    this.renderer.toneMapping = depth ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = depth ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = !depth;
  }

  private draw(): void {
    if (this.disposed || !this.width || !this.height) return;
    this.setRenderMode(this.mode, !this.cameraId);
    this.renderer.setRenderTarget(null);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.clear();
    const camera = this.cameraId ? this.cameras.get(this.cameraId)! : this.overview;
    if (this.cameraId) {
      // The frame always stays 16:9, even inside a differently shaped editor panel.
      const w = Math.min(this.width, this.height * 16 / 9);
      const h = w * 9 / 16;
      this.renderer.setViewport((this.width - w) / 2, (this.height - h) / 2, w, h);
    }
    this.renderer.render(this.world, camera);
    this.dirty = false;
  }

  async capture(cameraId: string, width: number, height: number, mode: RenderMode = 'depth'): Promise<Blob> {
    if (this.disposed) throw new Error('场景视图已关闭');
    const source = this.cameras.get(cameraId);
    if (!source) throw new Error('未找到导出机位');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
      throw new Error('导出尺寸须为 1–4096 之间的整数');
    }
    const camera = source.clone();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const target = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    target.texture.colorSpace = mode === 'depth' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    const pixels = new Uint8Array(width * height * 4);
    const previousViewport = this.renderer.getViewport(new THREE.Vector4());
    const previousTarget = this.renderer.getRenderTarget();
    try {
      this.setRenderMode(mode, false);
      // setRenderTarget applies the target's own pixel-sized viewport, independent of device pixel ratio.
      this.renderer.setRenderTarget(target);
      this.renderer.setScissorTest(false);
      this.renderer.clear();
      this.renderer.render(this.world, camera);
      this.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setViewport(previousViewport);
      target.dispose();
      this.setRenderMode(this.mode, !this.cameraId);
      this.dirty = true;
    }
    const flipped = new Uint8ClampedArray(pixels.length);
    const stride = width * 4;
    for (let y = 0; y < height; y++) flipped.set(pixels.subarray((height - y - 1) * stride, (height - y) * stride), y * stride);
    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const context = output.getContext('2d');
    if (!context) throw new Error('浏览器无法创建导出画布');
    context.putImageData(new ImageData(flipped, width, height), 0, 0);
    return new Promise<Blob>((resolve, reject) => output.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 编码失败')), 'image/png'));
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerStart = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.cameraId || this.options.interactive === false || !this.pointerStart || Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5) return;
    const bounds = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1), this.overview);
    for (const intersection of this.raycaster.intersectObjects(this.pickables, true)) {
      let item: THREE.Object3D | null = intersection.object;
      while (item && !item.userData.kind) item = item.parent;
      if (item?.userData.kind) {
        const kind = item.userData.kind as SelectionKind;
        const id = item.userData.id as string;
        this.setSelected(kind, id);
        this.options.onSelect?.(kind, id);
        return;
      }
    }
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.controls.removeEventListener('change', this.markDirty);
    this.controls.dispose();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    disposeObjects(this.content);
    disposeObjects(this.helpers);
    disposeObjects(this.selection);
    this.depthMaterial.dispose();
    this.world.traverse((object) => { if (object instanceof THREE.DirectionalLight) object.shadow.dispose(); });
    this.renderer.dispose();
    this.canvas.remove();
  }
}
