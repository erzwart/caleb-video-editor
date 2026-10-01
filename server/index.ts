import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { ClaudeCodeProvider } from './agents/claudeCode';
import { CodexProvider } from './agents/codex';
import { createApi } from './api';
import { Capturer } from './capture';
import { ChatManager } from './chat';
import { AGENT_PROVIDER, BASE_URL, HOST, MCP_URL, PORT, PROJECTS_DIR } from './config';
import { Hub } from './hub';
import { handleMcp } from './mcp';
import { MusicEngine } from './music/engine';
import { MusicLibrary } from './music/library';
import { MusicService } from './music/service';
import { ProjectStore } from './projects';
import { Renderer } from './render';
import { SeamService } from './seams';
import { SfxEngine } from './sound/engine';
import { SoundLibrary } from './sound/library';
import { SoundService } from './sound/service';
import { UndoStore } from './undo';
import { createVite, diagnoseFile, invalidateProjectModules } from './vite';

/** Reload frames and editors when project files change on disk (agent edits, your editor, git). */
function watchProjects(store: ProjectStore) {
  const timers = new Map<string, NodeJS.Timeout>();
  const watcher = fs.watch(store.root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const parts = filename.toString().split(path.sep);
    const id = parts[0];
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return;
    if (parts.length === 1) {
      store.events.emit('list-changed');
      return;
    }
    if (parts[1] === '.storyboard' || parts[1] === 'renders' || filename.toString().endsWith('.tmp')) return;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        store
          .syncCode(id)
          .then((codeChanged) => {
            if (!codeChanged) store.changed(id);
          })
          .catch(() => undefined);
      }, 60),
    );
  });
  watcher.on('error', (e) => console.warn('[storyboard] project watcher error:', e.message));
}

async function main() {
  const store = new ProjectStore(PROJECTS_DIR);
  await store.init();

  const httpServer = http.createServer();
  const vite = await createVite(httpServer);
  const hub = new Hub();
  hub.attachVite(vite);

  store.events.on('code-changed', (_id: string, dir: string) => invalidateProjectModules(vite, dir));
  store.events.on('changed', (id: string) => hub.projectChanged(id));
  store.events.on('list-changed', () => hub.send({ type: 'projects-changed' }));
  for (const p of await store.list()) await store.syncCode(p.id);
  watchProjects(store);

  const capturer = new Capturer(store);
  const seams = new SeamService(store, capturer, hub);
  const provider = AGENT_PROVIDER === 'codex' ? new CodexProvider() : new ClaudeCodeProvider();
  const undo = new UndoStore(store);
  // The music and sound-effects engines are started with `./storyboard start`; Storyboard only watches them.
  const engine = new MusicEngine();
  await engine.init();
  const sfx = new SfxEngine();
  await sfx.init();
  const library = new MusicLibrary(store);
  const music = new MusicService({ store, engine, library });
  const soundLibrary = new SoundLibrary(store);
  store.soundInfo = (id) => soundLibrary.infos(id);
  const sounds = new SoundService({ store, library: soundLibrary, capturer, engine: sfx });
  const renderer = new Renderer(store, capturer, hub, sounds);
  const chats = new ChatManager({ store, hub, provider, seams, undo, engine, sfx });
  const api = createApi({
    store,
    hub,
    seams,
    renderer,
    provider,
    chats,
    library,
    music,
    soundLibrary,
    diagnose: (file) => diagnoseFile(vite, file),
  });
  const apiListener = getRequestListener(api.fetch);
  const localHostnames = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const isLocalHost = (host: string | undefined) => Boolean(host && localHostnames.has(host.replace(/:\d+$/, '')));
  /** A browser request made by another website or another local port (only the editor itself may call the API). */
  const isCrossSite = (req: http.IncomingMessage) => {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return true;
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).host !== req.headers.host;
    } catch {
      return true;
    }
  };

  httpServer.on('request', (req, res) => {
    const url = req.url ?? '/';
    const isMcp = url === '/mcp' || url.startsWith('/mcp?');
    if (url.startsWith('/api/') || isMcp) {
      // Guard the local API against DNS rebinding (Host) and against web pages sending it requests (CSRF),
      // which could otherwise start agent turns. Non-browser clients (the MCP client, curl) send neither header.
      if (!isLocalHost(req.headers.host)) {
        res.writeHead(403).end('Forbidden host');
        return;
      }
      if (isCrossSite(req)) {
        res.writeHead(403).end('Forbidden: cross-site request');
        return;
      }
      if (url === '/api/events') return hub.handleSse(req, res);
      if (isMcp) {
        handleMcp(req, res, { store, capturer, seams, engine, library, music, sfx, soundLibrary, sounds }).catch((e: Error) => {
          console.error('[storyboard] MCP error:', e);
          if (!res.headersSent) res.writeHead(500).end(e.message);
        });
        return;
      }
      void apiListener(req, res);
      return;
    }
    vite.middlewares(req, res);
  });

  httpServer.listen(PORT, HOST, async () => {
    const status = await provider.status();
    console.log(`\n  Storyboard  ${BASE_URL}\n`);
    console.log(`  Projects    ${PROJECTS_DIR}`);
    console.log(`  Agent       ${status.ok ? `${status.label} ${status.version ?? ''}` : `unavailable — ${status.detail}`}`);
    console.log(`  MCP         ${MCP_URL}`);
    console.log(
      `              ${AGENT_PROVIDER === 'codex' ? 'codex mcp add storyboard --url' : 'claude mcp add --transport http storyboard'} ${MCP_URL}\n`,
    );
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    engine.stop();
    sfx.stop();
    await capturer.close().catch(() => undefined);
    await vite.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
