import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ProjectState } from '../src/shared/types';
import type { Capturer } from './capture';
import { MAX_FRAMES_PER_CALL } from './config';
import { musicSummary, sceneMusicContext, snapCuts } from './musicContext';
import type { ProjectStore } from './projects';
import { listProjectFiles, projectFile } from './projectFiles';
import { describeSeam, type SeamService } from './seams';
import type { MusicEngine } from './music/engine';
import type { MusicLibrary } from './music/library';
import type { MusicJob, MusicService } from './music/service';
import type { SfxEngine } from './sound/engine';
import type { LibrarySound, SoundLibrary } from './sound/library';
import type { SoundService } from './sound/service';
import { PRESETS, PRESET_NAMES } from './sound/synth';
import { formatSeconds, round } from './util';

export interface ToolServices {
  store: ProjectStore;
  capturer: Capturer;
  seams: SeamService;
  engine: MusicEngine;
  library: MusicLibrary;
  music: MusicService;
  sfx: SfxEngine;
  soundLibrary: SoundLibrary;
  sounds: SoundService;
}

/** How long a music tool call waits for the engine before handing back a job id. */
const MUSIC_WAIT_MS = 100_000;

/** Who is calling: the in-app scene/project chats send headers; a terminal Claude Code session sends none. */
interface Scope {
  kind: 'scene' | 'project' | 'open';
  projectId?: string;
  sceneId?: string;
}

export const FRAME_MARKER = 'storyboard-frames:';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

interface ToolResult {
  [key: string]: unknown;
  content: Content[];
  isError?: boolean;
}

class ToolError extends Error {}

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] });

function header(h: IncomingHttpHeaders, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

function scopeFrom(h: IncomingHttpHeaders): Scope {
  const kind = header(h, 'x-storyboard-scope');
  if (kind === 'scene' || kind === 'project') {
    return { kind, projectId: header(h, 'x-storyboard-project'), sceneId: header(h, 'x-storyboard-scene') };
  }
  return { kind: 'open' };
}

const projectArg = z
  .string()
  .optional()
  .describe(
    'Project id (its folder name under projects/). Optional inside the Storyboard app, where it defaults to the open project.',
  );
const sceneArg = z
  .string()
  .optional()
  .describe('Scene id — the file name of scenes/<id>.tsx. Optional in a scene chat, where it defaults to that scene.');

export function createToolServer(services: ToolServices, scope: Scope): McpServer {
  const { store, capturer, seams, engine, library, music, sfx, soundLibrary, sounds } = services;
  const server = new McpServer({ name: 'storyboard', version: '1.0.0' });

  async function project(id?: string): Promise<ProjectState> {
    const projectId = id ?? scope.projectId;
    if (scope.kind !== 'open' && projectId !== scope.projectId) throw new ToolError('This chat may only access its own project.');
    if (projectId) return store.get(projectId);
    const all = await store.list();
    if (all.length === 1) return store.get(all[0].id);
    throw new ToolError(`Pass "project". Available projects: ${all.map((p) => p.id).join(', ') || '(none)'}`);
  }

  function scene(p: ProjectState, id?: string) {
    const sceneId = id ?? (scope.projectId === p.id ? scope.sceneId : undefined);
    if (!sceneId) throw new ToolError(`Pass "scene". Scenes: ${p.scenes.map((s) => s.id).join(', ')}`);
    const found = p.scenes.find((s) => s.id === sceneId);
    if (!found) throw new ToolError(`No scene "${sceneId}" in ${p.id}. Scenes: ${p.scenes.map((s) => s.id).join(', ')}`);
    return found;
  }

  function assertCanEditScene(p: ProjectState, sceneId: string) {
    if (scope.kind === 'scene' && (p.id !== scope.projectId || sceneId !== scope.sceneId)) {
      throw new ToolError(`This chat may only change scene "${scope.sceneId}". Use the Project chat for other scenes.`);
    }
  }

  function assertStructural(what = 'Adding, removing or reordering scenes') {
    if (scope.kind === 'scene') {
      throw new ToolError(`${what} happens in the Project chat, not in a scene chat.`);
    }
  }

  function tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    run: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
    readOnly = false,
  ) {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } }, (async (
      args: z.infer<z.ZodObject<Shape>>,
    ) => {
      try {
        return await run(args);
      } catch (e) {
        return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
      }
    }) as never);
  }

  tool(
    'list_project_files',
    'List scene source, shared components and art direction files in the project.',
    { project: projectArg },
    async (args) => {
      const p = await project(args.project);
      return text((await listProjectFiles(p, scope)).join('\n'));
    },
    true,
  );

  tool(
    'read_project_file',
    'Read a project source file. Paths are relative to the project folder.',
    { project: projectArg, file: z.string() },
    async (args) => {
      const p = await project(args.project);
      return text(await fs.readFile(await projectFile(p, scope, args.file), 'utf8'));
    },
    true,
  );

  tool(
    'write_project_file',
    'Replace a project source file with complete UTF-8 content. Scene chats may only write their own scene; project chats may also write components and art-direction.md. Never write project.json.',
    { project: projectArg, file: z.string(), content: z.string() },
    async (args) => {
      const p = await project(args.project);
      const file = await projectFile(p, scope, args.file, true);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, args.content);
      await store.syncCode(p.id);
      store.changed(p.id);
      return text(`Wrote ${args.file}`);
    },
  );

  function describeProject(p: ProjectState): string {
    const total = p.scenes.reduce((s, x) => s + x.duration, 0);
    const lines = [
      `Project "${p.name}" (id ${p.id}) — ${p.width}×${p.height} @ ${p.fps} fps, ${p.scenes.length} scenes, ${formatSeconds(total)} total.`,
      `Folder: ${p.dir}`,
      musicSummary(p),
      p.sounds.length
        ? `Sound library (sounds/): ${p.sounds.length} sound${p.sounds.length === 1 ? '' : 's'} — ${p.sounds
            .slice(0, 20)
            .map((x) => x.name)
            .join(
              ', ',
            )}${p.sounds.length > 20 ? ', …' : ''}. Scenes place them with a \`sounds\` export; check_audio shows the mix.`
        : 'Sound library (sounds/): empty.',
      'Scenes (in order):',
      ...p.scenes.map(
        (s) =>
          `  ${s.index + 1}. ${s.id} — "${s.name}", ${formatSeconds(s.duration)}, starts at ${formatSeconds(s.start)} → ${path.relative(p.dir, s.file)}`,
      ),
    ];
    return lines.join('\n');
  }

  async function saveFrame(p: ProjectState, image: Buffer, ext: string): Promise<string> {
    const dir = store.internalDir(p.id, 'frames');
    await fs.mkdir(dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    await fs.writeFile(path.join(dir, name), image);
    return `/api/projects/${p.id}/frames/${name}`;
  }

  // ---------------------------------------------------------------------------

  tool(
    'get_project',
    'Overview of a Storyboard project: canvas, fps, every scene in order with id, name, duration, start time and file path, and the soundtrack. Call this first when you need the structure.',
    { project: projectArg },
    async (args) => text(describeProject(await project(args.project))),
    true,
  );

  tool(
    'render_frames',
    `Render frames of a scene exactly as the final video will show them and look at them. Use it after every change to check your work: the moments you touched, plus the first and last frames. Times are scene-local seconds (0 … duration). Up to ${MAX_FRAMES_PER_CALL} frames per call. Set whole_video to pass video times instead (the frame shows whichever scene plays then).`,
    {
      project: projectArg,
      scene: sceneArg,
      times: z.array(z.number()).min(1).max(MAX_FRAMES_PER_CALL).describe('Times in seconds, e.g. [0, 0.8, 1.6, 3.32]'),
      whole_video: z.boolean().optional().describe('Interpret times as video time instead of scene time'),
      resolution: z
        .enum(['low', 'normal', 'high'])
        .optional()
        .describe('low = 480×270 (cheap overview), normal = 960×540 (default), high = full size (fine type or 1px lines)'),
    },
    async (args) => {
      const p = await project(args.project);
      const s = args.whole_video ? null : scene(p, args.scene);
      const scale = args.resolution === 'low' ? 0.25 : args.resolution === 'high' ? 1 : 0.5;
      const limit = s ? s.duration : p.scenes.reduce((sum, x) => sum + x.duration, 0);
      const times = args.times.map((t) => round(Math.min(Math.max(0, t), limit), 4));
      const frames = await capturer.frames(p.id, s?.id ?? null, times, { scale });
      const urls = await Promise.all(frames.map((f) => saveFrame(p, f.image, 'jpg')));
      const errors = [...new Set(frames.flatMap((f) => f.errors))];
      const what = s
        ? `scenes/${s.id}.tsx ("${s.name}", ${formatSeconds(s.duration)})`
        : `the whole video (${formatSeconds(limit)})`;
      const content: Content[] = [
        {
          type: 'text',
          text: [
            `Rendered ${frames.length} frame${frames.length === 1 ? '' : 's'} of ${what} at ${Math.round(p.width * scale)}×${Math.round(p.height * scale)}.`,
            errors.length ? `\nERRORS while rendering:\n${errors.join('\n\n')}` : '',
            `\n[${FRAME_MARKER} ${urls.join(' ')}]`,
          ].join(''),
        },
      ];
      frames.forEach((f) => {
        const label = s
          ? `t = ${f.t.toFixed(3)}s`
          : `video t = ${f.t.toFixed(3)}s → scene ${f.sceneId} at ${f.localTime.toFixed(3)}s`;
        content.push({ type: 'text', text: label }, { type: 'image', data: f.image.toString('base64'), mimeType: 'image/jpeg' });
      });
      return { content, isError: errors.length > 0 && frames.every((f) => f.errors.length > 0) };
    },
    true,
  );

  tool(
    'check_seams',
    'Pixel-compare each cut: the last frame of a scene (t = duration) against the first frame of the next scene (t = 0). 0% means the cut is invisible. With a scene, checks the cuts into and out of it; without, every cut. Differing cuts come back with the two frames and a diff image (changed pixels in pink).',
    { project: projectArg, scene: sceneArg },
    async (args) => {
      const p = await project(args.project);
      const target = args.scene ?? (scope.kind === 'scene' && scope.projectId === p.id ? scope.sceneId : undefined);
      if (target) scene(p, target);
      const checks = await seams.check(p.id, { sceneId: target, fresh: true });
      if (checks.length === 0) return text('There are no cuts to check (only one scene).');
      const names = new Map(p.scenes.map((s) => [s.id, s.name]));
      const content: Content[] = [];
      const urls: string[] = [];
      const lines: string[] = [];
      for (const { result, capture } of checks) {
        const label = `"${names.get(result.from)}" → "${names.get(result.to)}"`;
        lines.push(
          `${label}: ${result.error && result.diffPercent < 0 ? `error — ${result.error}` : describeSeam(result.diffPercent)}`,
        );
        if (capture && result.diffPercent >= 0.3) {
          urls.push(await saveFrame(p, capture.fromImage, 'png'), await saveFrame(p, capture.toImage, 'png'));
          content.push(
            { type: 'text', text: `${label} — last frame of ${result.from}:` },
            { type: 'image', data: capture.fromImage.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: `first frame of ${result.to}:` },
            { type: 'image', data: capture.toImage.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: 'diff (differing pixels in pink):' },
            { type: 'image', data: capture.diffImage.toString('base64'), mimeType: 'image/png' },
          );
        }
      }
      const summary = lines.join('\n') + (urls.length ? `\n[${FRAME_MARKER} ${urls.join(' ')}]` : '');
      return { content: [{ type: 'text', text: summary }, ...content] };
    },
    true,
  );

  tool(
    'get_music_context',
    "Tempo, beats, bars, phrases, sections and accents of the soundtrack. With a scene, everything is in that scene's local seconds, plus durations that would end the scene on a bar line. Use it to time animations to the music.",
    { project: projectArg, scene: sceneArg },
    async (args) => {
      const p = await project(args.project);
      const target = args.scene ?? (scope.kind === 'scene' && scope.projectId === p.id ? scope.sceneId : undefined);
      if (target) return text(sceneMusicContext(p, scene(p, target)));
      const a = p.musicAnalysis;
      if (!a) return text(musicSummary(p));
      const start = p.music?.start ?? 0;
      const v = (x: number) => round(x - start, 3);
      return text(
        [
          musicSummary(p),
          'Video times below (0 = start of the video).',
          `Phrase starts: ${a.phrases
            .map(v)
            .filter((x) => x >= 0)
            .join(', ')}`,
          `Sections: ${a.sections.map((s) => `${s.label} ${v(s.start)}→${v(s.end)} (energy ${s.energy.toFixed(2)})`).join('; ')}`,
          `Scene cuts now: ${p.scenes.map((s) => `${s.id}@${round(s.start, 3)}`).join(', ')}`,
        ].join('\n'),
      );
    },
    true,
  );

  tool(
    'set_scene_duration',
    'Change how long a scene lasts (seconds, millisecond precision). Later scenes shift accordingly. In a scene chat only that scene can be changed.',
    { project: projectArg, scene: sceneArg, seconds: z.number().positive().describe('New duration in seconds, e.g. 3.32') },
    async (args) => {
      const p = await project(args.project);
      const s = scene(p, args.scene);
      assertCanEditScene(p, s.id);
      const value = await store.setSceneDuration(p.id, s.id, args.seconds);
      const next = await store.get(p.id);
      return text(
        `scenes/${s.id}.tsx now lasts ${formatSeconds(value)} (was ${formatSeconds(s.duration)}).\n${sceneMusicContext(next, scene(next, s.id), false)}`,
      );
    },
  );

  tool(
    'rename_scene',
    'Rename a scene (the display name; the file name stays).',
    { project: projectArg, scene: sceneArg, name: z.string().min(1) },
    async (args) => {
      const p = await project(args.project);
      const s = scene(p, args.scene);
      assertCanEditScene(p, s.id);
      await store.renameScene(p.id, s.id, args.name);
      return text(`Renamed ${s.id} to "${args.name}".`);
    },
  );

  tool(
    'create_scene',
    'Add a new scene (project chat only). Creates scenes/<id>.tsx from `code` (or a starter) and inserts it after `after` (default: at the end). Then edit the file.',
    {
      project: projectArg,
      name: z.string().min(1),
      duration: z.number().positive().optional().describe('Seconds (default 3)'),
      after: z.string().optional().describe('Scene id to insert after'),
      code: z.string().optional().describe('Full TSX source for the scene'),
    },
    async (args) => {
      assertStructural();
      const p = await project(args.project);
      if (args.after) scene(p, args.after);
      const created = await store.createScene(p.id, {
        name: args.name,
        duration: args.duration,
        afterId: args.after,
        code: args.code,
      });
      return text(
        `Created "${created.name}" (${created.id}, ${formatSeconds(created.duration)}) → ${path.join(p.dir, 'scenes', `${created.id}.tsx`)}`,
      );
    },
  );

  tool(
    'duplicate_scene',
    'Copy a scene (code and duration) right after itself (project chat only).',
    { project: projectArg, scene: sceneArg },
    async (args) => {
      assertStructural();
      const p = await project(args.project);
      const s = scene(p, args.scene);
      const created = await store.duplicateScene(p.id, s.id);
      return text(`Duplicated ${s.id} as ${created.id} → scenes/${created.id}.tsx`);
    },
  );

  tool(
    'delete_scene',
    'Remove a scene from the video (project chat only). The file is moved to the project trash, not destroyed.',
    { project: projectArg, scene: sceneArg },
    async (args) => {
      assertStructural();
      const p = await project(args.project);
      const s = scene(p, args.scene);
      await store.deleteScene(p.id, s.id);
      return text(`Removed "${s.name}" (${s.id}).`);
    },
  );

  tool(
    'move_scene',
    'Move a scene to a new position, 1 = first (project chat only).',
    { project: projectArg, scene: sceneArg, position: z.number().int().min(1) },
    async (args) => {
      assertStructural();
      const p = await project(args.project);
      const s = scene(p, args.scene);
      await store.moveScene(p.id, s.id, args.position - 1);
      const next = await store.get(p.id);
      return text(`Order is now: ${next.scenes.map((x) => x.id).join(' → ')}`);
    },
  );

  tool(
    'snap_cuts_to_music',
    'Adjust scene durations so every cut lands on the nearest beat, bar line or phrase start of the soundtrack (project chat only).',
    { project: projectArg, grid: z.enum(['beat', 'bar', 'phrase']).optional().describe('Default: bar') },
    async (args) => {
      assertStructural();
      const p = await project(args.project);
      const snapped = snapCuts(p, args.grid ?? 'bar');
      await store.setDurations(p.id, snapped.durations);
      return text(
        `Snapped ${snapped.moved} cut(s) to the ${args.grid ?? 'bar'} grid (largest shift ${formatSeconds(snapped.maxShift)}).\n` +
          Object.entries(snapped.durations)
            .map(([id, d]) => `${id}: ${formatSeconds(d)}`)
            .join('\n'),
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Sound effects

  async function imageResult(p: ProjectState, body: string, image: Buffer | null, caption: string): Promise<ToolResult> {
    if (!image) return text(body);
    const url = await saveFrame(p, image, 'jpg');
    return {
      content: [
        { type: 'text', text: `${body}\n[${FRAME_MARKER} ${url}]` },
        { type: 'text', text: caption },
        { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' },
      ],
    };
  }

  function soundLines(list: LibrarySound[]): string {
    return list.map((s) => sounds.describeSound(s)).join('\n\n');
  }

  const PLACE_HINT =
    'Place sounds with a `sounds` export in the scene (e.g. `{ at: ENTER_AT, sound: "enter" }`, keyed to the same constants as the animation), then run check_audio.';

  tool(
    'list_sounds',
    "The project's sound library — every sound a cue can name: synth sounds and generated sounds made with create_sound / generate_sound, plus audio files the user put in sounds/. Each comes measured (length, where its peak is, loudness, brightness and frequency range), with how many cues use it.",
    { project: projectArg },
    async (args) => {
      const p = await project(args.project);
      const [{ sounds: list, warnings }, usage] = await Promise.all([soundLibrary.list(p.id), sounds.usage(p.id)]);
      if (list.length === 0) {
        return text(
          `The sound library is empty. Make sounds with create_sound${sfx.isReady() ? ' or generate_sound' : ''}, or ask the user for audio files (they go in sounds/).${warnings.length ? `\n${warnings.join('\n')}` : ''}`,
        );
      }
      const body = list.map((s) => sounds.describeSound(s, usage.get(s.name) ?? [])).join('\n\n');
      const unknown = [...usage.keys()].filter((name) => !list.some((s) => s.name === name));
      return text(
        [
          `${list.length} sound${list.length === 1 ? '' : 's'}:`,
          '',
          body,
          unknown.length ? `\nCues name sounds that don't exist: ${unknown.join(', ')}` : '',
          warnings.length ? `\n${warnings.join('\n')}` : '',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      );
    },
    true,
  );

  tool(
    'describe_sound',
    'Measure one sound in the library again: length, peak position (what align: "peak" lines up), attack, tail, loudness, brightness, which cues use it, and a spectrogram image.',
    { project: projectArg, name: z.string().min(1) },
    async (args) => {
      const p = await project(args.project);
      const described = await sounds.describe(p.id, args.name);
      return imageResult(p, described.text, described.spectrogram, 'Spectrogram (time →, frequency ↑, brighter = louder):');
    },
    true,
  );

  const presetList = PRESET_NAMES.map((name) => `${name} (${PRESETS[name].description}; ${PRESETS[name].length.default} s)`).join(
    ', ',
  );

  tool(
    'create_sound',
    `Synthesize a sound effect from a preset and keep it in the project's library under \`name\` (instant, and identical every time). Presets: ${presetList}. Settings: pitch in semitones; length in seconds; brightness 0–1 (filter/click/harmonics); weight 0–1 (low-end body); tail 0–1 (room/ring-out); motion −1…1 (stereo travel for whoosh/swish/riser/reverse); seed (small natural differences). With variants > 1 you get name-1 … name-N with different seeds (e.g. several keystrokes to alternate). Build a small consistent palette for the video and reuse it across scenes. You can't hear the result: judge it from the measurements, then check_audio.`,
    {
      project: projectArg,
      name: z.string().describe('Lowercase letters, digits and dashes, e.g. "key" or "pin-drop"'),
      preset: z.enum(PRESET_NAMES),
      pitch: z.number().min(-24).max(24).optional(),
      length: z.number().positive().optional().describe('Seconds (each preset has its own range)'),
      brightness: z.number().min(0).max(1).optional(),
      weight: z.number().min(0).max(1).optional(),
      tail: z.number().min(0).max(1).optional(),
      motion: z.number().min(-1).max(1).optional(),
      seed: z.number().int().optional(),
      variants: z.number().int().min(1).max(8).optional(),
      replace: z
        .boolean()
        .optional()
        .describe('Replace an existing sound of that name (project chat only; every cue using it changes)'),
    },
    async (args) => {
      const p = await project(args.project);
      if (args.replace && scope.kind === 'scene') {
        throw new ToolError('A scene chat can only add new sounds (other scenes may use this one). Pick a new name.');
      }
      const made = await sounds.create(p.id, {
        name: args.name,
        preset: args.preset,
        params: {
          pitch: args.pitch,
          length: args.length,
          brightness: args.brightness,
          weight: args.weight,
          tail: args.tail,
          motion: args.motion,
          seed: args.seed,
        },
        variants: args.variants ?? 1,
        replace: Boolean(args.replace),
      });
      return text(`${soundLines(made)}\n\n${PLACE_HINT}`);
    },
  );

  tool(
    'delete_sound',
    'Remove a sound Claude made from the library (project chat only). Refused while cues still use it. Files the user put in sounds/ stay.',
    { project: projectArg, name: z.string().min(1) },
    async (args) => {
      assertStructural('Removing sounds');
      const p = await project(args.project);
      const uses = (await sounds.usage(p.id)).get(args.name) ?? [];
      if (uses.length) {
        const byScene = new Map<string, number>();
        for (const c of uses) byScene.set(c.sceneId, (byScene.get(c.sceneId) ?? 0) + 1);
        throw new ToolError(
          `"${args.name}" is still used by ${[...byScene].map(([id, n]) => `${n} cue${n === 1 ? '' : 's'} in scenes/${id}.tsx`).join(', ')}; remove those cues first.`,
        );
      }
      await soundLibrary.remove(p.id, args.name);
      return text(`Removed "${args.name}" from the library.`);
    },
  );

  tool(
    'check_audio',
    "Mix the soundtrack and every sound cue exactly as the render will, and report what you can't hear yourself: loudness and limiting, and for each cue where it starts, its settings and how well it cuts through everything else playing at that moment (clear / audible / faint / masked, in dB), plus broken cues and missing sounds, and a spectrogram of the mix. With a scene, reports the cues sounding in that scene. Run it after placing or changing sounds.",
    { project: projectArg, scene: sceneArg },
    async (args) => {
      const p = await project(args.project);
      const target = args.scene ?? (scope.kind === 'scene' && scope.projectId === p.id ? scope.sceneId : undefined);
      if (target) scene(p, target);
      const checked = await sounds.check(p.id, target);
      return imageResult(
        p,
        checked.text,
        checked.spectrogram,
        'Spectrogram of the mix (time →, frequency ↑, brighter = louder):',
      );
    },
    true,
  );

  tool(
    'set_music_volume',
    "Set the soundtrack's volume (0–1, linear; 1 = as generated) to balance it against the sound effects (project chat only, undoable).",
    { project: projectArg, volume: z.number().min(0).max(1) },
    async (args) => {
      assertStructural('Changing the soundtrack');
      const p = await project(args.project);
      if (!p.music) throw new ToolError('This project has no soundtrack.');
      await store.updateMusic(p.id, { volume: args.volume });
      return text(`The soundtrack now plays at volume ${args.volume.toFixed(2)} (was ${p.music.volume.toFixed(2)}).`);
    },
  );

  if (sfx.isReady()) {
    tool(
      'generate_sound',
      'Make a sound effect from a text prompt with the local sound model (Stable Audio Open) and keep it in the library — for realistic or specific sounds the synth presets can\'t make (foley, materials, nature, crowds, machines). Describe the sound itself, not the scene: source, material, action, character, length (e.g. "single mechanical keyboard key press, close-miked, dry"). Keep it isolated: no music. Each variation is kept as name-a, name-b, … (just name with one variation), trimmed and levelled, and comes back measured with a spectrogram; you can\'t hear them, so compare the measurements, pick one and delete_sound the rest if you like. Takes several seconds per request.',
      {
        project: projectArg,
        name: z.string().describe('Lowercase letters, digits and dashes, e.g. "pin-drop"'),
        prompt: z.string().min(3),
        duration: z.number().min(0.2).max(20).optional().describe('Seconds (default 2)'),
        variations: z.number().int().min(1).max(4).optional().describe('Default 2'),
        seed: z.number().int().optional(),
        replace: z.boolean().optional().describe('Replace an existing sound of that name (project chat only)'),
      },
      async (args) => {
        const p = await project(args.project);
        if (args.replace && scope.kind === 'scene') {
          throw new ToolError('A scene chat can only add new sounds (other scenes may use this one). Pick a new name.');
        }
        const made = await sounds.generate(p.id, {
          name: args.name,
          prompt: args.prompt,
          duration: args.duration ?? 2,
          variations: args.variations ?? 2,
          seed: args.seed,
          replace: Boolean(args.replace),
        });
        const content: Content[] = [];
        const urls: string[] = [];
        for (const sound of made.sounds) {
          const described = await sounds.describe(p.id, sound.name);
          if (described.spectrogram) {
            urls.push(await saveFrame(p, described.spectrogram, 'jpg'));
            content.push(
              { type: 'text', text: `Spectrogram of ${sound.name}:` },
              { type: 'image', data: described.spectrogram.toString('base64'), mimeType: 'image/jpeg' },
            );
          }
        }
        const footer = urls.length ? `\n[${FRAME_MARKER} ${urls.join(' ')}]` : '';
        return {
          content: [
            {
              type: 'text',
              text: `Generated in ${made.seconds.toFixed(1)} s:\n\n${soundLines(made.sounds)}\n\n${PLACE_HINT}${footer}`,
            },
            ...content,
          ],
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Music — only offered while the engine is running, and not to scene chats.

  async function takeResult(p: ProjectState, job: MusicJob): Promise<ToolResult> {
    if (job.status === 'running') {
      return text(
        `Still composing (job ${job.id}${job.stage ? `, ${job.stage}` : ''}). Call wait_for_music with job_id "${job.id}".`,
      );
    }
    if (job.status === 'error')
      return { content: [{ type: 'text', text: `The music engine failed: ${job.error}` }], isError: true };
    const summaries: string[] = [];
    const images: Content[] = [];
    const urls: string[] = [];
    for (const takeId of job.takeIds) {
      const take = await library.get(p.id, takeId);
      const described = await music.describe(p.id, take);
      summaries.push(described.text);
      if (described.spectrogram) {
        urls.push(await saveFrame(p, described.spectrogram, 'jpg'));
        images.push(
          { type: 'text', text: `Spectrogram of ${take.id} (time →, frequency ↑, brighter = louder):` },
          { type: 'image', data: described.spectrogram.toString('base64'), mimeType: 'image/jpeg' },
        );
      }
    }
    const footer = urls.length ? `\n[${FRAME_MARKER} ${urls.join(' ')}]` : '';
    return {
      content: [
        { type: 'text', text: `${summaries.join('\n\n')}\n\nUse use_music_take to make one of these the soundtrack.${footer}` },
        ...images,
      ],
    };
  }

  if (engine.isReady() && scope.kind !== 'scene') {
    tool(
      'generate_music',
      'Compose original music with the local music model and get the takes back, measured. Use it when the video needs a soundtrack or the user wants different music. Decide the style yourself from the art direction, pacing and content — do not ask the user for a genre. Write `prompt` like a brief to a composer: genre, mood, instrumentation, the energy arc mapped to the edit (e.g. "soft build, drop at 4 s, break at 16 s, final hit at 20 s"), production qualities and what to avoid. Duration defaults to the video length. Choose a BPM whose bar length (240 / BPM seconds in 4/4) fits the scene lengths. Each take comes back with its tempo, bar grid, sections, strongest hits, loudness, how its bars line up with the current cuts, and a spectrogram image — you cannot hear it, so judge fit from those. Composing takes about a minute; if it is not done yet, call wait_for_music.',
      {
        project: projectArg,
        prompt: z.string().min(12).describe('The brief for the composer'),
        duration: z.number().min(10).max(600).optional().describe('Seconds (default: the video length plus a short tail)'),
        bpm: z.number().int().min(40).max(220).optional(),
        key: z.string().optional().describe('e.g. "C major", "A minor"'),
        time_signature: z.enum(['3', '4', '6']).optional(),
        variations: z.number().int().min(1).max(4).optional().describe('Takes to generate (default 2)'),
        quality: z.enum(['best', 'draft']).optional().describe('best (default) plans the whole piece first; draft is quicker'),
        lyrics: z.string().optional().describe('Only when vocals are wanted; omit for instrumental'),
        seed: z.number().int().optional(),
      },
      async (args) => {
        const p = await project(args.project);
        const total = p.scenes.reduce((sum, x) => sum + x.duration, 0);
        const job = music.compose(p.id, {
          prompt: args.prompt,
          duration: args.duration ?? Math.max(10, Math.ceil(total + 1)),
          bpm: args.bpm,
          key: args.key,
          timeSignature: args.time_signature,
          variations: args.variations ?? 2,
          quality: args.quality ?? 'best',
          lyrics: args.lyrics,
          seed: args.seed,
        });
        return takeResult(p, await music.wait(job.id, MUSIC_WAIT_MS));
      },
    );

    tool(
      'wait_for_music',
      'Wait for a generate_music or repaint_music job that was still running, then get its takes.',
      { project: projectArg, job_id: z.string() },
      async (args) => takeResult(await project(args.project), await music.wait(args.job_id, MUSIC_WAIT_MS)),
      true,
    );

    tool(
      'list_music_takes',
      'Every music take kept for the project (generated, repainted and uploaded), newest last, and which one is the soundtrack.',
      { project: projectArg },
      async (args) => {
        const p = await project(args.project);
        const takes = await library.list(p.id);
        if (takes.length === 0) return text('No music takes yet.');
        return text(
          takes
            .map(
              (t) =>
                `${t.id}${p.music?.file === t.file ? ' (current soundtrack)' : ''} — "${t.name}" · ${t.source} · ${formatSeconds(t.duration)}${t.bpm ? ` · ${t.bpm.toFixed(1)} BPM` : ''}${t.sections ? ` · ${t.sections}` : ''}`,
            )
            .join('\n'),
        );
      },
      true,
    );

    tool(
      'describe_music_take',
      'Measure one take again: tempo, bars, sections, strongest hits, loudness, fit to the current cuts, and a spectrogram image.',
      { project: projectArg, take_id: z.string() },
      async (args) => {
        const p = await project(args.project);
        const described = await music.describe(p.id, await library.get(p.id, args.take_id));
        const content: Content[] = [{ type: 'text', text: described.text }];
        if (described.spectrogram) {
          const url = await saveFrame(p, described.spectrogram, 'jpg');
          content[0] = { type: 'text', text: `${described.text}\n[${FRAME_MARKER} ${url}]` };
          content.push({ type: 'image', data: described.spectrogram.toString('base64'), mimeType: 'image/jpeg' });
        }
        return { content };
      },
      true,
    );

    tool(
      'use_music_take',
      'Make a take the soundtrack (undoable; earlier takes are kept). `start` is where in the track the video begins (default: keep the current offset, or 0). Afterwards consider snap_cuts_to_music so cuts land on its bars, then check_seams.',
      { project: projectArg, take_id: z.string(), start: z.number().min(0).optional() },
      async (args) => {
        const p = await project(args.project);
        const take = await music.use(p.id, args.take_id, args.start);
        const next = await store.get(p.id);
        return text(`The soundtrack is now ${take.id} ("${take.name}").\n${musicSummary(next)}`);
      },
    );

    tool(
      'repaint_music',
      'Regenerate just one span of a take (e.g. the drop or the ending hit) and keep the rest; creates new takes. Use `prompt` to steer the new part.',
      {
        project: projectArg,
        take_id: z.string(),
        start: z.number().min(0).describe('Seconds into the take'),
        end: z.number().min(0).describe('Seconds into the take'),
        prompt: z.string().optional(),
        variations: z.number().int().min(1).max(4).optional().describe('Default 1'),
      },
      async (args) => {
        const p = await project(args.project);
        const job = await music.repaint(p.id, {
          takeId: args.take_id,
          start: args.start,
          end: args.end,
          prompt: args.prompt,
          variations: args.variations ?? 1,
        });
        return takeResult(p, await music.wait(job.id, MUSIC_WAIT_MS));
      },
    );
  }

  return server;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Stateless streamable-HTTP MCP endpoint at /mcp. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, services: ToolServices) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
    return;
  }
  const server = createToolServer(services, scopeFrom(req.headers));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
