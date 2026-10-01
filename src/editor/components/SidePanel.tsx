import {
  AudioLines,
  CopyPlus,
  ExternalLink,
  FolderOpen,
  Loader2,
  MessageSquare,
  Music,
  ScanLine,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SceneState } from '../../shared/types';
import { api } from '../api';
import {
  chatKey,
  currentScene,
  refreshProject,
  selectScene,
  toast,
  toastError,
  totalDuration,
  useEditor,
  type RailItem,
} from '../store';
import { SoundsPanel, SoundtrackPanel, useSoundProblems } from './AudioPanels';
import { Chat } from './Chat';
import { FILE_MANAGER, revealFile } from './TopBar';
import { Segmented } from './ui';

function InlineInput(props: { initial: string; onDone: (value: string | null) => void; numeric?: boolean; className?: string }) {
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    props.onDone(value);
  };
  return (
    <input
      className={`inline-input ${props.className ?? ''}`}
      defaultValue={props.initial}
      autoFocus
      inputMode={props.numeric ? 'decimal' : undefined}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value.trim());
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value.trim())}
    />
  );
}

function SceneTitle({ scene }: { scene: SceneState }) {
  const project = useEditor((s) => s.project)!;
  const [editing, setEditing] = useState<'name' | 'duration' | null>(null);
  const save = async (patch: { name?: string; duration?: number }) => {
    try {
      await api.updateScene(project.id, scene.id, patch);
      await refreshProject();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="side-title">
      {editing === 'name' ? (
        <InlineInput
          initial={scene.name}
          className="title-input"
          onDone={(v) => {
            setEditing(null);
            if (v && v !== scene.name) void save({ name: v });
          }}
        />
      ) : (
        <h1 onDoubleClick={() => setEditing('name')} title="Double-click to rename">
          {scene.name}
        </h1>
      )}
      {editing === 'duration' ? (
        <InlineInput
          numeric
          initial={scene.duration.toFixed(2)}
          className="duration-input"
          onDone={(v) => {
            setEditing(null);
            const seconds = Number(v?.replace(/s$/, ''));
            if (v && Number.isFinite(seconds) && seconds > 0 && seconds !== scene.duration) void save({ duration: seconds });
          }}
        />
      ) : (
        <button className="duration-btn" onClick={() => setEditing('duration')} title="Click to change the duration">
          {scene.duration.toFixed(2)}s
        </button>
      )}
    </div>
  );
}

function useUndo(scopeKey: string) {
  const project = useEditor((s) => s.project)!;
  const chat = useEditor((s) => s.chats[chatKey(project.id, scopeKey)]);
  const canUndo = Boolean(chat && !chat.busy && chat.messages.some((m) => m.undoId && !m.undone));
  const undo = async () => {
    try {
      await api.undo(project.id, scopeKey);
      toast('Reverted the agent’s last change');
    } catch (e) {
      toastError(e);
    }
  };
  const clear = async () => {
    if (!confirm('Clear this chat? The agent starts a fresh conversation (your scene files are not affected).')) return;
    await api.clearChat(project.id, scopeKey).catch(toastError);
  };
  return { canUndo, undo, clear, hasMessages: Boolean(chat?.messages.length) };
}

function SceneToolbar({ scene }: { scene: SceneState }) {
  const project = useEditor((s) => s.project)!;
  const { canUndo, undo, clear, hasMessages } = useUndo(scene.id);
  const duplicate = async () => {
    try {
      const created = await api.duplicateScene(project.id, scene.id);
      await refreshProject();
      selectScene(created.id);
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete “${scene.name}”? The file is moved to the project’s trash.`)) return;
    try {
      await api.deleteScene(project.id, scene.id);
      await refreshProject();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="side-toolbar">
      <button className="btn btn-sm" disabled={!canUndo} onClick={undo} title="Undo the agent’s last change to this scene">
        <Undo2 size={15} /> Undo
      </button>
      <button
        className="icon-btn"
        title="Open this scene in a new tab"
        onClick={() => window.open(`/frame.html?project=${project.id}&scene=${scene.id}&mode=editor`, '_blank')}
      >
        <ExternalLink size={16} />
      </button>
      <button className="icon-btn" title={`Show the scene file in ${FILE_MANAGER}`} onClick={() => revealFile(scene.file)}>
        <FolderOpen size={16} />
      </button>
      <button className="icon-btn" title="Duplicate scene" onClick={duplicate}>
        <CopyPlus size={16} />
      </button>
      <button className="icon-btn icon-danger" title="Delete scene" onClick={remove} disabled={project.scenes.length <= 1}>
        <Trash2 size={16} />
      </button>
      <div className="spacer" />
      <button className="btn-text" onClick={clear} disabled={!hasMessages}>
        Clear chat
      </button>
    </div>
  );
}

function ProjectToolbar() {
  const project = useEditor((s) => s.project)!;
  const { canUndo, undo, clear, hasMessages } = useUndo('_project');
  const [checking, setChecking] = useState(false);
  const checkSeams = async () => {
    setChecking(true);
    try {
      const results = await api.checkSeams(project.id);
      const visible = results.filter((r) => r.diffPercent >= 0.5).length;
      toast(
        results.length
          ? `Checked ${results.length} cuts — ${visible ? `${visible} visible` : 'all invisible'}`
          : 'Only one scene — no cuts',
      );
    } catch (e) {
      toastError(e);
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="side-toolbar">
      <button className="btn btn-sm" disabled={!canUndo} onClick={undo} title="Undo the project chat’s last change">
        <Undo2 size={15} /> Undo
      </button>
      <button className="btn btn-sm" onClick={checkSeams} disabled={checking} title="Pixel-compare every cut">
        {checking ? <Loader2 size={15} className="spin" /> : <ScanLine size={15} />} Check seams
      </button>
      <button
        className="icon-btn"
        title={`Show the project folder in ${FILE_MANAGER}`}
        onClick={() => revealFile(`${project.dir}/project.json`)}
      >
        <FolderOpen size={16} />
      </button>
      <div className="spacer" />
      <button className="btn-text" onClick={clear} disabled={!hasMessages}>
        Clear chat
      </button>
    </div>
  );
}

/** The right column's icon rail: Chat, Soundtrack, Sound effects. Badges show what's happening in the hidden panels. */
function Rail() {
  const project = useEditor((s) => s.project)!;
  const rail = useEditor((s) => s.rail);
  const busy = useEditor((s) => Object.entries(s.chats).some(([key, chat]) => chat.busy && key.startsWith(`${project.id}/`)));
  const musicStatus = useEditor((s) => s.musicStatus);
  const problems = useSoundProblems().length;
  // A turn that finishes while another panel is open leaves a dot on Chat until it's opened.
  const [unread, setUnread] = useState(false);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && useEditor.getState().rail !== 'chat') setUnread(true);
    wasBusy.current = busy;
  }, [busy]);
  useEffect(() => {
    if (rail === 'chat') setUnread(false);
  }, [rail]);
  useEffect(() => setUnread(false), [project.id]);

  const item = (id: RailItem, name: string, status: string | null, icon: ReactNode, badge: ReactNode = null) => {
    const label = status ? `${name} · ${status}` : name;
    return (
      <button
        role="tab"
        aria-selected={rail === id}
        aria-label={label}
        title={label}
        className={`rail-btn ${rail === id ? 'active' : ''}`}
        data-drop={id === 'sounds' ? 'sounds' : undefined}
        onClick={() => useEditor.setState({ rail: id })}
      >
        {icon}
        {badge}
      </button>
    );
  };
  const working = (
    <span className="rail-badge rail-working">
      <Loader2 size={11} className="spin" />
    </span>
  );

  return (
    <nav className="rail" role="tablist" aria-orientation="vertical" aria-label="Panels">
      {item(
        'chat',
        'Chat',
        busy ? 'the agent is working' : unread ? 'the agent replied' : null,
        <MessageSquare size={18} />,
        busy ? working : unread ? <span className="rail-badge rail-dot" /> : null,
      )}
      {item(
        'soundtrack',
        'Soundtrack',
        musicStatus === 'analyzing' ? 'analyzing' : musicStatus === 'error' ? 'analysis failed' : null,
        <Music size={18} />,
        musicStatus === 'analyzing' ? (
          working
        ) : musicStatus === 'error' ? (
          <span className="rail-badge rail-dot rail-error" />
        ) : null,
      )}
      {item(
        'sounds',
        'Sound effects',
        problems ? `${problems} problem${problems === 1 ? '' : 's'}` : null,
        <AudioLines size={18} />,
        problems ? <span className="rail-badge rail-count">{problems}</span> : null,
      )}
    </nav>
  );
}

function ChatPanel() {
  const panel = useEditor((s) => s.panel);
  const project = useEditor((s) => s.project)!;
  const scene = useEditor((s) => currentScene(s));
  const scopeKey = panel === 'scene' ? scene?.id : '_project';
  return (
    <>
      <div className="side-head">
        <Segmented
          size="sm"
          value={panel}
          options={[
            ['scene', 'Scene'],
            ['project', 'Project'],
          ]}
          onChange={(p) => useEditor.setState({ panel: p })}
        />
        {panel === 'scene' && scene ? (
          <SceneTitle scene={scene} />
        ) : (
          <div className="side-title">
            <h1>{project.name}</h1>
            <span className="duration-btn static">{totalDuration(project).toFixed(2)}s</span>
          </div>
        )}
      </div>
      {panel === 'scene' && scene ? <SceneToolbar scene={scene} /> : <ProjectToolbar />}
      {scopeKey && <Chat key={`${project.id}/${scopeKey}`} scopeKey={scopeKey} />}
    </>
  );
}

export function SidePanel() {
  const rail = useEditor((s) => s.rail);
  return (
    <>
      <aside className="side" data-drop={rail === 'sounds' ? 'sounds' : undefined}>
        {rail === 'soundtrack' ? <SoundtrackPanel /> : rail === 'sounds' ? <SoundsPanel /> : <ChatPanel />}
      </aside>
      <Rail />
    </>
  );
}
