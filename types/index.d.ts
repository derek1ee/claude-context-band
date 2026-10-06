/** One /context category, as the band keeps it between redraws. */
export type CtxRow = {
  name: string
  /** Theme key /context paints the category in (`promptBorder`, `inactive`, ...). */
  color: string
  tokens: number
  kind: 'used' | 'free' | 'buffer'
}

/** The window the squares divide, and what fills it. */
export type Ctx = {
  window: number
  rows: CtxRow[]
}

export type CacheTtl = '5m' | '1h'

/** When the main thread's prompt cache was last touched, and for how long it lives. */
export type CacheInfo = {
  /** ms since epoch of the last main-loop request (or response, after a resume). */
  touchedAt: number
  /** null until a response in the transcript shows which bucket it wrote to. */
  ttl: CacheTtl | null
}

declare module 'claude-code' {
  interface PluginState {
    'context-band': {
      ctx: Ctx | null
      cache: CacheInfo | null
      now: number
      /** Estimated tokens of what is typed in the prompt box, not yet sent. */
      draft: number
      /** Auto-refreshes spent since the person last sent a prompt. */
      refreshes: number
      /** A keep-alive fork is in flight. */
      isRefreshing: boolean
      /** This session's auto-refresh count, over the default; null follows the default. */
      sessionLimit: number | null
    }
  }
}
