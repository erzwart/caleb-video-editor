import type { Effort } from '../config';

export interface McpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/** One user turn handed to an agent provider. */
export interface AgentTurn {
  cwd: string;
  prompt: string;
  /** Appended to the provider's own system prompt; keep it stable per chat so it caches. */
  systemPrompt: string;
  sessionId: string;
  /** Continue an existing session instead of starting `sessionId` fresh. */
  resume: boolean;
  model: string;
  effort: Effort;
  /** Built-in tools to expose (e.g. Read, Edit, Write, Glob, Grep). */
  tools: string[];
  /** Pre-approved permission rules; everything else is denied without prompting. */
  allow: string[];
  mcpServers: Record<string, McpServerConfig>;
  signal: AbortSignal;
}

export type AgentEvent =
  | { type: 'init'; sessionId: string; model?: string }
  /** Streaming text of the current assistant text block. */
  | { type: 'text-delta'; text: string }
  /** A complete text block that was not streamed. */
  | { type: 'text'; text: string }
  /** Progress note / reasoning summary between tool calls. */
  | { type: 'note'; text: string }
  | { type: 'tool-start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-end'; id: string; isError: boolean; output: string }
  | {
      type: 'done';
      text: string;
      isError: boolean;
      durationMs: number;
      costUsd?: number;
      sessionId?: string;
      subtype?: string;
    };

export interface AgentProviderStatus {
  ok: boolean;
  label: string;
  version?: string;
  detail?: string;
}

/** Anything that can run an agent turn against the Storyboard tools (Codex and Claude Code). */
export interface AgentProvider {
  id: string;
  label: string;
  status(): Promise<AgentProviderStatus>;
  run(turn: AgentTurn): AsyncIterable<AgentEvent>;
}

/** Minimal push-based async iterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: { resolve: (r: IteratorResult<T>) => void; reject: (e: Error) => void }[] = [];
  private finished = false;
  private failure: Error | null = null;

  push(item: T) {
    if (this.finished) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  end(error?: Error) {
    if (this.finished) return;
    this.finished = true;
    this.failure = error ?? null;
    for (const waiter of this.waiters.splice(0)) {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.finished) {
          return this.failure ? Promise.reject(this.failure) : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
