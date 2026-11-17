export type ExportRecord = {
  id: string; status: string; videoUrl: string; metadataUrl: string;
  cameraId?: string; createdAt?: string; width?: number; height?: number;
  fps?: number; numFrames?: number;
};
export type Provider = { id: string; name: string; configured: boolean; description: string; acceptsReferenceImage?: boolean };
export type GenerationJob = { id: string; status: string; provider: string; videoUrl?: string; error?: string; mock?: boolean };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({ error: `请求失败 (${response.status})` }));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `请求失败 (${response.status})`);
  return data as T;
}
export function jsonPost<T>(path: string, data: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}
