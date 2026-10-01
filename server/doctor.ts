// Checks that everything Storyboard needs is in place:  ./storyboard doctor  (or npm run doctor)
// Exits with 1 while something required is missing, so agents can use it as a setup gate.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { AGENT_PROVIDER, BASE_URL, CLAUDE_BIN, FFMPEG, HOST, MUSIC_URL, PORT, PROJECTS_DIR, ROOT, SFX_URL } from './config';
import { CodexProvider } from './agents/codex';
import { engineHealth, engineInstalled, isLocalUrl } from './music/engine';
import { readSettings } from './settings';
import { rail, Task } from './cli/ui';
import { sfxEngineHealth, sfxEngineInstalled, sfxModelDownloaded } from './sound/engine';

const execFileAsync = promisify(execFile);

export interface Check {
  /** fail: Storyboard can't work until it's fixed · warn: works, with a caveat · info: optional extras. */
  level: 'ok' | 'fail' | 'warn' | 'info';
  label: string;
  fix?: string;
}

let alreadyRunning = false;

export function checkNode(): Check {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 12)
    ? { level: 'ok', label: `Node.js ${process.versions.node}` }
    : {
        level: 'fail',
        label: `Node.js ${process.versions.node} is too old`,
        fix: 'Install Node.js 22.12 or newer (nvm install reads .nvmrc)',
      };
}

export async function checkFfmpeg(): Promise<Check> {
  let version: string;
  try {
    const { stdout } = await execFileAsync(FFMPEG, ['-version']);
    version = stdout.match(/ffmpeg version (\S+)/)?.[1] ?? '';
  } catch {
    return {
      level: 'fail',
      label: `ffmpeg not found (${FFMPEG})`,
      fix: './storyboard setup installs it (or: brew install ffmpeg · sudo apt install ffmpeg)',
    };
  }
  // Renders are H.264 with AAC audio.
  const { stdout: encoders } = await execFileAsync(FFMPEG, ['-hide_banner', '-encoders'], { maxBuffer: 8 * 1024 * 1024 });
  const missing = ['libx264', 'aac'].filter((name) => !new RegExp(`\\s${name}\\s`).test(encoders));
  return missing.length
    ? {
        level: 'fail',
        label: `ffmpeg ${version} has no ${missing.join(' or ')} encoder`,
        fix: 'Install an ffmpeg build that includes libx264 (e.g. brew install ffmpeg)',
      }
    : { level: 'ok', label: `ffmpeg ${version}` };
}

export async function checkChromium(): Promise<Check> {
  try {
    // Imported here: config.ts has set PLAYWRIGHT_BROWSERS_PATH (the app folder) by now.
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const version = browser.version();
    await browser.close();
    return { level: 'ok', label: `Headless Chromium ${version}` };
  } catch (e) {
    const message = (e as Error).message;
    if (/Executable doesn't exist/i.test(message)) {
      return { level: 'fail', label: 'Headless Chromium is not installed', fix: './storyboard setup' };
    }
    return {
      level: 'fail',
      label: `Headless Chromium does not start: ${message.split('\n')[0]}`,
      fix: './storyboard setup',
    };
  }
}

/** Claude Code's status: `installed` false when it isn't found, `loggedIn` null when the login couldn't be checked. */
export async function claudeStatus(): Promise<{
  installed: boolean;
  version?: string;
  loggedIn: boolean | null;
  method?: string;
}> {
  let version: string;
  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, ['--version'], { timeout: 15000 });
    version = stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? stdout.trim();
  } catch {
    return { installed: false, loggedIn: false };
  }
  // The same environment the in-app agent gets (agents/claudeCode.ts): your login, not ANTHROPIC_API_KEY.
  const env = { ...process.env };
  if (!process.env.STORYBOARD_USE_API_KEY) delete env.ANTHROPIC_API_KEY;
  let output = '';
  try {
    output = (await execFileAsync(CLAUDE_BIN, ['auth', 'status', '--json'], { timeout: 15000, env })).stdout;
  } catch (e) {
    // Exits with 1 when logged out, still printing the status.
    output = (e as { stdout?: string }).stdout ?? '';
  }
  try {
    const status = JSON.parse(output) as { loggedIn?: boolean; authMethod?: string };
    return { installed: true, version, loggedIn: Boolean(status.loggedIn), method: status.authMethod };
  } catch {
    return { installed: true, version, loggedIn: null };
  }
}

export async function checkClaude(): Promise<Check> {
  const status = await claudeStatus();
  if (!status.installed) {
    return {
      level: 'fail',
      label: `Claude Code not found (${CLAUDE_BIN})`,
      fix: './storyboard setup installs it (or see https://code.claude.com), then: claude auth login',
    };
  }
  if (status.loggedIn === null) {
    return {
      level: 'warn',
      label: `Claude Code ${status.version} (could not check the login)`,
      fix: 'If the chat says "Not logged in", run: claude auth login',
    };
  }
  return status.loggedIn
    ? { level: 'ok', label: `Claude Code ${status.version}, logged in${status.method ? ` (${status.method})` : ''}` }
    : { level: 'fail', label: `Claude Code ${status.version} is not logged in`, fix: 'Run: claude auth login' };
}

export async function checkCodex(): Promise<Check> {
  const status = await new CodexProvider().status();
  return status.ok
    ? { level: 'ok', label: `Codex ${status.version}, logged in` }
    : { level: 'fail', label: status.detail ?? 'Codex is unavailable', fix: 'Install Codex CLI 0.159+ and run: codex login' };
}

async function checkPort(): Promise<Check> {
  const free = await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(PORT, HOST, () => server.close(() => resolve(true)));
  });
  if (free) return { level: 'ok', label: `Port ${PORT} is free` };
  alreadyRunning = await fetch(`${BASE_URL}/api/info`, { signal: AbortSignal.timeout(2000) })
    .then(async (res) => res.ok && 'projectsDir' in ((await res.json()) as object))
    .catch(() => false);
  return alreadyRunning
    ? { level: 'info', label: `Storyboard is already running at ${BASE_URL}` }
    : {
        level: 'warn',
        label: `Port ${PORT} is used by another program`,
        fix: 'Start on another port: PORT=5299 ./storyboard start',
      };
}

function checkProjects(): Check {
  const rel = path.relative(ROOT, PROJECTS_DIR);
  const shown = rel.startsWith('..') || path.isAbsolute(rel) ? PROJECTS_DIR : `./${rel}`;
  try {
    const count = fs.readdirSync(PROJECTS_DIR).filter((d) => fs.existsSync(path.join(PROJECTS_DIR, d, 'project.json'))).length;
    return { level: 'info', label: `Projects in ${shown} (${count})` };
  } catch {
    return { level: 'info', label: `Projects in ${shown} (created on first start)` };
  }
}

/** An optional engine: off, on but not installed, stopped or running. */
async function checkEngine(
  name: string,
  on: boolean | undefined,
  url: string,
  installed: boolean,
  health: () => Promise<string | null>,
  service: string,
): Promise<Check> {
  const state = await health();
  if (state) return { level: 'info', label: `${name}: ${state} at ${url}` };
  if (!isLocalUrl(url)) return { level: 'info', label: `${name}: not answering at ${url}` };
  if (on === undefined)
    return { level: 'info', label: `${name} (optional): not set up`, fix: './storyboard setup asks about it' };
  if (!on) return { level: 'info', label: `${name} (optional): off`, fix: './storyboard setup turns it on' };
  if (!installed)
    return { level: 'warn', label: `${name}: on, but not installed`, fix: './storyboard setup finishes installing it' };
  return { level: 'info', label: `${name}: installed, stopped`, fix: `./storyboard start ${service}` };
}

const checkMusic = () =>
  checkEngine(
    'Music generation',
    readSettings()?.music,
    MUSIC_URL,
    engineInstalled(),
    async () => {
      const h = await engineHealth();
      return h ? (h.initialized ? 'running' : 'loading models') : null;
    },
    'music',
  );

const checkSfx = () =>
  checkEngine(
    'Sound-effects generation',
    readSettings()?.sfx,
    SFX_URL,
    sfxEngineInstalled() && sfxModelDownloaded(),
    async () => {
      const h = await sfxEngineHealth();
      return h ? (h.ready ? 'running' : h.loading ? 'loading the model' : `not usable (${h.error ?? 'unknown'})`) : null;
    },
    'sfx',
  );

/** Print every check; resolves to the exit code (1 while something required is missing). */
export async function doctor(): Promise<number> {
  rail.open('Storyboard doctor');
  rail.gap();
  const checking = new Task('Checking');
  const checks = await Promise.all([
    checkNode(),
    checkFfmpeg(),
    checkChromium(),
    AGENT_PROVIDER === 'codex' ? checkCodex() : checkClaude(),
    checkPort(),
    checkProjects(),
    checkMusic(),
    checkSfx(),
  ]);
  checking.clear();
  for (const check of checks) {
    rail.mark(check.level, check.label);
    if (check.fix) rail.hint(check.fix);
  }
  const failed = checks.filter((c) => c.level === 'fail').length;
  if (failed) {
    rail.close(`${failed} problem${failed === 1 ? '' : 's'} to fix · ./storyboard setup fixes most of them`, 'fail');
    return 1;
  }
  rail.close(alreadyRunning ? `Ready · running at ${BASE_URL}` : 'Ready · start it with ./storyboard start');
  return 0;
}
