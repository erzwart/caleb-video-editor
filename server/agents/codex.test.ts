import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codexArgs, CodexJsonParser, CodexProvider } from './codex';
import type { AgentEvent, AgentTurn } from './types';

const turn: AgentTurn = {
  cwd: '/tmp/project',
  prompt: 'edit',
  systemPrompt: 'Scene instructions',
  sessionId: 'thread-id',
  resume: false,
  model: '',
  effort: 'medium',
  tools: [],
  allow: ['mcp__storyboard__read_project_file', 'mcp__storyboard__write_project_file'],
  mcpServers: { storyboard: { type: 'http', url: 'http://127.0.0.1:5199/mcp', headers: { 'X-Storyboard-Scene': 'one' } } },
  signal: new AbortController().signal,
};

test('Codex isolates config, denies shell/file writes and forwards only approved scoped MCP tools', () => {
  const args = codexArgs(turn);
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(!args.includes('--model'));
  const mcp = args.find((arg) => arg.startsWith('mcp_servers='))!;
  assert.ok(mcp.includes('"http_headers"={"X-Storyboard-Scene"="one"}'));
  assert.ok(mcp.includes('"enabled_tools"=["read_project_file","write_project_file"]'));
  assert.ok(mcp.includes('"default_tools_approval_mode"="approve"'));
  assert.deepEqual(codexArgs({ ...turn, resume: true }).slice(-3), ['resume', 'thread-id', '-']);
  assert.ok(
    !codexArgs({ ...turn, allow: ['mcp__storyboard__*'] })
      .find((arg) => arg.startsWith('mcp_servers='))!
      .includes('enabled_tools'),
  );
});

test('Codex process adapter passes stdin, resumes sessions and stops its own child', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-codex-process-'));
  const bin = path.join(dir, 'codex-test');
  await fs.writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const emit = msg => console.log(JSON.stringify(msg));
  emit({type:'thread.started', thread_id:'test-thread'});
  if (prompt === 'wait') { setInterval(() => {}, 1000); return; }
  emit({type:'item.completed', item:{id:'reply', type:'agent_message', text:args.includes('resume') ? 'resumed: '+prompt : 'fresh: '+prompt}});
  emit({type:'turn.completed'});
});
`,
    { mode: 0o755 },
  );
  try {
    const provider = new CodexProvider(bin);
    assert.equal((await provider.status()).ok, true);
    for (const resume of [false, true]) {
      const events: AgentEvent[] = [];
      for await (const event of provider.run({ ...turn, cwd: dir, prompt: 'hello', resume })) events.push(event);
      const done = events.at(-1) as Extract<AgentEvent, { type: 'done' }>;
      assert.equal(done.text, `${resume ? 'resumed' : 'fresh'}: hello`);
      assert.equal(done.isError, false);
    }
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);
    try {
      const events: AgentEvent[] = [];
      for await (const event of provider.run({ ...turn, cwd: dir, prompt: 'wait', signal: abort.signal })) {
        events.push(event);
        if (event.type === 'init') abort.abort();
      }
      assert.equal((events.at(-1) as Extract<AgentEvent, { type: 'done' }>).text, 'Stopped.');
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Codex JSONL maps sessions, reasoning, tool progress, images, errors and final replies', () => {
  const events: AgentEvent[] = [];
  const parser = new CodexJsonParser((event) => events.push(event));
  const line = (msg: unknown) => parser.line(JSON.stringify(msg));
  parser.line('not JSON');
  line({ type: 'thread.started', thread_id: 'abc' });
  line({ type: 'item.completed', item: { id: 'reason', type: 'reasoning', text: 'Checking frames' } });
  const item = { id: 'tool', type: 'mcp_tool_call', server: 'storyboard', tool: 'render_frames', arguments: { times: [0] } };
  line({ type: 'item.started', item });
  line({
    type: 'item.completed',
    item: {
      ...item,
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: '[storyboard-frames: /api/frame.jpg]' },
          { type: 'image', data: 'omitted' },
        ],
      },
    },
  });
  line({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'Done' } });
  line({ type: 'turn.completed' });
  assert.deepEqual(
    events.map((event) => event.type),
    ['init', 'note', 'tool-start', 'tool-end', 'text', 'done'],
  );
  assert.deepEqual(events[2], { type: 'tool-start', id: 'tool', name: 'mcp__storyboard__render_frames', input: { times: [0] } });
  assert.equal((events[3] as Extract<AgentEvent, { type: 'tool-end' }>).output, '[storyboard-frames: /api/frame.jpg]\n[image]');
  assert.equal((events[5] as Extract<AgentEvent, { type: 'done' }>).sessionId, 'abc');
  line({ type: 'turn.failed', error: { message: 'Login expired' } });
  assert.equal((events.at(-1) as Extract<AgentEvent, { type: 'done' }>).isError, true);
});
