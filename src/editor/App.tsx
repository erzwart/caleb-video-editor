import { Clapperboard, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Filmstrip } from './components/Filmstrip';
import { ArtDirectionModal, NewProjectModal } from './components/Modals';
import { Present } from './components/Present';
import { RenderView } from './components/RenderView';
import { uploadMusicFile, uploadSoundFiles } from './components/AudioPanels';
import { SidePanel } from './components/SidePanel';
import { Stage } from './components/Stage';
import { TopBar } from './components/TopBar';
import { connectEvents } from './events';
import { currentScene, loadProjects, openProject, selectScene, setPlaying, toastError, useEditor, userSeek } from './store';

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
}

function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone === 'error' ? 'toast-error' : ''}`}>
          <span>{t.text}</span>
          {t.action && <button onClick={t.action.run}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-card card">
        <span className="brand-mark big">
          <Clapperboard size={22} />
        </span>
        <h1>Make a video by describing it</h1>
        <p className="dim">
          Every scene is a small piece of code that draws one frame at a time. Describe what you want, and the agent writes and
          refines it while you watch the preview.
        </p>
        <button className="btn btn-primary btn-lg" onClick={() => useEditor.setState({ modal: 'new-project' })}>
          <Plus size={16} /> New project
        </button>
      </div>
    </div>
  );
}

export function App() {
  const project = useEditor((s) => s.project);
  const view = useEditor((s) => s.view);
  const modal = useEditor((s) => s.modal);
  const presenting = useEditor((s) => s.presenting);
  const [loaded, setLoaded] = useState(false);
  const [dropping, setDropping] = useState(false);
  /** Files dropped on the Sound effects panel (or its rail button) become sound effects; anywhere else, the soundtrack. */
  const [dropZone, setDropZone] = useState<'music' | 'sounds'>('music');
  const dragDepth = useRef(0);

  useEffect(() => {
    const disconnect = connectEvents();
    (async () => {
      const [info, projects] = await Promise.all([api.info(), loadProjects()]);
      useEditor.setState({ info });
      const [hashProject, hashScene] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/');
      const candidates = [hashProject, localStorage.getItem('sb:project'), projects[0]?.id];
      const id = candidates.find((x) => x && projects.some((p) => p.id === x));
      if (id) await openProject(id, hashScene || null);
    })()
      .catch(toastError)
      .finally(() => setLoaded(true));
    return disconnect;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useEditor.getState();
      if (isTyping(e.target) || s.presenting || s.modal || !s.project || s.view !== 'scenes') return;
      const frame = 1 / s.project.fps;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          setPlaying(!s.playing);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          userSeek(s.time - (e.shiftKey ? 1 : frame));
          break;
        case 'ArrowRight':
          e.preventDefault();
          userSeek(s.time + (e.shiftKey ? 1 : frame));
          break;
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          const scene = currentScene(s);
          const next = s.project.scenes[(scene?.index ?? 0) + (e.key === 'ArrowDown' ? 1 : -1)];
          if (next) selectScene(next.id);
          break;
        }
        case 'Home':
          userSeek(0);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  const zoneOf = (e: React.DragEvent) => ((e.target as HTMLElement).closest?.('[data-drop="sounds"]') ? 'sounds' : 'music');

  return (
    <div
      className="app"
      onDragEnter={(e) => {
        if (!hasFiles(e) || !project) return;
        dragDepth.current++;
        setDropping(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e) || !project) return;
        e.preventDefault();
        const zone = zoneOf(e);
        if (zone !== dropZone) setDropZone(zone);
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropping(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e) || !project) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        const files = [...e.dataTransfer.files];
        if (zoneOf(e) === 'sounds') void uploadSoundFiles(files);
        else if (files[0]) void uploadMusicFile(files[0]);
      }}
    >
      <TopBar />
      {project ? (
        <>
          <div className="main" hidden={view !== 'scenes'}>
            <Stage />
            {view === 'scenes' && <Filmstrip />}
            <SidePanel />
          </div>
          {view === 'render' && <RenderView />}
        </>
      ) : (
        loaded && <Welcome />
      )}
      {modal === 'art' && project && <ArtDirectionModal />}
      {modal === 'new-project' && <NewProjectModal />}
      {presenting && project && <Present />}
      {dropping && (
        <div className="drop-overlay">
          {dropZone === 'sounds' ? 'Drop to add sound effects' : 'Drop an audio file to use it as the soundtrack'}
        </div>
      )}
      <Toasts />
    </div>
  );
}
