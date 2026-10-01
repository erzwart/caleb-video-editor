import { useState } from 'react';
import { api } from '../api';
import { loadProjects, openProject, refreshProject, toast, toastError, useEditor } from '../store';
import { Modal } from './ui';

const close = () => useEditor.setState({ modal: null });

export function ArtDirectionModal() {
  const project = useEditor((s) => s.project)!;
  const [text, setText] = useState(project.artDirection);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.setArtDirection(project.id, text);
      await refreshProject();
      toast('Art direction saved — the agent reads it before every edit');
      close();
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Art direction"
      onClose={close}
      wide
      footer={
        <>
          <span className="hint">Saved as art-direction.md in the project folder.</span>
          <div className="spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            Save
          </button>
        </>
      }
    >
      <p className="dim modal-intro">
        The look every scene shares: palette, type scale, motion principles, layout rules. the agent reads this before every edit,
        in every scene.
      </p>
      <textarea
        className="art-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
        }}
        spellCheck={false}
        autoFocus
      />
    </Modal>
  );
}

const FORMATS = [
  { label: 'Landscape 16:9 — 1920×1080', width: 1920, height: 1080 },
  { label: 'Square 1:1 — 1080×1080', width: 1080, height: 1080 },
  { label: 'Portrait 4:5 — 1080×1350', width: 1080, height: 1350 },
  { label: 'Vertical 9:16 — 1080×1920', width: 1080, height: 1920 },
];

export function NewProjectModal() {
  const [name, setName] = useState('');
  const [format, setFormat] = useState(0);
  const [fps, setFps] = useState(60);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const { width, height } = FORMATS[format];
      const project = await api.createProject({ name: name.trim() || 'Untitled', width, height, fps });
      await loadProjects();
      await openProject(project.id);
      useEditor.setState({ view: 'scenes', panel: 'project', rail: 'chat', mode: 'scene' });
      close();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New project"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create} disabled={busy}>
            Create project
          </button>
        </>
      }
    >
      <div className="form">
        <label>
          Name
          <input
            autoFocus
            value={name}
            placeholder="Product teaser"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
        </label>
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(Number(e.target.value))}>
            {FORMATS.map((f, i) => (
              <option key={f.label} value={i}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Frame rate
          <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            <option value={60}>60 fps — smoothest UI motion</option>
            <option value={30}>30 fps</option>
            <option value={24}>24 fps — filmic</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}
