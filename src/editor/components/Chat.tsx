import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatStep } from '../../shared/types';
import { api } from '../api';
import { chatKey, currentScene, loadChat, setEffort, setModel, toastError, useEditor } from '../store';
import { Modal, RichText } from './ui';

const SCENE_IDEAS = [
  'Hold on the headline a full second longer, then slide the card in from the right.',
  'Make the entrance snappier and land the card exactly on the next downbeat.',
  'Match the first frame to the last frame of the previous scene so the cut is invisible.',
];

const CLAUDE_MODELS: [string, string][] = [
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-fable-5-1', 'Fable 5.1'],
];

const PROJECT_IDEAS = [
  'Add a closing scene with the logo and a one-line tagline.',
  'Tighten the pacing: every scene should end on a bar line.',
  'Check every cut and fix the ones that jump.',
];

function useElapsed(since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

function StepIcon({ status }: { status: 'running' | 'done' | 'error' }) {
  if (status === 'running') return <Loader2 size={13} className="spin" />;
  if (status === 'error') return <AlertTriangle size={13} />;
  return <Check size={13} />;
}

function Steps({ steps }: { steps: ChatStep[] }) {
  return (
    <ol className="steps">
      {steps.map((step, i) =>
        step.kind === 'note' ? (
          <li key={i} className="step-note">
            {step.text}
          </li>
        ) : (
          <li key={step.id} className={`step step-${step.status}`}>
            <span className="step-icon">
              <StepIcon status={step.status} />
            </span>
            <span className="step-label">{step.label}</span>
            {step.detail && <pre className="step-detail">{step.detail}</pre>}
          </li>
        ),
      )}
    </ol>
  );
}

function FrameStrip({ images, onOpen }: { images: string[]; onOpen: (index: number) => void }) {
  return (
    <div className="frame-strip">
      {images.map((src, i) => (
        <button key={src} onClick={() => onOpen(i)} title="Frame the agent looked at">
          <img src={src} alt="" loading="lazy" />
        </button>
      ))}
    </div>
  );
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  const running = message.status === 'running';
  const [open, setOpen] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const steps = message.steps ?? [];
  const tools = steps.filter((s) => s.kind === 'tool');
  const images = steps.flatMap((s) => (s.kind === 'tool' ? (s.images ?? []) : []));
  const elapsed = useElapsed(running ? message.createdAt : null);
  const expanded = running || open;

  return (
    <div className={`msg msg-assistant ${message.undone ? 'msg-undone' : ''}`}>
      {steps.length > 0 &&
        (expanded ? (
          <>
            {!running && (
              <button className="steps-toggle" onClick={() => setOpen(false)}>
                <ChevronDown size={13} /> {tools.length} step{tools.length === 1 ? '' : 's'}
              </button>
            )}
            <Steps steps={steps} />
          </>
        ) : (
          <button className="steps-toggle" onClick={() => setOpen(true)}>
            <ChevronRight size={13} /> {tools.length} step{tools.length === 1 ? '' : 's'}
            {images.length > 0 && ` · ${images.length} frame${images.length === 1 ? '' : 's'} checked`}
          </button>
        ))}
      {images.length > 0 && (
        <FrameStrip images={images.slice(-6)} onOpen={(i) => setViewer(images.length - Math.min(6, images.length) + i)} />
      )}
      {message.text && (
        <div className="msg-text">
          <RichText text={message.text} />
        </div>
      )}
      {running && !message.text && (
        <div className="working">
          <Loader2 size={14} className="spin" /> Working… {elapsed}s
        </div>
      )}
      {message.error && <div className="msg-error">{message.error}</div>}
      {!running && (
        <div className="msg-meta">
          {message.durationMs !== undefined && `${Math.max(1, Math.round(message.durationMs / 1000))}s`}
          {message.status === 'stopped' && ' · stopped'}
          {message.undone && ' · undone'}
        </div>
      )}
      {viewer !== null && (
        <Modal title="Frame the agent looked at" onClose={() => setViewer(null)} wide>
          <img className="viewer-image" src={images[viewer]} alt="" />
          {images.length > 1 && (
            <div className="viewer-nav">
              <button className="btn btn-sm" disabled={viewer === 0} onClick={() => setViewer(viewer - 1)}>
                Previous
              </button>
              <span className="dim">
                {viewer + 1} / {images.length}
              </span>
              <button className="btn btn-sm" disabled={viewer === images.length - 1} onClick={() => setViewer(viewer + 1)}>
                Next
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="msg msg-user">
      <div className="bubble">{message.text}</div>
      {message.playhead !== undefined && <div className="msg-meta">at {message.playhead.toFixed(2)}s</div>}
    </div>
  );
}

function Composer({ scopeKey, busy, fill }: { scopeKey: string; busy: boolean; fill: string | null }) {
  const project = useEditor((s) => s.project)!;
  const effort = useEditor((s) => s.effort);
  const info = useEditor((s) => s.info);
  const savedModel = useEditor((s) => s.model);
  const isCodex = info?.providerId === 'codex';
  const MODELS: [string, string][] = isCodex ? [['', 'Codex default']] : CLAUDE_MODELS;
  const compatible = isCodex ? !savedModel.startsWith('claude-') : savedModel.startsWith('claude-');
  const model = (compatible ? savedModel : '') || info?.model || MODELS[0][0];
  const efforts = useEditor((s) => s.info?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max']);
  const draftKey = `sb:draft:${project.id}/${scopeKey}`;
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey) ?? '');
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => sessionStorage.setItem(draftKey, text), [draftKey, text]);
  useEffect(() => {
    if (fill) {
      setText(fill);
      area.current?.focus();
    }
  }, [fill]);

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    const s = useEditor.getState();
    const scene = currentScene(s);
    let playhead: number | undefined;
    if (scopeKey === '_project') playhead = s.mode === 'whole' ? s.time : (scene?.start ?? 0) + s.time;
    else if (scene) playhead = s.mode === 'scene' ? s.time : Math.max(0, Math.min(scene.duration, s.time - scene.start));
    setText('');
    try {
      await api.send(project.id, scopeKey, { text: value, playhead, effort, model });
    } catch (e) {
      setText(value);
      toastError(e);
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={area}
        value={text}
        rows={3}
        placeholder={
          scopeKey === '_project'
            ? 'Ask about the whole video, e.g. "Add a scene after Anatomy that shows every color variant."'
            : 'What should change? e.g. "Hold on the headline a full second longer, then slide the card in from the right."'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-bar">
        <span className="hint">⌘↵ to send</span>
        <div className="spacer" />
        <label className="effort" title="Model">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {(MODELS.some(([id]) => id === model) ? MODELS : [[model, model] as [string, string], ...MODELS]).map(
              ([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="effort" title="Effort: how much the agent thinks before and while editing">
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            {efforts.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        {busy ? (
          <button className="btn btn-sm" onClick={() => api.stop(project.id, scopeKey).catch(toastError)}>
            <Square size={11} fill="currentColor" /> Stop
          </button>
        ) : (
          <button className="btn btn-primary btn-send" disabled={!text.trim()} onClick={send}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

export function Chat({ scopeKey }: { scopeKey: string }) {
  const project = useEditor((s) => s.project)!;
  const key = chatKey(project.id, scopeKey);
  const chat = useEditor((s) => s.chats[key]);
  const provider = useEditor((s) => s.info?.provider);
  const list = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [fill, setFill] = useState<string | null>(null);

  useEffect(() => {
    if (!chat?.loaded) loadChat(project.id, scopeKey).catch(toastError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat?.messages]);

  // Stay pinned to the bottom while content grows (streaming text, frame thumbnails loading).
  useEffect(() => {
    const el = list.current;
    const content = inner.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const messages = chat?.messages ?? [];
  const ideas = scopeKey === '_project' ? PROJECT_IDEAS : SCENE_IDEAS;

  return (
    <div className="chat">
      <div
        className="chat-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        <div className="chat-inner" ref={inner}>
          {provider && !provider.ok && <div className="notice notice-error">{provider.detail}</div>}
          {chat?.loaded && messages.length === 0 && (
            <div className="chat-empty">
              <p>
                {scopeKey === '_project'
                  ? 'Talk about the video as a whole: structure, pacing, new scenes, consistency.'
                  : 'Describe a change to this scene. The agent edits the code, renders frames to check its work, and the preview updates live.'}
              </p>
              {ideas.map((idea) => (
                <button key={idea} className="idea" onClick={() => setFill(idea)}>
                  {idea}
                </button>
              ))}
            </div>
          )}
          {messages.map((m) =>
            m.role === 'user' ? <UserMessage key={m.id} message={m} /> : <AssistantMessage key={m.id} message={m} />,
          )}
        </div>
      </div>
      <Composer scopeKey={scopeKey} busy={chat?.busy ?? false} fill={fill} />
    </div>
  );
}
