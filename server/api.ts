import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ChatScope } from '../src/shared/types';
import { scopeKey } from '../src/shared/types';
import type { AgentProvider } from './agents/types';
import type { ChatManager, SendInput } from './chat';
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MCP_URL, PROJECTS_DIR } from './config';
import type { Hub } from './hub';
import type { MusicLibrary } from './music/library';
import type { MusicService } from './music/service';
import { snapCuts, type SnapGrid } from './musicContext';
import type { ProjectStore } from './projects';
import type { Renderer } from './render';
import type { SeamService } from './seams';
import type { SoundLibrary } from './sound/library';
import { HttpError, assertId } from './util';

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const MAX_SOUND_BYTES = 50 * 1024 * 1024;

export interface ApiDeps {
  store: ProjectStore;
  hub: Hub;
  seams: SeamService;
  renderer: Renderer;
  provider: AgentProvider;
  chats: ChatManager;
  /** Compile a scene through Vite and return the error text, or null when it compiles. */
  diagnose: (file: string) => Promise<string | null>;
  library: MusicLibrary;
  music: MusicService;
  soundLibrary: SoundLibrary;
}

export function createApi({ store, hub, seams, renderer, provider, chats, diagnose, library, music, soundLibrary }: ApiDeps) {
  const app = new Hono().basePath('/api');

  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    return c.json({ error: err.message }, status as ContentfulStatusCode);
  });

  /** Run a music step with the analyzing → ready/error status the editor shows. */
  async function withMusicStatus(projectId: string, work: () => Promise<unknown>) {
    hub.send({ type: 'music-status', projectId, status: 'analyzing' });
    try {
      await work();
      store.changed(projectId);
      hub.send({ type: 'music-status', projectId, status: 'ready' });
    } catch (e) {
      hub.send({ type: 'music-status', projectId, status: 'error', error: (e as Error).message });
    }
  }

  const chatScope = (key: string): ChatScope =>
    key === '_project' ? { kind: 'project' } : { kind: 'scene', sceneId: assertId(key, 'scene id') };

  app.get('/info', async (c) =>
    c.json({
      provider: await provider.status(),
      providerId: provider.id,
      model: DEFAULT_MODEL,
      effort: DEFAULT_EFFORT,
      efforts: EFFORTS,
      mcpUrl: MCP_URL,
      projectsDir: PROJECTS_DIR,
    }),
  );

  // Projects ------------------------------------------------------------------
  app.get('/projects', async (c) => c.json(await store.list()));

  app.post('/projects', async (c) => {
    const body = await c.req.json<{ name?: string; width?: number; height?: number; fps?: number }>();
    const id = await store.create({
      name: body.name?.trim() || 'Untitled',
      width: body.width,
      height: body.height,
      fps: body.fps,
    });
    return c.json(await store.get(id));
  });

  app.get('/projects/:id', async (c) => c.json(await store.get(c.req.param('id'))));

  app.patch('/projects/:id', async (c) => {
    await store.updateSettings(c.req.param('id'), await c.req.json());
    return c.json(await store.get(c.req.param('id')));
  });

  app.put('/projects/:id/art-direction', async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    await store.setArtDirection(c.req.param('id'), String(text ?? ''));
    return c.json({ ok: true });
  });

  // Scenes --------------------------------------------------------------------
  app.post('/projects/:id/scenes', async (c) => {
    const body = await c.req.json<{ name?: string; duration?: number; afterId?: string }>();
    return c.json(
      await store.createScene(c.req.param('id'), {
        name: body.name?.trim() || 'New scene',
        duration: body.duration,
        afterId: body.afterId,
      }),
    );
  });

  app.patch('/projects/:id/scenes/:sceneId', async (c) => {
    const id = c.req.param('id');
    const sceneId = c.req.param('sceneId');
    const body = await c.req.json<{ name?: string; duration?: number }>();
    if (body.name !== undefined) await store.renameScene(id, sceneId, body.name);
    if (body.duration !== undefined) await store.setSceneDuration(id, sceneId, Number(body.duration));
    return c.json(await store.get(id));
  });

  app.delete('/projects/:id/scenes/:sceneId', async (c) => {
    await store.deleteScene(c.req.param('id'), c.req.param('sceneId'));
    return c.json({ ok: true });
  });

  app.post('/projects/:id/scenes/:sceneId/duplicate', async (c) =>
    c.json(await store.duplicateScene(c.req.param('id'), c.req.param('sceneId'))),
  );

  app.get('/projects/:id/scenes/:sceneId/diagnostics', async (c) => {
    const id = c.req.param('id');
    const error = await diagnose(store.sceneFile(id, c.req.param('sceneId')));
    return c.json({ error: error?.split(`${store.dir(id)}/`).join('') ?? null });
  });

  app.put('/projects/:id/order', async (c) => {
    const { order } = await c.req.json<{ order: string[] }>();
    await store.reorder(c.req.param('id'), order);
    return c.json({ ok: true });
  });

  app.put('/projects/:id/durations', async (c) => {
    const { durations } = await c.req.json<{ durations: Record<string, number> }>();
    await store.setDurations(c.req.param('id'), durations);
    return c.json({ ok: true });
  });

  // Music ---------------------------------------------------------------------
  app.post('/projects/:id/music', async (c) => {
    const id = c.req.param('id');
    const name = decodeURIComponent(c.req.header('x-filename') ?? 'track.mp3');
    const data = Buffer.from(await c.req.arrayBuffer());
    if (data.length === 0) throw new HttpError(400, 'The upload was empty');
    if (data.length > MAX_AUDIO_BYTES) throw new HttpError(413, 'Audio files are limited to 200 MB');
    // Kept as a take (earlier soundtracks stay available) and made the soundtrack.
    void withMusicStatus(id, () => music.importUpload(id, name, data));
    return c.json({ ok: true });
  });

  app.post('/projects/:id/music/analyze', async (c) => {
    const id = c.req.param('id');
    const p = await store.get(id);
    const file = p.music?.file;
    if (!file) throw new HttpError(400, 'This project has no music');
    void withMusicStatus(id, () => library.analysis(id, file, true));
    return c.json({ ok: true });
  });

  app.patch('/projects/:id/music', async (c) => {
    await store.updateMusic(c.req.param('id'), await c.req.json());
    return c.json({ ok: true });
  });

  app.delete('/projects/:id/music', async (c) => {
    await store.removeMusic(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/projects/:id/snap', async (c) => {
    const id = c.req.param('id');
    const { grid } = await c.req.json<{ grid?: SnapGrid }>();
    const p = await store.get(id);
    const before = Object.fromEntries(p.scenes.map((s) => [s.id, s.duration]));
    const snapped = snapCuts(p, grid ?? 'bar');
    await store.setDurations(id, snapped.durations);
    return c.json({ before, ...snapped });
  });

  // Sound effects ---------------------------------------------------------------
  app.get('/projects/:id/sounds/:name/audio', async (c) => {
    const { file } = await soundLibrary.audioFile(c.req.param('id'), c.req.param('name'));
    const data = await fs.readFile(file);
    // The URL carries the sound's version, so it can be cached for good.
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  app.post('/projects/:id/sounds', async (c) => {
    const name = decodeURIComponent(c.req.header('x-filename') ?? 'sound.wav');
    const data = Buffer.from(await c.req.arrayBuffer());
    if (data.length === 0) throw new HttpError(400, 'The upload was empty');
    if (data.length > MAX_SOUND_BYTES) throw new HttpError(413, 'Sound files are limited to 50 MB');
    const sound = await soundLibrary.importFile(c.req.param('id'), name, data);
    return c.json({ name: sound.name });
  });

  // Seams ---------------------------------------------------------------------
  app.get('/projects/:id/seams', async (c) => {
    const id = c.req.param('id');
    const current = await seams.current(id);
    const cuts = Math.max(0, (await store.get(id)).scenes.length - 1);
    // Fill in cuts that were never checked (e.g. after a restart); results arrive over SSE.
    if (current.length < cuts) void seams.check(id).catch(() => undefined);
    return c.json(current);
  });

  app.post('/projects/:id/seams', async (c) => {
    const body = await c.req.json<{ sceneId?: string }>().catch(() => ({}) as { sceneId?: string });
    const checks = await seams.check(c.req.param('id'), { sceneId: body.sceneId, fresh: true });
    return c.json(checks.map((x) => x.result));
  });

  // Chats ---------------------------------------------------------------------
  app.get('/projects/:id/chats/:scope', async (c) => {
    const id = c.req.param('id');
    const scope = chatScope(c.req.param('scope'));
    return c.json({ ...(await chats.thread(id, scope)), busy: chats.isBusy(id, scopeKey(scope)) });
  });

  app.post('/projects/:id/chats/:scope', async (c) => {
    const body = await c.req.json<SendInput>();
    return c.json(await chats.send(c.req.param('id'), chatScope(c.req.param('scope')), body));
  });

  app.post('/projects/:id/chats/:scope/stop', (c) => {
    chats.stop(c.req.param('id'), scopeKey(chatScope(c.req.param('scope'))));
    return c.json({ ok: true });
  });

  app.post('/projects/:id/chats/:scope/undo', async (c) =>
    c.json(await chats.undo(c.req.param('id'), chatScope(c.req.param('scope')))),
  );

  app.delete('/projects/:id/chats/:scope', async (c) => {
    await chats.clear(c.req.param('id'), chatScope(c.req.param('scope')));
    return c.json({ ok: true });
  });

  // Frames the agent looked at ------------------------------------------------
  app.get('/projects/:id/frames/:file', async (c) => {
    const file = c.req.param('file');
    if (!/^[\w.-]+\.(jpg|png)$/.test(file)) throw new HttpError(400, 'Invalid frame name');
    const data = await fs.readFile(store.internalDir(c.req.param('id'), 'frames', file)).catch(() => {
      throw new HttpError(404, 'Frame not found');
    });
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': file.endsWith('.png') ? 'image/png' : 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  // Renders -------------------------------------------------------------------
  app.get('/projects/:id/renders', async (c) => {
    const id = c.req.param('id');
    return c.json({ jobs: renderer.jobsFor(id), files: await renderer.files(id) });
  });

  app.post('/projects/:id/renders', async (c) => {
    const body = await c.req.json<{ scale?: number; fps?: number }>().catch(() => ({}));
    return c.json(await renderer.start(c.req.param('id'), body));
  });

  app.delete('/projects/:id/renders/:file', async (c) => {
    await renderer.remove(c.req.param('id'), c.req.param('file'));
    return c.json({ ok: true });
  });

  app.post('/renders/:jobId/cancel', (c) => {
    renderer.cancel(c.req.param('jobId'));
    return c.json({ ok: true });
  });

  // Reveal a project file in the file manager ---------------------------------
  app.post('/reveal', async (c) => {
    const { path: target } = await c.req.json<{ path: string }>();
    const resolved = path.resolve(String(target ?? ''));
    const rel = path.relative(PROJECTS_DIR, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(400, 'Path is outside the projects folder');
    const [command, args]: [string, string[]] =
      process.platform === 'darwin'
        ? ['open', ['-R', resolved]]
        : process.platform === 'win32'
          ? ['explorer', [`/select,${resolved}`]]
          : ['xdg-open', [path.dirname(resolved)]];
    // With a callback, a missing opener is an ignored error rather than a crash.
    execFile(command, args, () => undefined);
    return c.json({ ok: true });
  });

  return app;
}
