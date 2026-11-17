export type Vec3 = [number, number, number];

export interface PersonState {
  id: string;
  name: string;
  color: string;
  /** World position of the feet; the scene uses Y up. */
  position: Vec3;
  /** Degrees around the Y axis. Zero faces +Z. */
  rotation: number;
  height: number;
}

export interface CameraState {
  id: string;
  name: string;
  position: Vec3;
  target: Vec3;
  fov: number;
}

export interface SceneState {
  version: 1;
  room: { width: number; depth: number; height: number };
  /** Position is the center of the table footprint, at the bottom of its legs. */
  table: { position: Vec3; size: Vec3 };
  people: PersonState[];
  cameras: CameraState[];
  /** Fixed view-space depth range, in scene units, shared by all frames. */
  depth: { near: number; far: number };
}

export function createDefaultScene(): SceneState {
  return {
    version: 1,
    room: { width: 7, depth: 5.6, height: 3.1 },
    table: { position: [0, 0, -0.1], size: [2, 0.78, 1.05] },
    people: [
      { id: 'person-a', name: '人物 A', color: '#559b92', position: [-1.15, 0, 0.85], rotation: 130, height: 1.76 },
      { id: 'person-b', name: '人物 B', color: '#d58c70', position: [1.15, 0, -0.85], rotation: -50, height: 1.72 },
    ],
    cameras: [
      { id: 'cam-front', name: '正面全景', position: [0, 2.3, 5.4], target: [0, 1, -0.2], fov: 48 },
      { id: 'cam-side', name: '侧面双人', position: [-4.5, 2.15, 1.65], target: [0, 1, -0.1], fov: 48 },
      { id: 'cam-over', name: '过肩视角', position: [-2.25, 1.8, 1.8], target: [1.15, 1.25, -0.85], fov: 52 },
    ],
    depth: { near: 0.2, far: 12 },
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}必须是对象`);
  return value as Record<string, unknown>;
}

function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name}必须是 ${min} 至 ${max} 之间的有限数值`);
  }
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 48) throw new Error(`${name}须为 1–48 个字符`);
  return value.trim();
}

function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(value)) {
    throw new Error(`${name}只能包含字母、数字、下划线和连字符`);
  }
  return value;
}

function vector(value: unknown, name: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${name}必须包含 X、Y、Z 三个坐标`);
  return value.map((item, index) => number(item, `${name}[${index}]`, -100, 100)) as Vec3;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) throw new Error(`${name}须包含 1–12 项`);
  return value;
}

/** Validates imports before they can reach camera matrices or GPU allocation. */
export function parseScene(input: unknown): SceneState {
  const scene = record(input, '场景');
  if (scene.version !== 1) throw new Error('不支持的场景版本，请使用 version: 1');
  const room = record(scene.room, '房间');
  const table = record(scene.table, '桌子');
  const tableSize = vector(table.size, '桌子尺寸');
  number(tableSize[0], '桌子宽度', 0.2, 10);
  number(tableSize[1], '桌子高度', 0.1, 3);
  number(tableSize[2], '桌子深度', 0.2, 10);
  const tablePosition = vector(table.position, '桌子位置');
  number(tablePosition[1], '桌子底部高度', 0, 10);
  const depth = record(scene.depth, '深度范围');
  const near = number(depth.near, '深度近端', 0.01, 50);
  const far = number(depth.far, '深度远端', 0.02, 250);
  if (far <= near) throw new Error('深度远端必须大于近端');

  const seenIds = new Set<string>();
  const uniqueId = (value: unknown, name: string) => {
    const result = id(value, name);
    if (seenIds.has(result)) throw new Error(`对象 ID 重复：${result}`);
    seenIds.add(result);
    return result;
  };

  const people = array(scene.people, '人物').map((value, index): PersonState => {
    const person = record(value, `人物 ${index + 1}`);
    if (typeof person.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(person.color)) {
      throw new Error('人物颜色须为六位十六进制颜色，例如 #559b92');
    }
    const position = vector(person.position, '人物位置');
    number(position[1], '人物脚底高度', 0, 10);
    return {
      id: uniqueId(person.id, '人物 ID'),
      name: text(person.name, '人物名称'),
      color: person.color,
      position,
      rotation: number(person.rotation, '人物朝向', -3600, 3600),
      height: number(person.height, '人物身高', 0.5, 3),
    };
  });

  const cameras = array(scene.cameras, '相机').map((value, index): CameraState => {
    const camera = record(value, `相机 ${index + 1}`);
    const position = vector(camera.position, '相机位置');
    const target = vector(camera.target, '相机目标');
    if (Math.hypot(...position.map((v, i) => v - target[i])) < 0.01) {
      throw new Error('相机位置与观察目标不能重合');
    }
    return {
      id: uniqueId(camera.id, '相机 ID'),
      name: text(camera.name, '相机名称'),
      position,
      target,
      fov: number(camera.fov, '相机视场角', 20, 100),
    };
  });

  return {
    version: 1,
    room: {
      width: number(room.width, '房间宽度', 2, 30),
      depth: number(room.depth, '房间深度', 2, 30),
      height: number(room.height, '房间高度', 1.8, 10),
    },
    table: { position: tablePosition, size: tableSize },
    people,
    cameras,
    depth: { near, far },
  };
}

/** CPU equivalent of the export shader, useful for validating a depth convention. */
export function depthIntensity(viewDepth: number, near: number, far: number): number {
  if (![viewDepth, near, far].every(Number.isFinite) || far <= near) throw new Error('无效的深度范围');
  return 1 - Math.min(1, Math.max(0, (viewDepth - near) / (far - near)));
}
