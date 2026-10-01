# Developing Storyboard

Coding agents: [`AGENTS.md`](../AGENTS.md) has the setup steps, a map of the code and the conventions. People: the same file is a good tour.

Edits to `src/` apply live (Vite); restart `npm run dev` after editing `server/`. Before sending a change:

```bash
npm run typecheck
npm test
npm run format
```

Adding or upgrading a dependency is the only time to use `npm install`, and then always as `npm install --ignore-scripts <package>@<version>`. Check the `package-lock.json` diff before committing it; everyone else installs exactly what it pins with `npm ci --ignore-scripts`.

**Adding another agent provider**: providers implement `AgentProvider` (`server/agents/types.ts`): take an `AgentTurn` (working directory, prompt, system prompt, session, model/effort, allowed tools, MCP servers, abort signal) and yield `AgentEvent`s (text deltas, tool starts/ends, done). `server/agents/codex.ts` and `server/agents/claudeCode.ts` are the implementations; register a new one in `server/index.ts`. Because the tools are an MCP server, any MCP-capable agent can use them.

## The `storyboard` command

`./storyboard` is a small bash script: it checks Node.js, runs `npm ci --ignore-scripts` on a fresh clone and hands over to `server/cli/main.ts`. The commands live in `server/cli/`: `setup.ts` (the questions and installs), `services.ts` (start, stop, status and logs, through PID files in `.storyboard/run`), `music.ts` and `sfx.ts` (the engines), `uv.ts` (a pinned uv, checked against its SHA-256), and `ui.ts` / `prompt.ts` (how it looks). Everything it installs stays in the app folder.
