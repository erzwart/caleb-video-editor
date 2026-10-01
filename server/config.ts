import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECTS_DIR = path.resolve(process.env.STORYBOARD_PROJECTS ?? path.join(ROOT, 'projects'));
export const HOST = process.env.HOST ?? '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 5199);
export const BASE_URL = `http://${HOST}:${PORT}`;
export const MCP_URL = `${BASE_URL}/mcp`;

/**
 * Everything `./storyboard` installs or keeps for this machine lives in the app folder (git-ignored):
 * the choices made in setup, uv and its Python, headless Chromium, the engines' API keys, PID files and logs.
 */
export const LOCAL_DIR = path.join(ROOT, '.storyboard');
export const SETTINGS_FILE = path.join(LOCAL_DIR, 'settings.json');
export const LOG_DIR = path.join(LOCAL_DIR, 'logs');
export const RUN_DIR = path.join(LOCAL_DIR, 'run');
export const KEYS_DIR = path.join(LOCAL_DIR, 'keys');
export const BROWSERS_DIR = path.join(LOCAL_DIR, 'browsers');
// Playwright reads this once, when it loads; capture.ts and doctor.ts import Playwright lazily, after this ran.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= BROWSERS_DIR;

/** Music engine (ACE-Step's REST API). Local by default; point it at another machine later. */
export const MUSIC_URL = (process.env.STORYBOARD_MUSIC_URL ?? 'http://127.0.0.1:8001').replace(/\/+$/, '');
/** The local ACE-Step install made by `./storyboard setup`: its code, Python environment and checkpoints. */
export const MUSIC_DIR = path.join(ROOT, 'engines', 'music');
export const MUSIC_PYTHON = path.join(MUSIC_DIR, '.venv', 'bin', 'python');
/** Shared secret between Storyboard and the engine; created on first use. */
export const MUSIC_KEY_FILE = path.join(KEYS_DIR, 'music');

/** Sound-effects engine (Stable Audio Open behind engines/sfx/server.py). Local by default. */
export const SFX_URL = (process.env.STORYBOARD_SFX_URL ?? 'http://127.0.0.1:8002').replace(/\/+$/, '');
/** The engine's Python project (pyproject.toml, uv.lock, server.py); setup adds its .venv and the model. */
export const SFX_DIR = path.join(ROOT, 'engines', 'sfx');
export const SFX_PYTHON = path.join(SFX_DIR, '.venv', 'bin', 'python');
/** The Hugging Face cache holding Stable Audio Open (server.py points HF_HUB_CACHE here). */
export const SFX_MODELS_DIR = path.join(SFX_DIR, 'models');
/** Shared secret between Storyboard and the sound-effects engine; created on first use. */
export const SFX_KEY_FILE = path.join(KEYS_DIR, 'sfx');

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const CLAUDE_BIN = process.env.CLAUDE_PATH ?? 'claude';
export const CODEX_BIN = process.env.CODEX_PATH ?? 'codex';
export const AGENT_PROVIDER = process.env.STORYBOARD_AGENT ?? 'codex';
if (!['codex', 'claude-code'].includes(AGENT_PROVIDER)) {
  throw new Error('STORYBOARD_AGENT must be codex or claude-code');
}

/** Model and effort the in-app agent uses unless the UI picks something else. */
export const DEFAULT_MODEL = process.env.STORYBOARD_MODEL ?? (AGENT_PROVIDER === 'codex' ? '' : 'claude-opus-5-5');
export const DEFAULT_EFFORT = (process.env.STORYBOARD_EFFORT ?? 'medium') as Effort;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Frames sent to the agent: 960×540 JPEG keeps a batch of frames well under MCP output limits. */
export const AGENT_FRAME_SCALE = 0.5;
export const AGENT_FRAME_QUALITY = 82;
export const MAX_FRAMES_PER_CALL = 8;

/** Internal per-project folder (chats, undo snapshots, captured frames). */
export const INTERNAL_DIR = '.storyboard';
