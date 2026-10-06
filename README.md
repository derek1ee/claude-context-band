# context-band

A Claude Code plugin that draws one full-width row of squares above the prompt, showing context-window use by category, plus a prompt-cache countdown on the right.

```
⛁ ⛁ ⛁ ⛁ ⛀ ⛁ ⛁ ⛁ ⛁ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛝ ⛝ ⛝ ⛝   cache 1h 52:13
```

## Install

At a Claude Code terminal prompt:

```
/plugin install context-band --marketplace derek1ee/claude-context-band
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). The band appears above the prompt right away, with no restart.

**Requirements:** a Claude Code build with the function-hooks API; built and tested on 2.1.290. That API is early access and may change between releases, so another version may not load it or a future update may break it. Please open an issue if it does.

## What it shows

Squares, glyphs and colours follow `/context` exactly, with as many squares as fit the width:

- Each category gets round(its share × N) squares, at least one. Its last square is `⛀` when under 70% full, otherwise `⛁`.
- Colours: system prompt light grey, system tools grey, MCP tools cyan, custom agents blue, memory files orange, skills yellow, messages purple.
- `⛶` dim is free space, and `⛝` is the autocompact buffer at the right end.
- `⛶` in the messages colour is what's typed in the prompt box but not sent yet (≈ 4 chars/token).
- Hover any square (fullscreen or desktop) for a one-line tooltip on the band's own row, starting on the next square if it fits before the last square, else ending on the previous one, so it never covers the cache label: category, tokens and % of the window (`Custom agents · 212 tokens · <0.1% of 1.0M`). Hover the cache label for the TTL and the last-request and expiry times.
- `/context-band` prints the same legend in any terminal.

## Cache countdown

- **Expiry** = time of the last main-thread API request + TTL. Each request that reads the cache resets the clock. Subagent requests don't count.
- **TTL** comes from the transcript: each response's `usage.cache_creation` splits written tokens into `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens`. Until a response has written to the cache, the label is hidden rather than guessed.
- Green `cache 1h 52:13` while warm, yellow in the last 20%, then red `cache expired 36m ago` (rough: `<1m`, minutes, hours, days).

## Surfaces and platforms

- The band shows on the terminal CLI and the desktop app's Code tab. VS Code and mobile don't draw the above-prompt band.
- Hover tooltips need a surface that reports the mouse: the fullscreen terminal or the desktop app. Elsewhere, run `/context-band`.
- On macOS and Linux the transcript's tail is read with `tail`. On Windows the whole transcript is read instead, which works up to 4 MiB; past that the TTL can't be read and the cache label stays hidden.

## Privacy

Everything stays on your machine. The plugin reads Claude Code's own context breakdown (local estimates, no extra API calls) and the tail of the current session's transcript under `~/.claude/projects/` to learn the cache TTL. It sends nothing anywhere and makes no network requests.

## Develop

```sh
git clone https://github.com/derek1ee/claude-context-band
claude --plugin-dir ./claude-context-band   # load from the working copy
claude plugin validate ./claude-context-band
claude plugin test ./claude-context-band
```

## License

MIT
