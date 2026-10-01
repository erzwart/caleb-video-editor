# Storyboard

https://github.com/user-attachments/assets/1f0c6565-9a78-4d8f-a8ba-1e75a212e519

A local, prompt-driven motion-design editor. Every scene is a small piece of code; you change it by chatting with Codex (or Claude Code) next to a live preview, down to the millisecond. Finished videos export to MP4.

Inspired by [Caleb Porzio's tweet](https://x.com/calebporzio/status/2104945478055989489) about the editor he vibe-coded for his video.

![The Storyboard editor: a live preview, the scene chat, and the filmstrip](docs/screenshot.png)

- **Chat per scene, or about the whole video**, next to a live preview.
- **Music that drives the edit**: beats, bars and phrases are detected, and cuts snap to them.
- **Sound effects** placed on the same timing as the animation.
- **Optional**: the agent composes the soundtrack and generates realistic sound effects, on your own machine.

## Get started

You need macOS or Linux and [Node.js](https://nodejs.org) 22.12 or newer.

```bash
git clone https://github.com/saeedvaziry/caleb-video-editor.git
cd caleb-video-editor
./storyboard setup
./storyboard start
```

![./storyboard setup in a terminal: it checks the basics, asks about music and sound-effect generation, installs everything with progress bars, then starts Storyboard](docs/setup.gif)

Setup walks you through the rest (ffmpeg, your Codex login, and whether you want music and sound-effect generation) and installs everything inside this folder. Run it again any time to change your choices. It installs packages with `npm ci --ignore-scripts`, so no package's install script ever runs: don't use `npm install` here.

## Codex agent

Codex is the default in-app agent. Install [Codex CLI](https://developers.openai.com/codex/cli) 0.159 or newer separately, then log in:

```bash
codex login
./storyboard doctor
./storyboard start
```

Storyboard uses the CLI's login and default model. Set `STORYBOARD_MODEL` to choose another Codex model. The in-app agent runs with a read-only sandbox and no shell; it edits through scoped Storyboard MCP tools. Scene chats can only write their own scene. Chat history, frame checks, sound tools, undo and stopping a turn work with both providers.

To use Claude Code instead, set `STORYBOARD_AGENT=claude-code` for setup and start:

```bash
STORYBOARD_AGENT=claude-code ./storyboard setup
STORYBOARD_AGENT=claude-code ./storyboard start
```

Provider selection is an environment setting; it is not saved by setup. When changing providers, start the app with the new setting. If it is already running, stop it yourself first. Existing sessions from the other provider start fresh on the next message; visible chat history remains.

## Commands

| | |
| --- | --- |
| `./storyboard setup` | Install, or change what's installed |
| `./storyboard start` | Start Storyboard in the background |
| `./storyboard stop` | Stop it |
| `./storyboard status` | See what's running |
| `./storyboard logs` | Show the log |
| `./storyboard doctor` | Check that everything is in place |

## More

- [Using Storyboard](docs/using-storyboard.md): the editor, sound effects, and the tools from your terminal
- [Music and sound effects](docs/music-and-sound.md): the optional engines
- [Configuration](docs/configuration.md) · [Troubleshooting](docs/troubleshooting.md)
- [How it works](docs/how-it-works.md) · [Developing Storyboard](docs/development.md)

## License

[MIT](LICENSE) © 2026 Saeed Vaziry. The optional music engine, ACE-Step 1.5, has its own MIT license; the optional sound model, Stable Audio Open 1.0, is downloaded from Hugging Face under the Stability AI Community License.
