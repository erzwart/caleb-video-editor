# Configuration

Set these when starting, e.g. `PORT=5299 ./storyboard start`.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `5199` | |
| `STORYBOARD_PROJECTS` | `./projects` | Where projects live |
| `STORYBOARD_AGENT` | `codex` | Agent provider (`codex` or `claude-code`); set for both setup and start |
| `STORYBOARD_MODEL` | Codex CLI default (Claude: `claude-opus-5-5`) | Model the in-app agent uses |
| `STORYBOARD_EFFORT` | `medium` | Default effort (the UI remembers your choice) |
| `CODEX_PATH` / `CLAUDE_PATH` / `FFMPEG_PATH` | `codex` / `claude` / `ffmpeg` | Binaries |
| `STORYBOARD_USE_API_KEY` | unset | By default `OPENAI_API_KEY` and `CODEX_API_KEY` (Codex) or `ANTHROPIC_API_KEY` (Claude) are removed from the agent environment; set this to keep them. The CLI uses its existing login, which may itself be an API-key login. |
| `STORYBOARD_AGENT_LOG` | unset | Path of a file to append the agent's raw stream-json to (debugging) |
| `STORYBOARD_MUSIC_URL` / `STORYBOARD_SFX_URL` | `http://127.0.0.1:8001` / `:8002` | Where the engines answer. Point one at another machine to run the engine there |
| `STORYBOARD_MUSIC_API_KEY` / `STORYBOARD_SFX_API_KEY` | a random key in `.storyboard/keys/` | The engines' API keys (set them when an engine runs elsewhere) |

## Where things live

Everything Storyboard installs stays in its folder, so deleting the folder removes all of it (after `./storyboard stop`). The only things setup puts elsewhere are system tools you agree to install (such as ffmpeg with Homebrew).

```
storyboard              the command-line tool
projects/               your projects (git ignores all but the example); set STORYBOARD_PROJECTS to keep them elsewhere
engines/music/          the music engine, if turned on: ACE-Step 1.5, its Python environment and models
engines/sfx/            the sound-effects engine; setup adds its Python environment (.venv) and model (models/)
.storyboard/            settings.json (your setup choices), uv and its Python, headless Chromium, logs, engine keys
```

Each project:

```
projects/<id>/
  project.json          name, canvas, fps, scene order + durations, soundtrack reference
  scenes/<scene>.tsx    one component per scene
  components/           optional shared components
  assets/               images and SVGs (asset('file.png'))
  art-direction.md      the look every scene follows
  music/                soundtrack takes (takes.json) with cached beat analysis
  sounds/               sound effects: your audio files, sounds.json (synth recipes and generated sounds), generated/
  renders/              exported MP4s
  .storyboard/          chats, undo snapshots, frames the agent looked at (internal)
```
