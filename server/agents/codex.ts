import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { CODEX_BIN } from '../config';
import { AsyncQueue, type AgentEvent, type AgentProvider, type AgentProviderStatus, type AgentTurn } from './types';

const execFileAsync = promisify(execFile);

// JSON strings are also TOML basic strings. Tables need TOML's '=' syntax.
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, v]) => `${JSON.stringify(key)}=${toml(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function codexArgs(turn: AgentTurn): string[] {
  const mcp = Object.fromEntries(
    Object.entries(turn.mcpServers).map(([name, server]) => {
      const prefix = `mcp__${name}__`;
      const allowed = turn.allow.filter((rule) => rule.startsWith(prefix)).map((rule) => rule.slice(prefix.length));
      return [
        name,
        {
          url: server.url,
          http_headers: server.headers ?? {},
          required: true,
          tool_timeout_sec: 300,
          // These are the same scoped tools pre-approved through turn.allow for Claude.
          // `auto` requests approval for writes in a read-only sandbox; exec cannot prompt.
          default_tools_approval_mode: 'approve',
          ...(allowed.includes('*') ? {} : { enabled_tools: allowed }),
        },
      ];
    }),
  );
  const config: Record<string, unknown> = {
    approval_policy: 'never',
    sandbox_mode: 'read-only',
    'features.shell_tool': false,
    'features.unified_exec': false,
    'features.apps': false,
    'features.view_image': false,
    'features.browser_use': false,
    'features.computer_use': false,
    'features.in_app_browser': false,
    'features.plugins': false,
    'features.hooks': false,
    'features.multi_agent': false,
    'features.workspace_dependencies': false,
    'features.skill_mcp_dependency_install': false,
    'features.image_generation': false,
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    developer_instructions: `${turn.systemPrompt}\n\nRead and edit project files using list_project_files, read_project_file and write_project_file on the storyboard MCP server. Built-in file writes and shell commands are unavailable. File paths are relative to the project folder.`,
    model_reasoning_effort: turn.effort,
    mcp_servers: mcp,
  };
  return [
    'exec',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
    '--skip-git-repo-check',
    ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]),
    ...(turn.model ? ['--model', turn.model] : []),
    ...(turn.resume ? ['resume', turn.sessionId, '-'] : ['-']),
  ];
}

export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly label = 'Codex';
  constructor(private bin = CODEX_BIN) {}

  async status(): Promise<AgentProviderStatus> {
    try {
      const { stdout } = await execFileAsync(this.bin, ['--version'], { timeout: 15000 });
      // --ignore-user-config/--ignore-rules isolate the app from unrelated MCPs and rules.
      const version = stdout.trim();
      const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
      if (!match || (Number(match[1]) === 0 && Number(match[2]) < 159)) {
        return { ok: false, label: this.label, version, detail: 'Storyboard needs Codex CLI 0.159 or newer.' };
      }
      await execFileAsync(this.bin, ['login', 'status'], { timeout: 15000 });
      return { ok: true, label: this.label, version };
    } catch (e) {
      return {
        ok: false,
        label: this.label,
        detail: `Could not run Codex or verify its login. Install Codex CLI, run codex login, or set CODEX_PATH. (${(e as Error).message})`,
      };
    }
  }

  run(turn: AgentTurn): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const env = { ...process.env };
    if (!process.env.STORYBOARD_USE_API_KEY) {
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
    }
    const child = spawn(this.bin, codexArgs(turn), { cwd: turn.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const started = Date.now();
    let finished = false;
    let stderr = '';
    const parser = new CodexJsonParser((event) => {
      if (event.type === 'done') finished = true;
      queue.push(event);
    }, started);
    const log = process.env.STORYBOARD_AGENT_LOG ? fs.createWriteStream(process.env.STORYBOARD_AGENT_LOG, { flags: 'a' }) : null;
    child.stdin.on('error', () => undefined);
    child.stdin.end(turn.prompt);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      log?.write(`${line}\n`);
      parser.line(line);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    const timers: NodeJS.Timeout[] = [];
    const onAbort = () => {
      child.kill('SIGINT');
      timers.push(
        setTimeout(() => child.kill('SIGTERM'), 1500),
        setTimeout(() => child.kill('SIGKILL'), 5000),
      );
      timers.forEach((timer) => timer.unref());
    };
    if (turn.signal.aborted) onAbort();
    else turn.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      finished = true;
      queue.push({ type: 'done', text: `Could not start Codex (${CODEX_BIN}): ${e.message}`, isError: true, durationMs: 0 });
      queue.end();
    });
    child.on('close', (code) => {
      log?.end();
      timers.forEach(clearTimeout);
      turn.signal.removeEventListener('abort', onAbort);
      if (!finished) {
        queue.push({
          type: 'done',
          text: turn.signal.aborted ? 'Stopped.' : stderr.trim() || `Codex exited with code ${code}`,
          isError: !turn.signal.aborted,
          durationMs: Date.now() - started,
        });
      }
      queue.end();
    });
    return queue;
  }
}

/** Codex exec's documented JSONL events, including MCP progress and frame markers. */
export class CodexJsonParser {
  private sessionId?: string;
  private lastText = '';
  private starts = new Set<string>();
  private error = '';
  constructor(
    private emit: (event: AgentEvent) => void,
    private started = Date.now(),
  ) {}

  line(raw: string) {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'thread.started') {
      this.sessionId = msg.thread_id;
      this.emit({ type: 'init', sessionId: msg.thread_id });
    } else if (msg.type === 'item.started' || msg.type === 'item.completed') {
      const item = msg.item ?? {};
      const complete = msg.type === 'item.completed';
      if (item.type === 'agent_message' && complete) {
        this.lastText = item.text ?? '';
        this.emit({ type: 'text', text: this.lastText });
      } else if (item.type === 'reasoning' && complete && item.text) {
        this.emit({ type: 'note', text: item.text });
      } else if (item.type === 'mcp_tool_call') {
        if (!this.starts.has(item.id)) {
          this.starts.add(item.id);
          this.emit({ type: 'tool-start', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} });
        }
        if (complete) {
          const content = item.result?.content ?? [];
          const output = content
            .map((part: Record<string, any>) => (part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : ''))
            .filter(Boolean)
            .join('\n');
          this.emit({
            type: 'tool-end',
            id: item.id,
            isError: item.status === 'failed' || Boolean(item.error || item.result?.isError),
            output: item.error?.message ?? output,
          });
        }
      } else if (item.type === 'error' && complete) {
        this.error = item.message ?? 'Codex failed';
      }
    } else if (msg.type === 'error') {
      this.error = msg.message ?? 'Codex failed';
    } else if (msg.type === 'turn.completed' || msg.type === 'turn.failed') {
      const failed = msg.type === 'turn.failed';
      this.emit({
        type: 'done',
        text: failed ? (msg.error?.message ?? this.error) : this.lastText,
        isError: failed,
        durationMs: Date.now() - this.started,
        sessionId: this.sessionId,
      });
    }
  }
}
