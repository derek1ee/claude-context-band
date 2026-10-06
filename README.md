# context-band

A Claude Code mod: one full-width row of squares above the prompt showing context-window use by category, plus a prompt-cache countdown on the right.

```
⛁ ⛁ ⛁ ⛁ ⛁ ⛀ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝   cache 1h 52:13
```

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

## Surfaces

The band shows on the terminal CLI and the desktop app's Code tab. VS Code and mobile don't draw the above-prompt band.

## Develop

```sh
claude --plugin-dir /path/to/context-band
claude plugin validate .
claude plugin test .
```
