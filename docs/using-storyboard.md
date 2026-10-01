# Using Storyboard

## The editor

| Where | What |
| --- | --- |
| Filmstrip | Click a scene to open it; drag to reorder; **+ Add scene**. Badges between scenes show how many pixels change at each cut (0% = invisible). |
| Stage | **This scene** (loops) or **Whole video**. Space = play/pause, ←/→ = one frame (Shift: 1 s), ↑/↓ = previous/next scene. Beat ticks and phrase marks appear on the scrubber when there is music; pink dots under it are sound cues (hover to see which). |
| Scene tab | Chat about the selected scene; the agent may only edit that scene's file and duration. Double-click the name to rename; click the duration to type a new one. **Undo** reverts the agent's last change. |
| Project tab | The project chat and **Check seams**. |
| Rail | The icons at the right edge switch the right column between **Chat** (the Scene and Project tabs), **Soundtrack** and **Sound effects**. A spinner on Chat means the agent is working; a dot means it replied while another panel was open. |
| Soundtrack | Drop an audio file anywhere, set where the video starts in the track, snap cuts to beats/bars/phrases. |
| Sound effects | The project's sounds with play buttons, how often each is cued, and any cue problems. Drop audio files on it (or on its rail icon) to add your own. |
| Art direction | Palette, type scale, motion rules — the agent reads it before every edit. |
| Copy path | Copies the scene file path (or project folder) for your editor or terminal. |
| Render | Export an MP4 to `projects/<id>/renders/`. |

The selectors next to **Send** choose the model (the Codex CLI default, or the model configured through `STORYBOARD_MODEL`; Claude choices appear when using Claude Code) and the effort — how much the agent thinks. Your playhead position is sent with each message, so "make this part slower" refers to what you're looking at.

## Sound effects

Ask for sound ("add sound effects", "make the typing audible", "a big hit on the logo") and the agent designs it in the Project chat, or for one scene in its scene chat. A scene plays sounds by exporting cues next to its component, computed from the same values as its animation:

```tsx
export const sounds: SceneSounds = ({ music }) => [
  ...IP.split('').map((_, i) => ({ at: TYPE_AT + i * KEY, sound: 'key', pitch: (i % 3) - 1 })),
  { at: ENTER_AT, sound: 'enter' },
  { at: music.bar(1), sound: 'whoosh', align: 'peak' }, // the whoosh's loudest moment lands on the bar
];
```

Because cues live in the scene, they move with the animation, the cuts and the scene order, and Undo covers them. The sounds come from the project's library in `projects/<id>/sounds/`:

- **Synth** (always available): 22 motion-design presets (click, tap, tick, toggle, keystroke, enter, pop, blip, ping, ding, chime, error, whoosh, swish, riser, reverse, impact, thud, sub-drop, glitch, sparkle, shutter), each tuned by the agent (pitch, length, brightness, weight, tail, stereo motion). They're made instantly on your machine, identical every time, and yours to use anywhere.
- **Generated** (optional): with sound-effects generation turned on, the agent makes any sound from a text prompt, including realistic foley (see [Music and sound effects](music-and-sound.md)).
- **Your files**: drop audio files on the **Sound effects** icon in the rail, or copy them into `sounds/`. A file is used by its name without the extension (`sounds/Camera Click.wav` → `"Camera Click"`).

The agent can't hear, so its `check_audio` tool mixes the soundtrack and every cue exactly as the render does and measures each cue against everything else playing at that moment (clear / audible / faint / masked), plus clipping and broken cues. The preview plays the same mix on one audio clock; renders add a −1 dBFS limiter and the usual fade at the end.

## Using the tools from your terminal

While Storyboard is running (`./storyboard start`):

```bash
codex mcp add storyboard --url http://127.0.0.1:5199/mcp
cd projects/<project-id>
codex -c 'project_doc_fallback_filenames=["CLAUDE.md"]'
```

`projects/CLAUDE.md` (written by the app) provides the scene contract and the runtime API, and the `storyboard` MCP tools (`render_frames`, `check_seams`, `get_music_context`, `set_scene_duration`, `create_scene`, …) let it see and verify its work. The editor reloads live as files change.
