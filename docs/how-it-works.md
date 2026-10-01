# How it works

```
Editor (React, Vite)  ── SSE ──┐
Scene frames (iframes) ─ HMR ──┤
                               │
Node server ── Vite (dev) ─────┤  /api  REST           server/api.ts
            ├─ ProjectStore     │  /mcp  MCP tools      server/mcp.ts
            ├─ Capturer (headless Chromium: frames, seams)      server/capture.ts
            ├─ Renderer (parallel pages → ffmpeg H.264 + mixed audio) server/render.ts
            ├─ Music analysis (beats, bars, phrases, sections)  server/music/
            ├─ Sound effects (library, synth, mixer, check_audio) server/sound/
            └─ ChatManager → AgentProvider (Codex or Claude Code) server/chat.ts, server/agents/
```

- **Scenes** (`projects/<id>/scenes/*.tsx`) import helpers from `storyboard` (`src/runtime/`): `progress`, `interpolate`, `keyframes`, `spring`, easings, colors, seeded `random`/`noise`, `SplitText`, and the `music` beat grid. Every frame is a pure function of `t`, so scrubbing, rendering and seam checks are exact.
- **`frame.html`** (`src/frame/main.tsx`) loads a project's scenes and renders any time on demand. The editor preview, the thumbnails, the agent's `render_frames` and the MP4 renderer all use this same page, so what you see is what renders. It also evaluates each scene's `sounds` export into cues in video time, which the preview, `check_audio` and the renderer mix the same way (`server/sound/mix.ts`, `src/editor/audio.ts`).
- **Codex** is the default agent, run per turn through `codex exec --json` with isolated configuration, a read-only sandbox and no shell. It reads and writes source through scoped MCP tools; a scene chat can only write its own scene, while a project chat can also write shared components and art direction. Each chat keeps its own Codex thread.
- **Claude Code**, selected with `STORYBOARD_AGENT=claude-code`, is your local Claude Code, run per turn as `claude -p --output-format stream-json --restricted --permission-mode dontAsk --allowedTools …` with the Storyboard MCP server attached. A scene chat can only edit that scene's file (enforced by Claude Code permission rules and by the MCP server). Each chat keeps its own Claude Code session; **Clear chat** starts a fresh one.
- **Undo**: before each turn the project's code is snapshotted to `.storyboard/undo/`; Undo restores the files that turn changed.

## Security

Storyboard is a single-user local tool. It listens on `127.0.0.1` only; `/api` and `/mcp` refuse requests with a non-local `Host` (DNS rebinding) and browser requests from other websites or other local ports (CSRF), since those could start agent turns. Don't expose it to a network. The in-app agent runs your selected provider with scoped tools, can only write inside the project it's working on, and a scene chat only that scene's file.
