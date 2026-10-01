# Music and sound effects

Both are optional and run on your own machine, as background engines next to Storyboard. They need a Mac with Apple silicon, or Linux (the music engine really wants an NVIDIA GPU there).

**Music generation** lets the agent compose soundtracks with [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5), an open music model (MIT-licensed; its authors state the generated music can be used commercially). It downloads about 10 GB of models, plus an 8 GB planning model on machines with lots of memory, and uses 9–16 GB of memory while it runs. While it's running, the Project chat gets the music tools (`generate_music`, `wait_for_music`, `list_music_takes`, `describe_music_take`, `use_music_take`, `repaint_music`). The agent can't hear audio, so every take comes back measured (tempo, bar grid, sections, strongest hits, loudness, how its bars line up with the cuts) plus a spectrogram image. All takes are kept in `projects/<id>/music/`, and switching the soundtrack is undoable.

**Sound-effects generation** lets the agent make realistic sounds the synth can't (a mechanical keyboard, paper, footsteps, a crowd) with [Stable Audio Open 1.0](https://huggingface.co/stabilityai/stable-audio-open-1.0). The model is about 5 GB and is gated on Hugging Face under the Stability AI Community License (free, including commercial use, for individuals and organizations under $1M in annual revenue; read it for the details). Setup guides you through it: it opens the pages to sign in (or create a free account), accept the license and create a Read token, then checks that the token has access before it downloads the model. The token is used for that download only and isn't saved. While the engine runs, both chats get `generate_sound`: each request makes 1–4 variations, which are trimmed, levelled, measured and kept in `projects/<id>/sounds/generated/`.

When an engine isn't running, the agent doesn't see its tools. If you turned it off in setup, the agent won't suggest it; if it's just stopped, the agent asks you to run `./storyboard start music` (or `sfx`).

Turn either one on or off with `./storyboard setup`; turning one off offers to remove its files. `./storyboard start` starts the engines you turned on, `./storyboard start music` (or `sfx`) starts one on its own, and `./storyboard status` shows what they're doing and how much memory they use.

## Running an engine on another machine

Run the engine there and point Storyboard at it with `STORYBOARD_MUSIC_URL` / `STORYBOARD_SFX_URL` and the matching API key (see [Configuration](configuration.md)). `./storyboard` then only reports its status. For ACE-Step: `ACESTEP_API_KEY=<key> uv run acestep-api --host 0.0.0.0 --port 8001` in its folder.
