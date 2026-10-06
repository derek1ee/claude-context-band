# context-band

A Claude Code plugin that draws one full-width row of squares above the prompt, showing context-window use by category, plus a prompt-cache countdown on the right.

```
⛁ ⛁ ⛁ ⛁ ⛀ ⛁ ⛁ ⛁ ⛁ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛝ ⛝ ⛝ ⛝   cache 1h 52:13 ↻ (3)
```

## Install

At a Claude Code terminal prompt:

```
/plugin install context-band --marketplace derek1ee/claude-context-band
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). The band appears above the prompt right away, with no restart. Sessions that were already open pick it up after `/reload-plugins`.

### From a shell

For setup scripts, dotfiles or a new machine. The shell's `install` has no `--marketplace` flag, so the marketplace is added first:

```sh
claude plugin marketplace add derek1ee/claude-context-band
claude plugin install context-band@claude-context-band   # user scope by default; -s project|local for others
```

To update later: `claude plugin update context-band`, then `/reload-plugins` in open sessions.

**Requirements:** a Claude Code build with the function-hooks API; built and tested on 2.1.290. That API is early access and may change between releases, so another version may not load it or a future update may break it. Please open an issue if it does.

## What it shows

Squares, glyphs and colours follow `/context` exactly, with as many squares as fit the width:

- Each category gets round(its share × N) squares, at least one. Its last square is `⛀` when under 70% full, otherwise `⛁`.
- Colours: system prompt light grey, system tools grey, MCP tools cyan, custom agents blue, memory files orange, skills yellow, messages purple.
- `⛶` dim is free space, and `⛝` is the autocompact buffer at the right end.
- `⛶` in the messages colour is what's typed in the prompt box but not sent yet (≈ 4 chars/token).
- Hover any square (fullscreen or desktop) for a one-line tooltip on the band's own row, starting on the next square if it fits before the last square, else ending on the previous one, so it never covers the cache label: category, tokens and % of the window (`Custom agents · 212 tokens · <0.1% of 1.0M`). Hover the cache label for the TTL and the last-request and expiry times, and the `↻ (n)` button for auto-refresh status.
- `/context-band` prints the same legend in any terminal; `/context-band refresh` and `/context-band auto-refresh <n>` are under Keeping the cache warm.

## Cache countdown

- **Expiry** = start of the last main-thread API request + TTL. A request that reads the cache restarts its timer, and the timer runs from when the request starts. Subagent requests don't count.
- **TTL** comes from the transcript: each response's `usage.cache_creation` splits written tokens into `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens`. If you pin the TTL yourself (`FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, or `"promptCacheTtl"` in settings), the label shows it from the first request. Otherwise it's hidden until a response shows which TTL applies, rather than guessed. Claude Code's automatic TTL is 1h on a Claude subscription within its usage limits and 5m on an API key, Bedrock, Vertex or Foundry. A drop to 5m mid-session (going past usage limits) is picked up at the end of that turn.
- Green `cache 1h 52:13` while warm, yellow in the last 20%, then red `cache expired 36m ago` (rough: `<1m`, minutes, hours, days). A 1h cache also flashes through its last five minutes.

## Keeping the cache warm

The `↻ (n)` button beside the countdown refreshes the cache now. Click it (fullscreen terminal or desktop), or focus the band with ctrl+x tab and press Enter. `/context-band refresh` does the same from the prompt. The button shows only while the cache is still warm. `n` is how many auto-refreshes are left: `↻ (0)` means auto-refresh is off or used up, and the button still refreshes by hand.

Hovering the button shows where auto-refresh stands, for example `Refresh cache now · auto-refresh: 2 of 3 left, next in 52m`.

A refresh re-sends the main conversation's last request with one extra line ("Reply with only: OK"), the way Claude Code itself does for side questions. The API serves the whole conversation from the cache, which restarts its timer. Nothing is added to your conversation, and a toast says how many tokens were read from the cache.

A refresh costs one cache read of the context (0.1× the input price on most models, 0.05× on Opus 5.5) plus a few output tokens. On a subscription it counts toward your usage limits. If the cache lapses instead, your next prompt writes it again at 1.25× (5m) or 2× (1h).

**Auto-refresh** is off by default. Turn it on with a count:

```
/context-band auto-refresh 3    # refresh up to 3 times while idle
/context-band auto-refresh 0    # off
```

While the session is idle, it refreshes just before expiry (2 minutes early for 1h, 30 seconds for 5m), up to that many times. The count starts over each time you send a prompt, so a session you've walked away from stops after `n` refreshes. With 1h that's about `n` more hours warm; with 5m, about `5 × n` minutes. The same setting appears as "Cache auto-refresh" in `/config`, and `/context-band auto-refresh` with no number shows the current value. Each auto-refresh shows a toast like `Cache auto-refreshed (1 of 3): 236k tokens read from the cache.`

## Surfaces and platforms

- The band shows on the terminal CLI and the desktop app's Code tab. VS Code and mobile don't draw the above-prompt band.
- Hover tooltips need a surface that reports the mouse: the fullscreen terminal or the desktop app. Elsewhere, run `/context-band`.
- On macOS and Linux the transcript's tail is read with `tail`. On Windows the whole transcript is read instead, which works up to 4 MiB; past that the TTL can't be read and the cache label stays hidden.

## Privacy

The plugin reads Claude Code's own context breakdown (local estimates, no extra API calls), the length of what's typed in the prompt box (for the draft squares; the text itself isn't kept), and the tail of the current session's transcript under `~/.claude/projects/` (for each response's cache usage and time). It makes no network requests of its own and has no telemetry.

The one exception is a cache refresh, whether you trigger it with `↻ (n)`, with `/context-band refresh`, or through auto-refresh if you turn that on. A refresh sends one model request through Claude Code's own client. That request re-sends your current conversation, just as Claude Code does on every turn.

## Develop

```sh
git clone https://github.com/derek1ee/claude-context-band
claude --plugin-dir ./claude-context-band   # load from the working copy
claude plugin validate ./claude-context-band
claude plugin test ./claude-context-band
```

## License

MIT
