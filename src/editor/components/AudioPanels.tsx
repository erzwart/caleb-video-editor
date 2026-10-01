import { Loader2, Magnet, Music, Play, Plus, RefreshCw, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { previewAudio } from '../audio';
import { refreshProject, toast, toastError, totalDuration, useEditor } from '../store';
import { Segmented, formatClock } from './ui';

const isAudioFile = (file: File) =>
  file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?|caf)$/i.test(file.name);

export async function uploadMusicFile(file: File) {
  const project = useEditor.getState().project;
  if (!project) return;
  if (!isAudioFile(file)) {
    toast(`“${file.name}” doesn’t look like an audio file`, { tone: 'error' });
    return;
  }
  useEditor.setState({ musicStatus: 'analyzing', rail: 'soundtrack' });
  try {
    await api.uploadMusic(project.id, file);
    await refreshProject();
  } catch (e) {
    useEditor.setState({ musicStatus: 'error', musicError: (e as Error).message });
    toastError(e);
  }
}

/** Audio files dropped on (or picked in) the Sound effects panel join the project's sound-effect library. */
export async function uploadSoundFiles(files: File[]) {
  const project = useEditor.getState().project;
  if (!project) return;
  const audio = files.filter(isAudioFile);
  if (audio.length < files.length) toast('Only audio files can be added as sounds', { tone: 'error' });
  const added: string[] = [];
  for (const file of audio) {
    try {
      added.push((await api.uploadSound(project.id, file)).name);
    } catch (e) {
      toastError(e);
    }
  }
  if (!added.length) return;
  await refreshProject().catch(() => undefined);
  toast(
    `Added ${added.map((n) => `“${n}”`).join(', ')} to the sounds. Ask the agent to use ${added.length === 1 ? 'it' : 'them'}.`,
  );
}

/** Cue errors from the scenes, plus cues naming a sound the library doesn't have. */
export function useSoundProblems(): string[] {
  const sounds = useEditor((s) => s.project?.sounds);
  const report = useEditor((s) => s.soundCues);
  return useMemo(() => {
    const names = new Set(sounds?.map((s) => s.name));
    const missing = [...new Set(report.cues.map((cue) => cue.sound))].filter((name) => !names.has(name));
    return [...report.errors, ...missing.map((name) => `No sound called “${name}” (used by a cue)`)];
  }, [sounds, report]);
}

function MusicOverview() {
  const project = useEditor((s) => s.project)!;
  const a = project.musicAnalysis!;
  const start = project.music?.start ?? 0;
  const total = totalDuration(project);
  const n = 200;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i <= n; i++) {
    const v = a.waveform[Math.min(a.waveform.length - 1, Math.floor((i / n) * a.waveform.length))] ?? 0;
    top.push(`${i},${20 - 2 - v * 16}`);
    bottom.push(`${i},${20 + 2 + v * 16}`);
  }
  const x = (t: number) => (t / a.duration) * n;
  const setStart = async (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * a.duration;
    const nearest = a.downbeats.reduce((best, d) => (Math.abs(d - t) < Math.abs(best - t) ? d : best), a.downbeats[0] ?? t);
    try {
      await api.updateMusic(project.id, { start: Math.max(0, nearest) });
      await refreshProject();
      toast(`The video now starts ${nearest.toFixed(2)}s into the track`);
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <svg className="music-overview" viewBox={`0 0 ${n} 40`} preserveAspectRatio="none" onClick={setStart}>
      <title>Click to start the video at the nearest bar</title>
      <rect
        className="window"
        x={x(start)}
        y={0}
        width={Math.max(0.5, x(Math.min(a.duration, start + total)) - x(start))}
        height={40}
      />
      <path d={`M${top.join(' L')} L${bottom.reverse().join(' L')} Z`} />
      {a.sections.slice(1).map((s) => (
        <line key={s.start} className="section" x1={x(s.start)} x2={x(s.start)} y1={0} y2={40} />
      ))}
    </svg>
  );
}

export function SoundtrackPanel() {
  const project = useEditor((s) => s.project)!;
  const status = useEditor((s) => s.musicStatus);
  const error = useEditor((s) => s.musicError);
  const input = useRef<HTMLInputElement>(null);
  const [grid, setGrid] = useState<'bar' | 'phrase' | 'beat'>('bar');
  const music = project.music;
  const a = project.musicAnalysis;

  const snap = async () => {
    try {
      const result = await api.snap(project.id, grid);
      await refreshProject();
      toast(
        `Snapped ${result.moved} cut${result.moved === 1 ? '' : 's'} to the ${grid} grid (max shift ${result.maxShift.toFixed(2)}s)`,
        {
          action: {
            label: 'Undo',
            run: () => void api.setDurations(project.id, result.before).then(refreshProject).catch(toastError),
          },
        },
      );
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <div className="side-head">
        <div className="side-title">
          <h1>Soundtrack</h1>
        </div>
      </div>
      <div className="audio-body">
        {!music ? (
          <button className="music-empty" onClick={() => input.current?.click()}>
            <Music size={18} />
            <span>
              <strong>Add a soundtrack</strong>
              <span className="dim">
                Drop an audio file anywhere or click here. Beats, bars and phrases are detected so cuts and animations can lock to
                the music.
              </span>
            </span>
          </button>
        ) : (
          <>
            <div className="track">
              <span className="track-icon">
                <Music size={16} />
              </span>
              <span className="track-text">
                <strong title={music.file}>{music.file}</strong>
                {a && status === 'ready' && (
                  <span className="dim">
                    {a.bpm.toFixed(1)} BPM · {a.beatsPerBar}/4 · {formatClock(a.duration)} ·{' '}
                    {a.sections.map((s) => s.label).join(' → ')}
                  </span>
                )}
              </span>
              <button className="icon-btn" title="Re-analyze" onClick={() => api.analyzeMusic(project.id).catch(toastError)}>
                <RefreshCw size={15} />
              </button>
              <button
                className="icon-btn"
                title="Remove the soundtrack"
                onClick={async () => {
                  if (!confirm('Remove the soundtrack from this project?')) return;
                  await api.removeMusic(project.id).catch(toastError);
                  await refreshProject();
                }}
              >
                <X size={16} />
              </button>
            </div>
            {status === 'error' ? (
              <div className="music-status error">{error ?? 'Analysis failed'}</div>
            ) : !a || status === 'analyzing' ? (
              <div className="music-status">
                <Loader2 size={14} className="spin" /> Detecting beats, bars and phrases…
              </div>
            ) : (
              <>
                <div className="audio-group">
                  <MusicOverview />
                  <p className="audio-hint">
                    The highlighted part plays under the video. Click the waveform to start at the nearest bar.
                  </p>
                </div>
                <div className="audio-fields">
                  <label htmlFor="music-start">Starts at</label>
                  <span>
                    <input
                      id="music-start"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={music.start.toFixed(2)}
                      key={music.start}
                      onBlur={async (e) => {
                        const start = Number(e.currentTarget.value);
                        if (!Number.isFinite(start) || start === project.music?.start) return;
                        await api.updateMusic(project.id, { start }).catch(toastError);
                        await refreshProject();
                      }}
                    />{' '}
                    s
                  </span>
                  <label htmlFor="music-volume">Volume</label>
                  <input
                    id="music-volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    defaultValue={music.volume}
                    onChange={(e) => {
                      const volume = Number(e.currentTarget.value);
                      void api.updateMusic(project.id, { volume }).then(refreshProject).catch(toastError);
                    }}
                  />
                </div>
                <div className="audio-group">
                  <div className="music-actions">
                    <Segmented
                      size="sm"
                      value={grid}
                      options={[
                        ['beat', 'Beats'],
                        ['bar', 'Bars'],
                        ['phrase', 'Phrases'],
                      ]}
                      onChange={setGrid}
                    />
                    <button className="btn btn-sm" onClick={snap} title="Move every cut to the nearest grid point">
                      <Magnet size={14} /> Snap cuts
                    </button>
                  </div>
                  <p className="audio-hint">Moves every cut between scenes to the nearest beat, bar or phrase.</p>
                </div>
              </>
            )}
            <p className="audio-hint audio-drop-hint">Drop an audio file anywhere to replace the soundtrack.</p>
          </>
        )}
        <input
          ref={input}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadMusicFile(file);
            e.target.value = '';
          }}
        />
      </div>
    </>
  );
}

export function SoundsPanel() {
  const project = useEditor((s) => s.project)!;
  const report = useEditor((s) => s.soundCues);
  const problems = useSoundProblems();
  const input = useRef<HTMLInputElement>(null);
  const uses = useMemo(() => {
    const map = new Map<string, number>();
    for (const cue of report.cues) map.set(cue.sound, (map.get(cue.sound) ?? 0) + 1);
    return map;
  }, [report]);
  const count = project.sounds.length;

  return (
    <>
      <div className="side-head">
        <div className="side-title">
          <h1>Sound effects</h1>
          {count > 0 && (
            <span className="side-count">
              {count} sound{count === 1 ? '' : 's'} · {report.cues.length} cue{report.cues.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <button className="btn btn-sm" onClick={() => input.current?.click()} title="Add audio files as sound effects">
          <Plus size={15} /> Add
        </button>
        <input
          ref={input}
          type="file"
          accept="audio/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void uploadSoundFiles(files);
          }}
        />
      </div>
      <div className="audio-body">
        {problems.map((problem) => (
          <div key={problem} className="notice notice-warn">
            {problem}
          </div>
        ))}
        {count === 0 ? (
          <p className="audio-empty">No sounds yet. Ask the agent for sound design, or drop audio files here.</p>
        ) : (
          <ul className="sound-list">
            {project.sounds.map((sound) => {
              const used = uses.get(sound.name) ?? 0;
              return (
                <li key={sound.name}>
                  <button
                    className="icon-btn icon-sm"
                    aria-label={`Play ${sound.name}`}
                    onClick={() => void previewAudio.play(sound.url).catch(toastError)}
                  >
                    <Play size={12} fill="currentColor" />
                  </button>
                  <span className="sound-name">{sound.name}</span>
                  <span className="sound-meta">
                    {sound.source} · {sound.duration.toFixed(2)}s · {used ? `${used}×` : 'unused'}
                  </span>
                  <span className="sound-label" title={sound.label}>
                    {sound.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {count > 0 && <p className="audio-hint audio-drop-hint">Drop audio files here to add them.</p>}
      </div>
    </>
  );
}
