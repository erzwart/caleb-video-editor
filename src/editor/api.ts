import type {
  ChatMessage,
  ChatThread,
  ProjectState,
  ProjectSummary,
  RenderFile,
  RenderJob,
  SceneMeta,
  SeamResult,
} from '../shared/types';

export interface Info {
  providerId: string;
  provider: { ok: boolean; label: string; version?: string; detail?: string };
  model: string;
  effort: string;
  efforts: string[];
  mcpUrl: string;
  projectsDir: string;
}

export interface SnapResult {
  before: Record<string, number>;
  durations: Record<string, number>;
  moved: number;
  maxShift: number;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return data as T;
}

const p = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export const api = {
  info: () => request<Info>('GET', '/api/info'),
  projects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  createProject: (input: { name: string; width: number; height: number; fps: number }) =>
    request<ProjectState>('POST', '/api/projects', input),
  // `sounds` is missing when an older server answers (until it's restarted).
  project: (id: string) => request<ProjectState>('GET', p(id)).then((project) => ({ ...project, sounds: project.sounds ?? [] })),
  updateProject: (id: string, patch: { name?: string; width?: number; height?: number; fps?: number }) =>
    request<ProjectState>('PATCH', p(id), patch),
  setArtDirection: (id: string, text: string) => request('PUT', `${p(id)}/art-direction`, { text }),

  createScene: (id: string, input: { name: string; duration?: number; afterId?: string }) =>
    request<SceneMeta>('POST', `${p(id)}/scenes`, input),
  updateScene: (id: string, sceneId: string, patch: { name?: string; duration?: number }) =>
    request<ProjectState>('PATCH', `${p(id)}/scenes/${sceneId}`, patch),
  deleteScene: (id: string, sceneId: string) => request('DELETE', `${p(id)}/scenes/${sceneId}`),
  duplicateScene: (id: string, sceneId: string) => request<SceneMeta>('POST', `${p(id)}/scenes/${sceneId}/duplicate`),
  reorder: (id: string, order: string[]) => request('PUT', `${p(id)}/order`, { order }),
  setDurations: (id: string, durations: Record<string, number>) => request('PUT', `${p(id)}/durations`, { durations }),

  async uploadMusic(id: string, file: File) {
    const res = await fetch(`${p(id)}/music`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Upload failed');
  },
  async uploadSound(id: string, file: File): Promise<{ name: string }> {
    const res = await fetch(`${p(id)}/sounds`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    const body = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
    if (!res.ok || !body.name) throw new Error(body.error ?? 'Upload failed');
    return { name: body.name };
  },
  analyzeMusic: (id: string) => request('POST', `${p(id)}/music/analyze`),
  updateMusic: (id: string, patch: { start?: number; volume?: number }) => request('PATCH', `${p(id)}/music`, patch),
  removeMusic: (id: string) => request('DELETE', `${p(id)}/music`),
  snap: (id: string, grid: 'beat' | 'bar' | 'phrase') => request<SnapResult>('POST', `${p(id)}/snap`, { grid }),

  seams: (id: string) => request<SeamResult[]>('GET', `${p(id)}/seams`),
  checkSeams: (id: string, sceneId?: string) => request<SeamResult[]>('POST', `${p(id)}/seams`, { sceneId }),

  chat: (id: string, key: string) => request<ChatThread & { busy: boolean }>('GET', `${p(id)}/chats/${key}`),
  send: (id: string, key: string, input: { text: string; playhead?: number; effort?: string; model?: string }) =>
    request<ChatMessage>('POST', `${p(id)}/chats/${key}`, input),
  stop: (id: string, key: string) => request('POST', `${p(id)}/chats/${key}/stop`),
  undo: (id: string, key: string) => request<ChatMessage>('POST', `${p(id)}/chats/${key}/undo`),
  clearChat: (id: string, key: string) => request('DELETE', `${p(id)}/chats/${key}`),

  renders: (id: string) => request<{ jobs: RenderJob[]; files: RenderFile[] }>('GET', `${p(id)}/renders`),
  startRender: (id: string, opts: { scale: number; fps: number }) => request<RenderJob>('POST', `${p(id)}/renders`, opts),
  cancelRender: (jobId: string) => request('POST', `/api/renders/${jobId}/cancel`),
  deleteRender: (id: string, name: string) => request('DELETE', `${p(id)}/renders/${encodeURIComponent(name)}`),

  reveal: (path: string) => request('POST', '/api/reveal', { path }),
};
