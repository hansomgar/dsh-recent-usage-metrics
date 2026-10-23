/**
 * Client half of dsh-recent-usage-metrics.
 *
 * Two contributions, both fed by data the Chat layer already maintains:
 *
 * 1. `settings.general.item` — the shipped "Performance & usage" row, re-registered
 *    into its own cell with `priority: -1` so this renderer wins over the shipped
 *    `priority: 0` one, and with the shipped `order: 30` so it keeps its place in
 *    the General page (the outlet sorts by `order`; only the cell election reads
 *    `priority`). It offers the third level, Geek. The shipped Chat schema accepts
 *    only `compact` / `detailed`, so Geek is this plugin's own durable flag while
 *    the two shipped levels keep writing through `ctx.configForms` exactly as the
 *    native row does.
 *
 * 2. `conversation.composer.dock` — in Geek mode, the compact reading of the newest
 *    request at the left of the composer status row, and the glass drawer listing
 *    the last ten requests. Every figure is derived from a settled assistant step:
 *    `timing.stepStartTime` → `timing.firstTokenTime` → `timing.completedTime`,
 *    plus the provider `usage.outputTokens` when the provider reported it.
 *
 * Everything that outlives a render is created inside `ctx.effect`, so disabling
 * the plugin restores the shipped row and removes every listener.
 */
window.__ModuleLoader__.load({
  id: 'dsh-recent-usage-metrics',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

    /**
     * The composer dock sits inside the conversation's own scroll and stacking
     * context, so the drawer and the row's menu are rendered through a portal on
     * `document.body` — the same escape hatch the shipped statistics dialog uses —
     * and fall back to inline rendering if `react-dom` is unavailable.
     */
    const createPortal = (() => {
      try {
        const reactDom = require('react-dom')
        return typeof reactDom?.createPortal === 'function' ? reactDom.createPortal : null
      } catch {
        return null
      }
    })()

    const portal = (node) => (createPortal === null ? node : createPortal(node, document.body))

    /** Locale namespace; also the Loader entry id in cordis.patch.yml. */
    const NS = 'dsh-recent-usage-metrics'
    const STYLE_ID = 'dsh-recent-usage-metrics-style'
    /** Durable Geek flag. The shipped preference keeps its own two values. */
    const MODE_KEY = 'dsh.recentUsageMetrics.mode.v1'
    /** Durable history, newest first, at most MAX_ROWS entries. */
    const HISTORY_KEY = 'dsh.recentUsageMetrics.history.v1'
    const MAX_ROWS = 10
    /** Shipped Chat settings namespace and field the two native levels persist through. */
    const CHAT_NS = 'ui-chat'
    const CHAT_FIELD = 'performanceUsage'
    /** The third level. */
    const GEEK = 'geek'
    /** The shipped row cell this plugin replaces. */
    const NATIVE_ROW_ID = 'performance-usage'
    /**
     * Key holding the locale dictionaries' disposer on `globalThis`.
     *
     * The locale service keeps one occupant per (namespace, language) and throws on a
     * duplicate; an HMR pass re-executes this module while the previous generation's
     * claim can still be live, so the claim is released through this global first.
     */
    const DISPOSER_KEY = '__dshRecentUsageMetricsLocale'

    const zh = {
      settingsTitle: '性能与用量',
      settingsDescription: '选择性能与用量信息展示的详细程度',
      optionCompact: '简洁',
      optionDetailed: '详细',
      optionGeek: '极客',
      geekHint:
        '极客档在输入区状态行实时显示最新一次请求的首字时间、生成速度与 Token，点击可展开最近 10 次请求。',
      statusAria: '请求指标，点击查看最近 10 次请求',
      statusHint: '首字 {ttft} · 速度 {speed} · 输出 {tokens} · 总用时 {total} · 折算 {amortized}',
      seconds: '{value} s',
      speedUnit: '{value} tok/s',
      tokensUnit: '{value} tok',
      approxSpeedUnit: '~{value} tok/s',
      approxTokensUnit: '~{value} tok',
      none: '—',
      drawerTitle: '最近请求指标',
      drawerCount: '最近 {count} 条',
      drawerEmpty: '还没有完成的请求。发一条消息后，它的指标会出现在这里。',
      drawerLive: '生成中',
      colIndex: '#',
      colTime: '时间',
      colTtft: '首字',
      colSpeed: '速度',
      colTokens: '输出 Token',
      colTotal: '总用时',
      colAmortized: '折算速度',
      averageOf: '平均 {count} 条',
      justNow: '刚刚',
      secondsAgo: '{count} 秒前',
      minutesAgo: '{count} 分钟前',
      hoursAgo: '{count} 小时前',
    }

    const en = {
      settingsTitle: 'Performance & usage',
      settingsDescription: 'Choose how much performance and usage information to show',
      optionCompact: 'Compact',
      optionDetailed: 'Detailed',
      optionGeek: 'Geek',
      geekHint:
        'Geek keeps a live reading of the newest request in the composer status row — first token, generation speed and tokens — and opens the last ten requests on click.',
      statusAria: 'Request metrics; open the last ten requests',
      statusHint: 'First token {ttft} · speed {speed} · output {tokens} · total {total} · amortised {amortized}',
      seconds: '{value} s',
      speedUnit: '{value} tok/s',
      tokensUnit: '{value} tok',
      approxSpeedUnit: '~{value} tok/s',
      approxTokensUnit: '~{value} tok',
      none: '—',
      drawerTitle: 'Recent request metrics',
      drawerCount: 'Last {count}',
      drawerEmpty: 'No completed requests yet. Send a message and its metrics appear here.',
      drawerLive: 'Streaming',
      colIndex: '#',
      colTime: 'At',
      /*
       * Headers are kept to 4-5 characters because each column is only as wide as the
       * pill's digits plus the unit beside them (about 38px at the 11px header size).
       * Widening a column to fit a longer word would break the alignment with the status
       * row, and wrapping looked ragged next to the single-line headers.
       *
       * The clock reading is `At` ("when it ran") and the elapsed span is `Time`, so the
       * two are never confused. `TTFT` and `Tokens` are the terms this audience already
       * reads; `Speed` and `Amortised` fit as they are.
       */
      colTtft: 'TTFT',
      colSpeed: 'Speed',
      colTokens: 'Tokens',
      colTotal: 'Time',
      colAmortized: 'Amortised',
      averageOf: 'avg of {count}',
      justNow: 'just now',
      secondsAgo: '{count}s ago',
      minutesAgo: '{count}m ago',
      hoursAgo: '{count}h ago',
    }

    const STYLE_TEXT = `
/*
 * The status reading reproduces the shipped statistics pill: one
 * --dsw-alias-label-tertiary foreground for the text AND the icon (the native pills
 * inherit currentColor and never tint their glyph), the same 12px-equivalent type,
 * and a box sized by padding + line-height rather than a fixed height.
 */
.dsh-rum-anchor {
  min-width: 0;
  display: inline-flex;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dsh-rum-trigger {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: 0 0;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-rum-trigger svg {
  flex: none;
  width: 14px;
  height: 14px;
}
.dsh-rum-trigger:hover,
.dsh-rum-trigger[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
}
.dsh-rum-live .dsh-rum-bolt {
  animation: dsh-rum-pulse 1.4s ease-in-out infinite;
}
@keyframes dsh-rum-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}
/*
 * The status pill reserves each figure's digits with a FIXED width on the NUMBER
 * element only — never on the cell, which also holds the unit and would otherwise
 * clip it. Nothing reflows while a response streams: a value growing from "3.1" to
 * "57.8", a speed dropping from "328" to "9", the "--" placeholder, and the estimate
 * marker appearing or disappearing all leave the pill's width unchanged.
 *
 * These classes are the pill's own (dsh-rum-part); the drawer uses its own
 * dsh-rum-row / dsh-rum-col names so neither rule set can clip the other.
 */
.dsh-rum-parts {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.dsh-rum-part {
  display: inline-flex;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsh-rum-tilde {
  /* Reserved unconditionally; only its paint toggles, so it can never reflow. */
  flex: none;
  display: inline-block;
  width: 1ch;
  text-align: center;
  visibility: hidden;
}
.dsh-rum-tilde[data-on="true"] {
  visibility: visible;
}
.dsh-rum-num {
  flex: none;
  display: inline-block;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.dsh-rum-unit {
  flex: none;
  white-space: pre;
}
/*
 * Digit budgets, measured from a 433-reading session log: durations p50 "3.1" /
 * p99 "57.8" (whole seconds from 100 up), speed p50 85 / max 328, tokens p50 219 /
 * max 28948.
 */
.dsh-rum-part[data-metric="ttft"] .dsh-rum-num,
.dsh-rum-part[data-metric="total"] .dsh-rum-num {
  width: 4.5ch;
}
.dsh-rum-part[data-metric="speed"] .dsh-rum-num,
.dsh-rum-part[data-metric="amortized"] .dsh-rum-num {
  width: 4.5ch;
}
.dsh-rum-part[data-metric="tokens"] .dsh-rum-num {
  width: 5.5ch;
}

/*
 * The drawer adopts the shipped statistics dialog's material verbatim — the same
 * --dsw-specific-menu fill (which is #303136f0 in dark mode, i.e. nearly opaque,
 * not a translucent white), the same 40px/150% menu backdrop blur, the same
 * elevation stroke + shadow, and the same 16px padding and 16px radius. Only the
 * placement and the open/close transition are this plugin's own.
 */
.dsh-rum-drawer {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  /*
   * Width follows the grid, with a floor so the columner's own labels ("输出 Token")
   * are not truncated. Any width beyond the columns is pushed to the LEFT by the rows'
   * justify-content: end, which keeps the last column flush with the edge the pill's
   * figures align to.
   */
  width: max-content;
  min-width: min(420px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
  padding: 16px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: default;
  overflow: hidden;
  opacity: 0;
  /* Positioned by the right edge, so the slide-up transition must not shift X. */
  transform: translateY(14px) scale(.985);
  transform-origin: bottom right;
  transition:
    opacity 160ms ease,
    transform 200ms cubic-bezier(.2, .8, .2, 1);
}
.dsh-rum-drawer[data-open="true"] {
  opacity: 1;
  transform: translateY(0) scale(1);
}
@media (prefers-reduced-motion: reduce) {
  .dsh-rum-drawer { transition: none; }
}
.dsh-rum-head {
  display: flex;
  flex: none;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dsh-rum-head-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-rum-head-title svg {
  flex: none;
  width: 14px;
  height: 14px;
}
.dsh-rum-head-count {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}
.dsh-rum-rule {
  flex: none;
  margin-bottom: 10px;
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.dsh-rum-list {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.dsh-rum-row {
  display: grid;
  /*
   * The five metric columns take the pill's MEASURED pixel widths from the custom
   * properties the drawer root publishes, so each column sits exactly under its metric.
   * The ch values are only a fallback for the frame before measurement lands (and for
   * a detached tree); they approximate the same budgets.
   */
  grid-template-columns:
    18px
    56px
    var(--dsh-rum-col-ttft, calc(4.5ch + 2ch))
    var(--dsh-rum-col-speed, calc(4.5ch + 6ch))
    var(--dsh-rum-col-tokens, calc(5.5ch + 4ch))
    var(--dsh-rum-col-total, calc(4.5ch + 2ch))
    var(--dsh-rum-col-amortized, calc(4.5ch + 6ch));
  align-items: center;
  /*
   * Right-align the column group inside the row. When the drawer's min-width leaves
   * spare space, it lands on the LEFT, so the last column stays flush with the edge the
   * pill's figures align to. Without this the spare space would sit on the right and
   * reintroduce the misalignment.
   */
  justify-content: end;
  gap: 10px;
  padding: 4px 6px;
  border-radius: var(--dsw-radius-sm);
  font-variant-numeric: tabular-nums;
}
.dsh-rum-row + .dsh-rum-row {
  margin-top: 1px;
}
.dsh-rum-row[data-head="true"] {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-bottom: 5px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  letter-spacing: .01em;
  /*
   * The sticky header must occlude the rows scrolling under it, so it repeats the
   * drawer's own menu surface instead of a translucent layer token.
   */
  background: var(--dsw-specific-menu);
}
.dsh-rum-row[data-head="true"] .dsh-rum-col {
  text-align: right;
}
.dsh-rum-row[data-head="true"] .dsh-rum-col[data-align="start"] {
  text-align: left;
}
/*
 * Drawer cells: right-aligned numbers that may ellipsize. Scoped to dsh-rum-col so it
 * never reaches the status pill's dsh-rum-part cells.
 */
.dsh-rum-col {
  min-width: 0;
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-rum-col[data-align="start"] {
  text-align: left;
}
.dsh-rum-index,
.dsh-rum-clock {
  color: var(--dsw-alias-label-tertiary);
  text-align: left;
}
.dsh-rum-primary {
  color: var(--dsw-alias-label-primary);
}
/*
 * Only an insertion animates. The evicted row is removed in the same frame as the new
 * one arrives, so the list never holds an eleventh row and the drawer's height stays
 * constant. The entry motion is a gentle fade plus slide, short enough not to lag a
 * burst of completions.
 */
.dsh-rum-item[data-phase="enter"] {
  animation: dsh-rum-in 240ms cubic-bezier(.2, .8, .2, 1) both;
}
@keyframes dsh-rum-in {
  from { opacity: 0; transform: translateY(-9px); }
  to { opacity: 1; transform: none; }
}
.dsh-rum-live-row {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
}
.dsh-rum-live-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dsw-alias-brand-primary);
  font-size: 11px;
}
.dsh-rum-live-tag::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: dsh-rum-pulse 1.4s ease-in-out infinite;
}
.dsh-rum-empty {
  flex: 1 1 auto;
  padding: 14px 6px 16px;
  color: var(--dsw-alias-label-tertiary);
  text-align: center;
}
/*
 * The summary row sits under a rule, sharing the rows' grid so each average lands under
 * the column it summarises. It is deliberately quieter than the data: a small caption
 * instead of an index, and tertiary labels with the values still legible.
 */
.dsh-rum-average-rule {
  flex: none;
  margin-top: 8px;
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.dsh-rum-average {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rum-average-label {
  color: var(--dsw-alias-label-tertiary);
  text-align: left;
}
.dsh-rum-average-caption {
  color: var(--dsw-alias-label-tertiary);
  text-align: left;
  font-size: 11px;
}
.dsh-rum-average .dsh-rum-col {
  color: var(--dsw-alias-label-secondary);
}
.dsh-rum-average .dsh-rum-primary {
  color: var(--dsw-alias-label-primary);
}

.dsh-rum-pref {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.dsh-rum-pref-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding-right: 48px;
}
.dsh-rum-pref-title {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
}
.dsh-rum-pref-desc {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
}
.dsh-rum-pref-selector {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 12px;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.dsh-rum-pref-selector:hover,
.dsh-rum-pref-selector[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1));
}
.dsh-rum-pref-selector:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dsh-rum-chevron {
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rum-pref-hint {
  margin-top: 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-rum-menu {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  margin: 0;
  padding: 5px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2));
  box-shadow:
    0 12px 32px -12px rgb(0 0 0 / .34),
    0 1px 4px -1px rgb(0 0 0 / .2);
  list-style: none;
}
.dsh-rum-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dsh-rum-menu-item:hover,
.dsh-rum-menu-item:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1));
  outline: none;
}
.dsh-rum-menu-check {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--dsw-alias-brand-primary);
}
`

    /* ------------------------------------------------------------------ */
    /* Pure metric helpers                                                 */
    /* ------------------------------------------------------------------ */

    const numberOrNull = (value) =>
      typeof value === 'number' && Number.isFinite(value) ? value : null

    /**
     * A character-cost model for the live estimate, calibrated against 725 settled steps
     * of a real session log.
     *
     * The content is not homogeneous, and that is the whole point of the model: prose and
     * reasoning tokenize near four ASCII characters per token (the usual English/code
     * ratio), while tool-call arguments are JSON — short keys, punctuation, quoted values
     * — and tokenize markedly worse, near 2.5 characters per token. CJK stays at one
     * token per character.
     *
     * Measured as the median absolute log error against the provider's own outputTokens:
     *
     *   one shared /4 for everything   0.363   (a typical 30% undercount — the reason
     *                                            live amortised speed read low)
     *   prose /4, tool args /2.5       0.127   (shipped; ratio p50 = 1.00)
     *
     * Splitting the two is what removed the bias; a fine grid search put the optimum at
     * 0.125, so this is within two thousandths of it while staying a simple rule. The
     * search also suggested a lower CJK cost, but only 45% of these steps contain any CJK
     * at all, so that term is poorly identified in this sample and is left at the
     * conventional 1 token per character.
     *
     * The estimate is only used while a step streams and for a step whose provider
     * returned no usage at all; it is always shown with the `~` marker.
     */
    const CJK_CHAR =
      /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g

    /** ASCII characters per token, by content kind. */
    const CHARS_PER_TOKEN_PROSE = 4
    const CHARS_PER_TOKEN_TOOL_ARGS = 2.5

    function tokensOfSegment(text, charsPerToken) {
      if (typeof text !== 'string' || text === '') return 0
      const cjk = text.match(CJK_CHAR)?.length ?? 0
      const rest = Math.max(0, text.length - cjk)
      return cjk + rest / charsPerToken
    }

    /**
     * Token estimate for a list of Chat blocks, weighting tool-call arguments separately
     * from prose. Rounds once at the end so many small blocks do not each lose a token.
     */
    function estimateTokens(blocks) {
      let total = 0
      for (const block of blocks ?? []) {
        if (block === null || typeof block !== 'object') continue
        if (typeof block.text === 'string') {
          total += tokensOfSegment(block.text, CHARS_PER_TOKEN_PROSE)
        } else if (typeof block.argsRaw === 'string') {
          total += tokensOfSegment(block.argsRaw, CHARS_PER_TOKEN_TOOL_ARGS)
        }
      }
      return Math.round(total)
    }

    function blocksHaveText(blocks) {
      for (const block of blocks ?? []) {
        if (block === null || typeof block !== 'object') continue
        if (typeof block.text === 'string' && block.text.trim() !== '') return true
        if (typeof block.argsRaw === 'string' && block.argsRaw !== '') return true
      }
      return false
    }

    /**
     * The provider's completion-token count, which is the authority for this figure.
     *
     * The Harness `TokenUsage` names it `outputTokens` (and it already includes
     * `reasoningTokens`, so those are never added on top). The OpenAI-shaped
     * spellings are accepted as well, so a provider adapter that forwards its own
     * usage object verbatim is not silently downgraded to an estimate.
     *
     * `null` means the provider genuinely returned no usage for this step — most
     * often an interrupted or failed request. Only then does the caller fall back.
     */
    function completionTokensOf(...candidates) {
      for (const usage of candidates) {
        if (usage === null || typeof usage !== 'object') continue
        const exact =
          numberOrNull(usage.outputTokens) ??
          numberOrNull(usage.completionTokens) ??
          numberOrNull(usage.completion_tokens)
        if (exact !== null) return exact
      }
      return null
    }

    /**
     * One settled assistant step as a request reading.
     *
     * `stepStartTime` is when the request was issued for that step, `firstTokenTime`
     * when the first visible delta arrived, `completedTime` when the step settled, so
     * TTFT and the total wall time are exact when the agent recorded them. Output
     * tokens are the provider's own `usage` count; the character estimate exists only
     * for a step that carries no usage at all.
     */
    /**
     * Time of the first qualifying member inside one packed delta run.
     *
     * A run stores its fragments compactly: `time0` is the first fragment's time and
     * `dt[i - 1]` is the gap before fragment `i`, so a member's time is a prefix sum.
     */
    function firstRunMemberTime(run, predicate) {
      const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts
      if (!Array.isArray(fragments)) return null
      let at = numberOrNull(run.time0)
      if (at === null) return null
      for (let index = 0; index < fragments.length; index += 1) {
        if (index > 0) {
          const gap = numberOrNull(run.dt?.[index - 1])
          if (gap === null) return null
          at += gap
        }
        if (predicate(fragments[index])) return at
      }
      return null
    }

    /** Mirrors the shipped `isTokenDelta`: a non-empty text/reasoning/tool-call delta. */
    function isTokenDeltaChunk(chunk) {
      if (chunk === null || typeof chunk !== 'object') return false
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== ''
      if (chunk.type === 'tool-call-delta') {
        return chunk.argumentsDelta !== '' || chunk.name !== undefined
      }
      return false
    }

    /**
     * The first-token moment recorded in a settled message's chunk timeline.
     *
     * `assistant/message.data.stream` keeps the whole stream with timestamps, so the
     * moment the model first produced output is recoverable from a replayed session.
     * This is the same reconstruction the shipped trajectory panel performs, which is
     * why that panel can show a first-token latency for history whose live stream state
     * the Chat store no longer holds.
     *
     * `block-start` announces a block but carries no output, so it is not a candidate.
     */
    function firstTokenTimeOfStream(stream) {
      if (!Array.isArray(stream)) return null
      for (const record of stream) {
        if (record === null || typeof record !== 'object') continue
        if (record.type === 'chunk') {
          if (!isTokenDeltaChunk(record.chunk)) continue
          const at = numberOrNull(record.time)
          if (at !== null) return at
          continue
        }
        // A packed run: a name-bearing tool call starts at its first member, otherwise
        // the first non-empty fragment marks the token.
        if (record.type === 'tool-call-chunks' && record.name !== undefined) {
          const at = numberOrNull(record.time0)
          if (at !== null) return at
          continue
        }
        const at = firstRunMemberTime(record, (fragment) => fragment !== '')
        if (at !== null) return at
      }
      return null
    }

    function readingOf(node) {
      const timing = node?.timing ?? {}
      const start = numberOrNull(timing.stepStartTime)
      const end = numberOrNull(timing.completedTime)
      /*
       * The live store records `firstTokenTime` only for a step that streamed during this
       * page's lifetime. A step replayed from the session log has no such field, but its
       * message carries the chunk timeline, so recover the mark from there. This is what
       * lets a seeded history row show a real first-token latency instead of "--".
       */
      const first =
        numberOrNull(timing.firstTokenTime) ?? firstTokenTimeOfStream(node?.stream)
      // `usage` sits on the node; the nested spelling covers a shape variant that
      // keeps it under the step data instead.
      const exact = completionTokensOf(node?.usage, node?.data?.usage)
      const tokens = exact ?? estimateTokens(node?.blocks)
      const ttftMs = start !== null && first !== null ? Math.max(0, first - start) : null
      const totalMs = start !== null && end !== null ? Math.max(0, end - start) : null
      const decodeMs = first !== null && end !== null ? Math.max(0, end - first) : null
      const speed =
        tokens > 0 && decodeMs !== null && decodeMs > 0
          ? tokens / (decodeMs / 1000)
          : tokens > 0 && totalMs !== null && totalMs > 0
            ? tokens / (totalMs / 1000)
            : null
      return {
        key: `${node?.turn ?? 0}:${node?.step ?? 0}`,
        at: end ?? Date.now(),
        // Kept so a later first-token time can be turned into a TTFT without the node.
        startMs: start,
        ttftMs,
        totalMs,
        tokens,
        estimated: exact === null,
        speed,
        amortized: tokens > 0 && totalMs !== null && totalMs > 0 ? tokens / (totalMs / 1000) : null,
      }
    }

    const isAssistantNode = (node) =>
      node !== null && typeof node === 'object' && node.kind === 'assistant'

    function readJson(key) {
      try {
        const raw = localStorage.getItem(key)
        return raw === null ? null : JSON.parse(raw)
      } catch {
        return null
      }
    }

    function writeJson(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // A full or blocked storage keeps the value live for this run only.
      }
    }

    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

    /** Keep only rows that still carry what the drawer renders, newest first, capped. */
    function normalizeHistory(candidate) {
      if (!Array.isArray(candidate)) return []
      const rows = []
      for (const entry of candidate) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.key !== 'string') continue
        const tokens = num(entry.tokens)
        if (tokens === null) continue
        rows.push({
          key: entry.key,
          at: num(entry.at) ?? 0,
          ttftMs: num(entry.ttftMs),
          totalMs: num(entry.totalMs),
          tokens,
          estimated: entry.estimated === true,
          speed: num(entry.speed),
          amortized: num(entry.amortized),
        })
        if (rows.length >= MAX_ROWS) break
      }
      return rows
    }

    /**
     * The plugin's own durable state: the Geek flag plus the newest-first history.
     * One instance per activation; components read it through the injected hook
     * sources and record through the injected `record`.
     */
    function createModel() {
      let mode = readJson(MODE_KEY) === GEEK ? GEEK : null
      let rows = normalizeHistory(readJson(HISTORY_KEY))
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('dsh-recent-usage-metrics: listener failed', error)
          }
        }
      }
      return {
        getMode: () => mode,
        setMode(next) {
          const value = next === GEEK ? GEEK : null
          if (mode === value) return
          mode = value
          writeJson(MODE_KEY, mode)
          emit()
        },
        getRows: () => rows,
        /** Push one reading to the top, dropping the eleventh, and remember it. */
        record(reading) {
          if (reading === null || reading === undefined) return
          if (rows.length > 0 && rows[0].key === reading.key) return
          rows = [reading, ...rows.filter((row) => row.key !== reading.key)].slice(0, MAX_ROWS)
          writeJson(HISTORY_KEY, rows)
          emit()
        },
        /** Seed an empty history from the steps already in the loaded log. */
        seed(readings) {
          if (rows.length > 0) return
          const oldestFirst = readings.slice(-MAX_ROWS)
          if (oldestFirst.length === 0) return
          rows = oldestFirst.slice().reverse().slice(0, MAX_ROWS)
          writeJson(HISTORY_KEY, rows)
          emit()
        },
        /**
         * Replace the stored rows with re-dated copies.
         *
         * Used when a first-token time becomes available after seeding: the row already
         * in the drawer predates that information, and `seed` refuses to touch a non-empty
         * history. Only the caller decides which rows change.
         */
        backfill(next) {
          if (!Array.isArray(next) || next.length === 0) return
          rows = next.slice(0, MAX_ROWS)
          writeJson(HISTORY_KEY, rows)
          emit()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /**
     * The shipped Chat preference, mirrored into a local snapshot store so a choice
     * shows immediately while the Host write is still in flight. Writes go through
     * `ctx.configForms` exactly as the shipped row does.
     *
     * `getForm` is a getter rather than the form itself because the settings domain can
     * arrive after this plugin applies. Probing once at apply time would latch the row
     * onto the fallback for the rest of the session.
     */
    function createPreference(getForm) {
      const fallback = 'detailed'
      let form = null
      let unsubscribe = () => {}
      const read = () => {
        if (form === null) return fallback
        const value = form.getSnapshot()?.value?.[CHAT_FIELD]
        return value === 'compact' || value === 'detailed' ? value : fallback
      }
      let current = fallback
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      const attach = (next) => {
        if (next === null || next === form) return
        unsubscribe()
        form = next
        current = read()
        unsubscribe = form.subscribe(() => {
          const value = read()
          if (value === current) return
          current = value
          emit()
        })
        emit()
      }
      return {
        /**
         * Called when `configForms` becomes available. Idempotent, so a re-run after an
         * HMR or a service restart simply re-binds.
         */
        bind(next) {
          attach(next)
        },
        source: {
          getSnapshot: () => current,
          subscribe: (listener) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        },
        set(value) {
          const next = value === 'compact' ? 'compact' : 'detailed'
          if (next !== current) {
            current = next
            emit()
          }
          if (form === null) return
          try {
            const result = form.set(CHAT_FIELD, next)
            if (result !== null && typeof result.then === 'function') result.catch(() => {})
          } catch {
            // The Host rejects an unknown level; the shipped two always validate.
          }
        },
        dispose() {
          unsubscribe()
          unsubscribe = () => {}
          form = null
        },
      }
    }

    /* ------------------------------------------------------------------ */
    /* Formatting                                                          */
    /* ------------------------------------------------------------------ */

    const oneDecimal = (ms) => (Math.round(ms / 100) / 10).toFixed(1)

    /**
     * The status pill renders fixed-width slots, so each value is formatted to fit its
     * slot exactly rather than to a generic pretty form. Nothing here may ever grow past
     * its reserved width, because that is what keeps the centred composer row still.
     *
     * Durations reserve 4 characters: "3.1", "57.8", then whole seconds from 100 up
     * ("126"), which keeps minutes-scale turns inside the same slot.
     */
    function durationSlot(ms) {
      if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '--'
      const seconds = ms / 1000
      return seconds < 100 ? oneDecimal(ms) : String(Math.round(seconds))
    }

    /**
     * Integers reserve their digit count: speed up to 4 digits, tokens up to 5. A token
     * count from 10000 up collapses to thousands ("29k") so a long response still fits
     * the same slot instead of widening the pill.
     */
    const speedSlot = (value) =>
      value === null || value === undefined || !Number.isFinite(value)
        ? '--'
        : String(Math.min(9999, Math.round(value)))

    const tokenSlot = (value) => {
      if (value === null || value === undefined || !Number.isFinite(value)) return '--'
      const whole = Math.round(value)
      if (whole < 100000) return String(whole)
      return `${Math.round(whole / 1000)}k`
    }

    /** The unit that belongs to each slot; both are fixed length. */
    const DURATION_UNIT = ' s'
    const SPEED_UNIT = ' tok/s'

    function secondsText(ms, t) {
      return ms === null || ms === undefined ? t('none') : t('seconds', { value: oneDecimal(ms) })
    }

    function speedText(value, approximate, t) {
      if (value === null || value === undefined || !Number.isFinite(value)) return t('none')
      const rounded = String(Math.round(value))
      return approximate ? t('approxSpeedUnit', { value: rounded }) : t('speedUnit', { value: rounded })
    }

    function tokensText(value, approximate, t) {
      if (value === null || value === undefined || !Number.isFinite(value)) return t('none')
      const rounded = String(Math.round(value))
      return approximate ? t('approxTokensUnit', { value: rounded }) : t('tokensUnit', { value: rounded })
    }

    function clockText(at) {
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function agoText(at, now, t) {
      const delta = Math.max(0, now - at)
      if (delta < 10_000) return t('justNow')
      if (delta < 60_000) return t('secondsAgo', { count: Math.round(delta / 1000) })
      if (delta < 3_600_000) return t('minutesAgo', { count: Math.round(delta / 60_000) })
      return t('hoursAgo', { count: Math.round(delta / 3_600_000) })
    }

    /* ------------------------------------------------------------------ */
    /* Small primitives a plain-JS plugin writes itself                    */
    /* ------------------------------------------------------------------ */

    /**
     * The estimate marker. It occupies its slot unconditionally and only toggles
     * paint, because inserting or removing a glyph would otherwise change the pill's
     * width — exactly the shift the fixed slots exist to prevent. It is hidden from
     * assistive technology so a hidden marker is never announced; the button's own
     * `aria-label` carries the full reading.
     */
    function Tilde(props) {
      return h(
        'span',
        { className: 'dsh-rum-tilde', 'data-on': props.on === true, 'aria-hidden': true },
        '~',
      )
    }

    function BoltIcon(props) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', className: props.className, 'aria-hidden': true, fill: 'currentColor' },
        h('path', { d: 'M9.2 1 3.4 8.6h3.2L6.4 15l5.9-7.7H9.1z' }),
      )
    }

    function ChevronIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          className: props.className,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'm4 6 4 4 4-4' }),
      )
    }

    function CheckIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          className: props.className,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'm3 8.5 3.2 3.2L13 4.8' }),
      )
    }

    /** `t` may be absent when the locale service is not composed. */
    const translator = (t) => (key, params) => (typeof t === 'function' ? t(key, params) : key)

    /* ------------------------------------------------------------------ */
    /* The replacement settings row                                        */
    /* ------------------------------------------------------------------ */

    /**
     * A fixed-position menu anchored to its trigger, so the settings panel's own
     * scroll container cannot clip it. Escape and an outside pointerdown close it,
     * and the trigger keeps focus after a choice, matching the shipped row.
     */
    function OptionsMenu(props) {
      const { anchorRef, options, value, onSelect, onClose } = props
      const panelRef = useRef(null)
      const [pos, setPos] = useState(null)

      useLayoutEffect(() => {
        const place = () => {
          const anchor = anchorRef.current
          if (anchor === null) return
          const rect = anchor.getBoundingClientRect()
          const width = 168
          const height = options.length * 32 + 12
          const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8))
          const below = rect.bottom + 6
          const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below
          setPos({ top, left, width })
        }
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [anchorRef, options.length])

      useEffect(() => {
        const onPointerDown = (event) => {
          const target = event.target
          if (panelRef.current?.contains(target) === true) return
          if (anchorRef.current?.contains(target) === true) return
          onClose()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [anchorRef, onClose])

      return h(
        'ul',
        {
          ref: panelRef,
          className: 'dsh-rum-menu',
          role: 'menu',
          style:
            pos === null
              ? { visibility: 'hidden', top: 0, left: 0 }
              : { top: pos.top, left: pos.left, width: pos.width },
        },
        options.map((option) =>
          h(
            'li',
            { key: option.id, role: 'none' },
            h(
              'button',
              {
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': option.id === value,
                className: 'dsh-rum-menu-item',
                onClick: () => onSelect(option.id),
              },
              h('span', null, option.label),
              option.id === value ? h(CheckIcon, { className: 'dsh-rum-menu-check' }) : null,
            ),
          ),
        ),
      )
    }

    /**
     * The shipped "Performance & usage" row, re-registered under its own cell id.
     * Compact/Detailed keep writing the shipped Chat preference; Geek is this
     * plugin's own flag, because the shipped schema rejects a third value.
     */
    function PerformanceUsageRow(props) {
      const { usePerformanceUsage, useGeek, setPerformanceUsage, setGeek, t } = props
      const shipped = usePerformanceUsage((value) => value)
      const geek = useGeek((value) => value) === GEEK
      const [open, setOpen] = useState(false)
      const selectorRef = useRef(null)

      const value = geek ? GEEK : shipped === 'compact' ? 'compact' : 'detailed'
      const options = useMemo(
        () => [
          { id: 'compact', label: t('optionCompact') },
          { id: 'detailed', label: t('optionDetailed') },
          { id: GEEK, label: t('optionGeek') },
        ],
        [t, value],
      )
      const selected = options.find((option) => option.id === value) ?? options[1]

      const choose = useCallback(
        (id) => {
          selectorRef.current?.focus({ preventScroll: true })
          setOpen(false)
          if (id === GEEK) {
            setGeek(GEEK)
            return
          }
          setGeek(null)
          setPerformanceUsage(id)
        },
        [setGeek, setPerformanceUsage],
      )

      return h(
        'div',
        { className: 'dsh-rum-pref' },
        h(
          'div',
          { className: 'dsh-rum-pref-text' },
          h('div', { className: 'dsh-rum-pref-title' }, t('settingsTitle')),
          h('div', { className: 'dsh-rum-pref-desc' }, t('settingsDescription')),
          geek ? h('div', { className: 'dsh-rum-pref-hint' }, t('geekHint')) : null,
        ),
        h(
          'button',
          {
            ref: selectorRef,
            type: 'button',
            className: 'dsh-rum-pref-selector',
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            onClick: () => setOpen((current) => !current),
          },
          selected.label,
          h(ChevronIcon, { className: 'dsh-rum-chevron' }),
        ),
        open
          ? portal(
              h(OptionsMenu, {
                anchorRef: selectorRef,
                options,
                value,
                onSelect: choose,
                onClose: () => setOpen(false),
              }),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* The composer status entry                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Live reading of the step streaming right now.
     *
     * The Chat snapshot exposes the running step only as `legacy.partial` (turn, step,
     * blocks) — it carries the turn's start but no per-step start. Two things make a
     * live TTFT honest:
     *
     * 1. A step-level origin. The shipped settled reading is
     *    `firstTokenTime - stepStartTime`, so the live figure must use the same origin.
     *    Using the turn's start overstates TTFT by everything earlier in the turn: in a
     *    real session log the gap from turn start to a later step's start is a 174 s
     *    median and reaches 2720 s. The best available proxy is the completion time of
     *    the latest settled step in the same turn (the next step begins right after it),
     *    falling back to the turn's start for a turn's first step.
     * 2. First delta, not first visible text. The settled `firstTokenTime` counts
     *    reasoning and tool-call deltas too, and `legacy.partial` only appears once the
     *    step has visible content — which is that first delta. So the moment a new
     *    partial key appears is the first-token moment.
     */
    /**
     * Character count of the argument text a tool call has streamed so far.
     *
     * The Chat store accumulates a preparing call's argument fragments on the call's own
     * `args` view (`chunks`, a public field) and only settles them into a block at
     * `block-end`. `legacy.partial.blocks` therefore carries NO argument text while a call
     * is still being written — `updateChunk`'s `tool-call-delta` branch copies `argsRaw`
     * unchanged, so it stays empty until the block ends.
     *
     * That matters because tool arguments dominate real output: across 874 settled steps
     * of a session log they were a median **93%** of the estimated tokens, and 98% of
     * steps had them. Reading `runningCalls` is what keeps the live figure moving while
     * the model writes a file, instead of freezing at the prose total.
     *
     * Returns 0 for a call that is not preparing, or whose fragments are unavailable.
     */
    function preparingArgsText(runningCalls) {
      let text = ''
      for (const call of runningCalls ?? []) {
        if (call === null || typeof call !== 'object') continue
        if (call.phase !== 'preparing') continue
        const chunks = call.args?.chunks
        if (Array.isArray(chunks)) {
          for (const piece of chunks) if (typeof piece === 'string') text += piece
          continue
        }
        // A settled call carries its finished text in one piece.
        if (typeof call.argsRaw === 'string') text += call.argsRaw
      }
      return text
    }

    /**
     * The assistant request the Trajectory domain currently has in flight.
     *
     * This is the earliest signal a browser-only plugin can get. The Chat store's
     * `legacy.partial` only appears once a step has a visible block — measured against a
     * real log, that is a 1.9 s median (p90 2.9 s) after the step starts, which is exactly
     * the span a first-token latency mostly measures. The Trajectory domain instead opens
     * its assistant record on `step/start` itself and publishes the whole step boundary
     * immediately, so `startedAt` is available from the first frame of the step.
     *
     * `step/start` is a location boundary, and the conversation assembler raises that
     * publication to "immediate" even though the definition itself asks for "none".
     *
     * Returns undefined when the domain has settled or not assembled.
     */
    function runningRequestOf(trajectorySnapshot) {
      const requests = trajectorySnapshot?.requests
      if (!Array.isArray(requests)) return undefined
      let latest
      for (const request of requests) {
        if (request === null || typeof request !== 'object') continue
        if (request.purpose !== 'assistant') continue
        if (request.status !== 'running') continue
        if (latest === undefined || (request.startSeq ?? 0) >= (latest.startSeq ?? 0)) latest = request
      }
      return latest
    }

    /**
     * The first-token moment the Trajectory domain already reconstructed for a step.
     *
     * `requests[]` carries only `startedAt` / `completedAt`, so the token mark comes from
     * the running step's `partial` timeline, or — once settled — from the node's `timing`.
     */
    function firstTokenOfStep(trajectorySnapshot, key) {
      const partial = trajectorySnapshot?.partial
      if (partial !== null && partial !== undefined) {
        const at = numberOrNull(partial.timing?.firstTokenTime)
        if (at !== null) return at
      }
      const nodes = trajectorySnapshot?.eventNodes
      if (!Array.isArray(nodes)) return null
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue
        if (node.kind !== 'assistant') continue
        if (`${node.turn}:${node.step}` !== key) continue
        const at = numberOrNull(node.timing?.firstTokenTime)
        if (at !== null) return at
      }
      return null
    }

    function useLiveReading(useChat, enabled, trajectory) {
      const partial = useChat((snapshot) => snapshot.legacy.partial)
      const nodes = useChat((snapshot) => snapshot.legacy.nodes)
      const turnTimings = useChat((snapshot) => snapshot.legacy.turnTimings)
      const runningCalls = useChat((snapshot) => snapshot.legacy.runningCalls)

      /*
       * A step is live from `step/start`, not from its first visible block. The Trajectory
       * domain reports that step immediately; `legacy.partial` is the fallback for a
       * composition without it.
       */
      const request = runningRequestOf(trajectory)
      const liveStep = request === undefined
        ? partial === null || partial === undefined
          ? null
          : { turn: partial.turn, step: partial.step }
        : { turn: request.turn, step: request.step }
      const running = enabled && liveStep !== null
      const [now, setNow] = useState(() => Date.now())
      const observation = useRef({ key: null, firstTokenAt: null })

      useEffect(() => {
        if (!running) return undefined
        const id = setInterval(() => setNow(Date.now()), 150)
        return () => clearInterval(id)
      }, [running])

      /*
       * The first-token mark of the running step, from the tightest source available: the
       * Trajectory timeline (exact, reconstructed by that domain), else the moment a new
       * partial key first appeared — `legacy.partial` only exists once the step has visible
       * content, so that appearance IS the first delta.
       */
      useEffect(() => {
        if (!running) {
          observation.current = { key: null, firstTokenAt: null }
          return
        }
        const key = `${liveStep.turn}:${liveStep.step}`
        const exact = firstTokenOfStep(trajectory, key)
        if (exact !== null) {
          observation.current = { key, firstTokenAt: exact }
          return
        }
        if (observation.current.key !== key) {
          observation.current = { key, firstTokenAt: null }
          return
        }
        if (
          observation.current.firstTokenAt === null &&
          partial !== null &&
          partial !== undefined &&
          blocksHaveText(partial.blocks)
        ) {
          observation.current = { key, firstTokenAt: Date.now() }
        }
      }, [running, liveStep, trajectory, partial])

      if (!running) return null

      /*
       * The step's origin: the Trajectory domain's own `startedAt` (exact, present from
       * `step/start`), else the tool-result reconstruction, else the turn's start.
       */
      const start =
        numberOrNull(request?.startedAt) ?? stepStartOf(liveStep, nodes, turnTimings)
      const key = `${liveStep.turn}:${liveStep.step}`
      const firstTokenAt = observation.current.firstTokenAt
      /*
       * Blocks cover the prose and reasoning; a preparing tool call's arguments live only
       * on `runningCalls`, so count those separately at the tool-argument coefficient.
       */
      const tokens = partial === null || partial === undefined
        ? Math.round(tokensOfSegment(preparingArgsText(runningCalls), CHARS_PER_TOKEN_TOOL_ARGS))
        : estimateTokens(partial.blocks) +
          Math.round(tokensOfSegment(preparingArgsText(runningCalls), CHARS_PER_TOKEN_TOOL_ARGS))

      /*
       * Until the first token arrives the reading counts up from the step's own start —
       * that is what makes the figure visibly grow instead of appearing at its final value.
       * Once it arrives, the same subtraction the settled row performs takes over, so the
       * number freezes rather than jumping.
       */
      const ttftMs = start === null
        ? null
        : Math.max(0, (firstTokenAt ?? now) - start)
      const elapsedMs = start !== null ? Math.max(0, now - start) : null
      const decodeMs = firstTokenAt !== null ? Math.max(0, now - firstTokenAt) : null
      return {
        key,
        at: start ?? now,
        ttftMs,
        totalMs: elapsedMs,
        tokens,
        estimated: true,
        speed: tokens > 0 && decodeMs !== null && decodeMs > 0 ? tokens / (decodeMs / 1000) : null,
        amortized: tokens > 0 && elapsedMs !== null && elapsedMs > 0 ? tokens / (elapsedMs / 1000) : null,
      }
    }

    /**
     * The moment the running step actually began.
     *
     * `timing.completedTime` is NOT a step's end: Chat sets it to the `assistant/message`
     * event time, which lands *before* the step's tools run. Using it as the next step's
     * origin counts the whole tool execution into that step's live TTFT — in a real
     * session log that gap has a 243 ms median but reaches 120 s, which is why a live
     * reading could show six seconds and settle at two.
     *
     * What does mark the end of a step's work is its last tool result: measured over
     * 1038 steps, a step's final `tool/result` sits within 1 ms of its `step/end`, and
     * the next step starts a median 9 ms later. So the latest tool result of the previous
     * step is the tightest origin a browser-only plugin can reach — p50 9 ms and p99
     * 486 ms, against p50 243 ms and p99 20.8 s for the old field.
     *
     * A settled tool node carries no turn/step, only `seq`, `time` and `callTime`
     * (`kind: 'tool-result'`), so attribution runs on the seq window: the tool results
     * belonging to step S-1 are sequenced between the assistant nodes of S-1 and S. Seq
     * rather than timestamp, because a resumed log replays steps and times repeat.
     *
     * Three cases, in order: the last tool result of the previous step; that step's own
     * completion when it ran no tools (it was the turn's final answer, so nothing follows
     * it); the turn's own start for a turn's first step (a real log puts that 26 ms in).
     */
    function stepStartOf(partial, nodes, turnTimings) {
      const turn = partial?.turn
      const step = partial?.step
      if (typeof turn !== 'number' || typeof step !== 'number') return null

      const assistants = (nodes ?? []).filter(isAssistantNode)
      const findStep = (target) =>
        assistants.find((node) => node.turn === turn && node.step === target)

      const previousNode = findStep(step - 1)
      if (previousNode !== undefined) {
        const previousSeq = numberOrNull(previousNode.seq)
        const currentSeq = numberOrNull(findStep(step)?.seq) ?? Number.POSITIVE_INFINITY

        let lastToolTime = null
        if (previousSeq !== null) {
          for (const node of nodes ?? []) {
            if (node === null || typeof node !== 'object') continue
            if (node.kind !== 'tool-result') continue
            const seq = numberOrNull(node.seq)
            if (seq === null || seq <= previousSeq || seq >= currentSeq) continue
            const at = numberOrNull(node.time)
            if (at !== null && (lastToolTime === null || at > lastToolTime)) lastToolTime = at
          }
        }
        if (lastToolTime !== null) return lastToolTime

        // No tools: that step ended the turn's work, so its own completion is the mark.
        const completed = numberOrNull(previousNode.timing?.completedTime)
        if (completed !== null) return completed
      }

      return numberOrNull(turnTimings?.get?.(turn)?.startTime)
    }

    /**
     * Insertion phase for the drawer's rows.
     *
     * A new request slides in from the top, but the row that falls off the end of the
     * ten-row cap is removed in the SAME frame rather than fading out on its own. An
     * exit phase would keep an eleventh row in the layout for its animation's duration,
     * making the drawer grow by a row and shrink back — a height jump on every insertion.
     * The evicted row sits at the bottom of a scrolled list, so the lost fade is not
     * noticeable, while the stable height is.
     *
     * Only the entering row is tracked; every other row is derived straight from the
     * incoming list, so the view can never hold a row the model no longer has.
     */
    function useAnimatedRows(rows) {
      const [entering, setEntering] = useState(() => new Set())
      /** Keys from the previous pass; `null` until the first one settles. */
      const seenKeys = useRef(null)
      const timer = useRef(null)

      useEffect(() => {
        const keys = rows.map((row) => row.key)
        const previous = seenKeys.current
        seenKeys.current = keys

        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }

        /*
         * The first pass after opening establishes the baseline instead of animating:
         * `previous === null` means there is nothing to compare against, so every row
         * would otherwise look like a new arrival and the whole list would slide in.
         */
        if (previous === null) {
          setEntering(new Set())
          return undefined
        }

        const known = new Set(previous)
        const arrivals = keys.filter((key) => !known.has(key))
        if (arrivals.length === 0) {
          setEntering((current) => (current.size === 0 ? current : new Set()))
          return undefined
        }

        setEntering(new Set(arrivals))
        timer.current = setTimeout(() => {
          timer.current = null
          setEntering(new Set())
        }, 260)

        return () => {
          if (timer.current !== null) {
            clearTimeout(timer.current)
            timer.current = null
          }
        }
      }, [rows])

      return rows.map((row, index) => ({
        key: row.key,
        row,
        index,
        phase: entering.has(row.key) ? 'enter' : 'idle',
      }))
    }

    /**
     * Fallback distance from the drawer's right box edge to the right edge of its last
     * data column, used before the panel has been laid out: the drawer's 16px padding
     * plus a row's 6px right padding.
     */
    const DRAWER_INSET = 22

    /**
     * The same distance, measured from the rendered panel. Measuring instead of
     * hard-coding keeps the alignment correct if the theme's spacing tokens change.
     *
     * Reads the last column of the header row (which is always present) and compares its
     * right edge with the panel's, so whatever the padding chain is, the numbers land on
     * the pill's content edge.
     */
    function drawerContentInset(panel) {
      const header = panel.querySelector('.dsh-rum-row')
      if (header === null) return DRAWER_INSET
      const cells = header.querySelectorAll('.dsh-rum-col')
      if (cells.length === 0) return DRAWER_INSET
      const last = cells[cells.length - 1]
      const inset = panel.getBoundingClientRect().right - last.getBoundingClientRect().right
      return Number.isFinite(inset) ? inset : DRAWER_INSET
    }

    /**
     * Distance from the pill's right box edge to the right edge of its last figure — the
     * button's own right padding. Aligning figures rather than boxes is what reads as a
     * shared column edge, because the drawer and the pill pad very differently.
     */
    function pillContentInset(button) {
      const parts = button.querySelector('.dsh-rum-parts')
      if (parts === null) return 8
      const inset = button.getBoundingClientRect().right - parts.getBoundingClientRect().right
      return Number.isFinite(inset) ? inset : 8
    }

    /**
     * Average of the rows on screen, computed over the ones that actually carry each
     * figure (an interrupted request may have no TTFT, a placeholder no tokens). Returns
     * null for a column with no samples so the row can print a dash instead of a fake 0.
     */
    function averageOf(rows) {
      if (rows.length === 0) return null
      const mean = (pick) => {
        let sum = 0
        let count = 0
        for (const row of rows) {
          const value = pick(row)
          if (value === null || value === undefined || !Number.isFinite(value)) continue
          sum += value
          count += 1
        }
        return count === 0 ? null : sum / count
      }
      return {
        count: rows.length,
        ttftMs: mean((row) => row.ttftMs),
        speed: mean((row) => row.speed),
        tokens: mean((row) => row.tokens),
        totalMs: mean((row) => row.totalMs),
        amortized: mean((row) => row.amortized),
        // A column is "estimated" when any sample in it was; the tilde then still means
        // the same thing it does on a single row.
        estimated: rows.some((row) => row.estimated === true),
        anyEstimated: rows.some((row) => row.estimated === true),
      }
    }

    /**
     * The average of the visible rows. It renders in the same grid as the rows above, so
     * every figure lands under the column it summarises.
     */
    function AverageRow(props) {
      const { rows, t } = props
      const average = averageOf(rows)
      if (average === null) return null
      return h(
        'div',
        { className: 'dsh-rum-row dsh-rum-average', role: 'row' },
        h('span', { className: 'dsh-rum-average-label', role: 'cell' }, '⌀'),
        h(
          'span',
          { className: 'dsh-rum-average-caption', role: 'cell' },
          t('averageOf', { count: average.count }),
        ),
        h('span', { className: 'dsh-rum-col', role: 'cell' }, secondsText(average.ttftMs, t)),
        h(
          'span',
          { className: 'dsh-rum-col dsh-rum-primary', role: 'cell' },
          speedText(average.speed, average.estimated, t),
        ),
        h(
          'span',
          { className: 'dsh-rum-col', role: 'cell' },
          tokensText(average.tokens, average.estimated, t),
        ),
        h('span', { className: 'dsh-rum-col', role: 'cell' }, secondsText(average.totalMs, t)),
        h(
          'span',
          { className: 'dsh-rum-col', role: 'cell' },
          speedText(average.amortized, average.estimated, t),
        ),
      )
    }

    /**
     * Index the first-token times the Trajectory domain already recovered.
     *
     * A session replayed from the log has no `timing.firstTokenTime` in the Chat store:
     * that value is streamed state, and the log stores no live chunks. The Trajectory
     * domain, however, rebuilds it at settlement from the message's chunk timeline
     * (`assistantStreamFirstTokenTime`), which is why the Trajectory panel can show a
     * first-token latency for the very history the Chat snapshot cannot date.
     *
     * Its snapshot is reachable from a slot entry through the standard `useTrajectory`
     * hook, so this reads that domain instead of guessing. Returns an empty map when the
     * domain has not assembled (the drawer then shows `--`, exactly as before).
     */
    function firstTokenIndex(trajectorySnapshot) {
      const index = new Map()
      const nodes = trajectorySnapshot?.eventNodes
      if (!Array.isArray(nodes)) return index
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue
        if (node.kind !== 'assistant') continue
        const turn = node.turn
        const step = node.step
        if (typeof turn !== 'number' || typeof step !== 'number') continue
        const first = numberOrNull(node.timing?.firstTokenTime)
        if (first === null) continue
        index.set(`${turn}:${step}`, first)
      }
      return index
    }

    /** Stable empty index, so an absent Trajectory domain does not churn the memo. */
    const NO_FIRST_TOKENS = new Map()

    /** The whole geek entry: trigger, live reading, and the upward glass drawer. */
    function GeekStatus(props) {
      const { useChat, useGeek, useRows, record, seed, backfill, t } = props
      const geek = useGeek((value) => value) === GEEK
      const rows = useRows((value) => value)
      /*
       * The Trajectory domain's snapshot. `useTrajectory` is a standard slot prop, read
       * defensively: a composition without that domain yields `undefined` and everything
       * below falls back to the Chat snapshot alone.
       *
       * It is read before the live reading because that reading needs the domain's own
       * running-step record: the Chat store only publishes a step once it has visible
       * content, which is a 1.9 s median after the step begins.
       */
      const useTrajectory = props.useTrajectory
      const trajectory = typeof useTrajectory === 'function' ? useTrajectory((snapshot) => snapshot) : undefined
      const live = useLiveReading(useChat, geek, trajectory)
      const nodes = useChat((snapshot) => snapshot.legacy.nodes)
      /*
       * The first-token times for replayed history. The index is memoized on the snapshot,
       * which is a stable reference between publications — without this the effect below
       * would see a new Map every render and never settle.
       */
      const firstTokens = useMemo(
        () => (trajectory === undefined || trajectory === null ? NO_FIRST_TOKENS : firstTokenIndex(trajectory)),
        [trajectory],
      )

      const triggerRef = useRef(null)
      const drawerRef = useRef(null)
      const partsRef = useRef(null)
      const [pinned, setPinned] = useState(false)
      const [mounted, setMounted] = useState(false)
      const [entered, setEntered] = useState(false)
      const [pos, setPos] = useState(null)
      const [now, setNow] = useState(() => Date.now())
      const seen = useRef(null)
      /**
       * Measured pixel widths of the pill's five metric cells, in DOM order. The drawer
       * uses them as its grid columns so each column sits exactly under the metric it
       * reports; `ch` arithmetic cannot do this because the label glyphs are narrower
       * than the `ch` unit itself.
       */
      const [columnWidths, setColumnWidths] = useState(null)

      /* Click only: the drawer opens on the pill and closes on it, Escape, or outside. */
      const open = geek && pinned

      /* Record each assistant step once, after it settles. */
      useEffect(() => {
        if (!geek) {
          seen.current = null
          return
        }
        const assistants = nodes.filter(isAssistantNode)
        /*
         * A step replayed from the log carries no first-token time in the Chat snapshot,
         * so date it from the Trajectory domain's reconstruction when that is available.
         * A step that streamed in this session keeps its own exact value.
         */
        const dated = (node) => {
          const key = `${node.turn}:${node.step}`
          const fromTrajectory = firstTokens.get(key)
          if (fromTrajectory === undefined) return readingOf(node)
          const timing = node?.timing ?? {}
          if (numberOrNull(timing.firstTokenTime) !== null) return readingOf(node)
          return readingOf({ ...node, timing: { ...timing, firstTokenTime: fromTrajectory } })
        }
        if (seen.current === null) {
          seen.current = new Set(assistants.map((node) => `${node.turn}:${node.step}`))
          seed(assistants.map(dated))
          return
        }
        for (const node of assistants) {
          const key = `${node.turn}:${node.step}`
          if (seen.current.has(key)) continue
          seen.current.add(key)
          record(dated(node))
        }
      }, [geek, nodes, record, seed, firstTokens])

      /*
       * Repair history that was seeded before the Trajectory domain had assembled.
       *
       * That domain is another plugin's projection, so its first-token times can arrive
       * after this plugin's first pass. Rows already stored keep their `--` unless they
       * are re-dated here; `seed` refuses to touch a non-empty history by design.
       *
       * Only rows whose key matches a newly available time are touched, and only when the
       * row has no time yet, so a value that streamed live is never overwritten.
       */
      useEffect(() => {
        if (!geek || firstTokens.size === 0) return
        const current = rows
        if (current.length === 0) return
        let changed = false
        const next = current.map((row) => {
          if (row.ttftMs !== null && row.ttftMs !== undefined) return row
          const first = firstTokens.get(row.key)
          if (first === undefined) return row
          const start = row.startMs
          if (start === null || start === undefined) return row
          changed = true
          const ttftMs = Math.max(0, first - start)
          const decodeMs = row.at !== null && row.at !== undefined ? Math.max(0, row.at - first) : null
          return {
            ...row,
            ttftMs,
            speed:
              row.tokens > 0 && decodeMs !== null && decodeMs > 0
                ? row.tokens / (decodeMs / 1000)
                : row.speed,
          }
        })
        if (changed) backfill(next)
      }, [geek, firstTokens, rows, backfill])

      /* Mount / enter / leave for the drawer's slide-up transition. */
      useEffect(() => {
        if (open) {
          setMounted(true)
          const frame = requestAnimationFrame(() => setEntered(true))
          return () => cancelAnimationFrame(frame)
        }
        setEntered(false)
        const timer = setTimeout(() => setMounted(false), 200)
        return () => clearTimeout(timer)
      }, [open])

      /*
       * Measure the pill's five metric cells and hand the pixel widths to the drawer's
       * grid. A `ch`-based column cannot line up with the pill: `ch` is the advance of
       * "0" while the unit glyphs ("tok/s", the thin "s") are narrower, so the computed
       * column and the rendered cell disagree. Reading the real boxes is the only way
       * to put each drawer column exactly under its metric.
       *
       * The pill reserves fixed digit widths, so these values are stable across
       * streaming updates; the pass re-runs on mount, resize, and font scaling.
       */
      useLayoutEffect(() => {
        if (!mounted) return undefined
        const measure = () => {
          const host = partsRef.current
          if (host === null) return
          const cells = host.querySelectorAll('[data-metric]')
          if (cells.length !== 5) return
          const widths = []
          for (const cell of cells) {
            const rect = cell.getBoundingClientRect()
            // getBoundingClientRect is 0 in a detached/hidden tree; keep the CSS fallback.
            if (rect.width <= 0) return
            widths.push(Math.round(rect.width * 100) / 100)
          }
          setColumnWidths((previous) => {
            if (previous !== null && previous.every((value, index) => value === widths[index])) {
              return previous
            }
            return widths
          })
        }
        measure()
        window.addEventListener('resize', measure)
        /*
         * A font-size change (the Settings font scale) or a metric swap moves the pill's
         * cells without a window resize; observe the pill itself so the drawer columns
         * follow. ResizeObserver is absent in older engines, where the resize listener
         * above still covers the common case.
         */
        let observer
        if (typeof ResizeObserver === 'function' && partsRef.current !== null) {
          observer = new ResizeObserver(() => measure())
          observer.observe(partsRef.current)
        }
        return () => {
          window.removeEventListener('resize', measure)
          observer?.disconnect()
        }
      }, [mounted])

      /*
       * Anchor the fixed drawer just above the trigger, then align the LAST DATA COLUMN's
       * right edge with the pill's, not the two box edges. The pill pads its content by
       * 8px while the drawer stacks its own 16px padding with a row's 6px, so matching
       * outer boxes would leave the numbers visibly inset by the 14px difference.
       *
       * `right` is used rather than `left` so the alignment survives the pill changing
       * width while a response streams.
       */
      useLayoutEffect(() => {
        if (!mounted) return undefined
        const place = () => {
          const anchor = triggerRef.current
          const panel = drawerRef.current
          if (anchor === null) return
          const rect = anchor.getBoundingClientRect()
          const width = Math.min(
            panel === null ? 560 : panel.offsetWidth,
            Math.max(0, window.innerWidth - 24),
          )
          // Distance from the drawer's box edge to its last column, and from the pill's
          // box edge to its last figure: both are padding, and aligning the FIGURES (not
          // the boxes) is what the eye reads as "the same column".
          const inset = panel === null ? DRAWER_INSET : drawerContentInset(panel)
          const pillPad = pillContentInset(anchor)
          // Align the content edges; the clamp keeps the whole box inside the viewport.
          const wanted = window.innerWidth - (rect.right - pillPad) - inset
          const right = Math.min(
            Math.max(wanted, 12 - inset),
            Math.max(12 - inset, window.innerWidth - width - 12),
          )
          const bottom = Math.max(12, window.innerHeight - rect.top + 8)
          const maxHeight = Math.max(180, Math.min(window.innerHeight - bottom - 12, 560))
          setPos({ right, bottom, maxHeight })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        /*
         * The first pass can run before the measured column widths have been applied, in
         * which case the panel is still on its `ch` fallback and the inset is measured
         * against the wrong layout. Re-place on the next frame so the final position is
         * computed from the settled grid.
         */
        const frame = requestAnimationFrame(place)
        return () => {
          cancelAnimationFrame(frame)
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [mounted])

      /* Keep the relative times fresh while the drawer is visible. */
      useEffect(() => {
        if (!open) return undefined
        const id = setInterval(() => setNow(Date.now()), 30_000)
        return () => clearInterval(id)
      }, [open])

      /* Escape and an outside pointerdown close the drawer. */
      useEffect(() => {
        if (!pinned) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          setPinned(false)
          triggerRef.current?.focus({ preventScroll: true })
        }
        const onPointerDown = (event) => {
          const target = event.target
          if (drawerRef.current?.contains(target) === true) return
          if (triggerRef.current?.contains(target) === true) return
          setPinned(false)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [pinned])

      const view = useAnimatedRows(rows)

      if (!geek) return null

      const current = live ?? rows[0] ?? null
      const approximate = live !== null || current?.estimated === true
      /*
       * The pill is a plain button with an accessible name and no tooltip: the drawer
       * opens on click only, matching the shipped statistics pill's dialog behaviour.
       */
      const statusLabel =
        current === null
          ? t('statusAria')
          : `${t('statusAria')} · ${t('statusHint', {
              ttft: secondsText(current.ttftMs, t),
              speed: speedText(current.speed, approximate, t),
              tokens: tokensText(current.tokens, approximate, t),
              total: secondsText(current.totalMs, t),
              amortized: speedText(current.amortized, approximate, t),
            })}`

      return h(
        'div',
        { className: 'dsh-rum-anchor' },
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            className: 'dsh-rum-trigger' + (live !== null ? ' dsh-rum-live' : ''),
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': statusLabel,
            onClick: () => {
              setPinned((current) => !current)
            },
          },
          h(BoltIcon, { className: 'dsh-rum-bolt' }),
          h(
            'span',
            { className: 'dsh-rum-parts', ref: partsRef },
            h(
              'span',
              { className: 'dsh-rum-part', 'data-metric': 'ttft' },
              h('span', { className: 'dsh-rum-num' }, durationSlot(current?.ttftMs)),
              h('span', { className: 'dsh-rum-unit' }, DURATION_UNIT),
            ),
            h(
              'span',
              { className: 'dsh-rum-part', 'data-metric': 'speed' },
              h(Tilde, { on: approximate && current?.speed !== null && current?.speed !== undefined }),
              h('span', { className: 'dsh-rum-num' }, speedSlot(current?.speed)),
              h('span', { className: 'dsh-rum-unit' }, SPEED_UNIT),
            ),
            h(
              'span',
              { className: 'dsh-rum-part', 'data-metric': 'tokens' },
              h(Tilde, { on: approximate && current?.tokens !== null && current?.tokens !== undefined }),
              h('span', { className: 'dsh-rum-num' }, tokenSlot(current?.tokens)),
              h('span', { className: 'dsh-rum-unit' }, ' tok'),
            ),
            h(
              'span',
              { className: 'dsh-rum-part', 'data-metric': 'total' },
              h('span', { className: 'dsh-rum-num' }, durationSlot(current?.totalMs)),
              h('span', { className: 'dsh-rum-unit' }, DURATION_UNIT),
            ),
            h(
              'span',
              { className: 'dsh-rum-part', 'data-metric': 'amortized' },
              h(Tilde, { on: approximate && current?.amortized !== null && current?.amortized !== undefined }),
              h('span', { className: 'dsh-rum-num' }, speedSlot(current?.amortized)),
              h('span', { className: 'dsh-rum-unit' }, SPEED_UNIT),
            ),
          ),
        ),
        mounted
          ? portal(
              h(
                'div',
                {
                  ref: drawerRef,
                  className: 'dsh-rum-drawer',
                  'data-open': entered ? 'true' : 'false',
                  role: 'dialog',
                  'aria-label': t('drawerTitle'),
                  /*
                   * The pill's measured cell widths, inherited by every row's grid. A
                   * `--dsh-rum-col-*` custom property each keeps the mapping metric-to-
                   * metric explicit instead of relying on positional luck.
                   */
                  style: {
                    ...(pos === null ? { visibility: 'hidden' } : pos),
                    ...(columnWidths === null
                      ? null
                      : {
                          '--dsh-rum-col-ttft': `${columnWidths[0]}px`,
                          '--dsh-rum-col-speed': `${columnWidths[1]}px`,
                          '--dsh-rum-col-tokens': `${columnWidths[2]}px`,
                          '--dsh-rum-col-total': `${columnWidths[3]}px`,
                          '--dsh-rum-col-amortized': `${columnWidths[4]}px`,
                        }),
                  },
                },
              h(
                'div',
                { className: 'dsh-rum-head' },
                h(
                  'span',
                  { className: 'dsh-rum-head-title' },
                  h(BoltIcon, { className: 'dsh-rum-bolt' }),
                  t('drawerTitle'),
                ),
                h(
                  'span',
                  { className: 'dsh-rum-head-count' },
                  live === null ? t('drawerCount', { count: rows.length }) : t('drawerLive'),
                ),
              ),
              h('div', { className: 'dsh-rum-rule', 'aria-hidden': true }),
              live === null && view.length === 0
                ? h('div', { className: 'dsh-rum-empty' }, t('drawerEmpty'))
                : h(
                    'div',
                    { className: 'dsh-rum-list', role: 'table', 'aria-label': t('drawerTitle') },
                    h(
                      'div',
                      { className: 'dsh-rum-row', 'data-head': true, role: 'row' },
                      h(
                        'span',
                        { className: 'dsh-rum-col', role: 'columnheader', 'data-align': 'start' },
                        t('colIndex'),
                      ),
                      h(
                        'span',
                        { className: 'dsh-rum-col', role: 'columnheader', 'data-align': 'start' },
                        t('colTime'),
                      ),
                      h('span', { className: 'dsh-rum-col', role: 'columnheader' }, t('colTtft')),
                      h('span', { className: 'dsh-rum-col', role: 'columnheader' }, t('colSpeed')),
                      h('span', { className: 'dsh-rum-col', role: 'columnheader' }, t('colTokens')),
                      h('span', { className: 'dsh-rum-col', role: 'columnheader' }, t('colTotal')),
                      h('span', { className: 'dsh-rum-col', role: 'columnheader' }, t('colAmortized')),
                    ),
                    live !== null
                      ? h(
                          'div',
                          { className: 'dsh-rum-row dsh-rum-live-row', role: 'row' },
                          h('span', { className: 'dsh-rum-col', role: 'cell' }, ''),
                          h(
                            'span',
                            { className: 'dsh-rum-col', role: 'cell', 'data-align': 'start' },
                            h('span', { className: 'dsh-rum-live-tag' }, t('drawerLive')),
                          ),
                          h('span', { className: 'dsh-rum-col', role: 'cell' }, secondsText(live.ttftMs, t)),
                          h(
                            'span',
                            { className: 'dsh-rum-col dsh-rum-primary', role: 'cell' },
                            speedText(live.speed, true, t),
                          ),
                          h('span', { className: 'dsh-rum-col', role: 'cell' }, tokensText(live.tokens, true, t)),
                          h('span', { className: 'dsh-rum-col', role: 'cell' }, secondsText(live.totalMs, t)),
                          h(
                            'span',
                            { className: 'dsh-rum-col', role: 'cell' },
                            speedText(live.amortized, true, t),
                          ),
                        )
                      : null,
                    view.map((entry) =>
                      h(
                        'div',
                        {
                          key: entry.key,
                          className: 'dsh-rum-row dsh-rum-item',
                          'data-phase': entry.phase,
                          role: 'row',
                        },
                        h('span', { className: 'dsh-rum-index', role: 'cell' }, String(entry.index + 1)),
                        h(
                          'span',
                          { className: 'dsh-rum-clock', role: 'cell', title: agoText(entry.row.at, now, t) },
                          clockText(entry.row.at),
                        ),
                        h('span', { className: 'dsh-rum-col', role: 'cell' }, secondsText(entry.row.ttftMs, t)),
                        h(
                          'span',
                          { className: 'dsh-rum-col dsh-rum-primary', role: 'cell' },
                          speedText(entry.row.speed, false, t),
                        ),
                        h(
                          'span',
                          { className: 'dsh-rum-col', role: 'cell' },
                          tokensText(entry.row.tokens, entry.row.estimated, t),
                        ),
                        h('span', { className: 'dsh-rum-col', role: 'cell' }, secondsText(entry.row.totalMs, t)),
                        h(
                          'span',
                          { className: 'dsh-rum-col', role: 'cell' },
                          speedText(entry.row.amortized, entry.row.estimated, t),
                        ),
                      ),
                    ),
                  ),
                /* A rule separates the history from its summary, so the average is not
                 * mistaken for an eleventh request. */
                view.length > 0
                  ? h('div', { className: 'dsh-rum-average-rule', 'aria-hidden': true })
                  : null,
                view.length > 0 ? h(AverageRow, { rows: view.map((entry) => entry.row), t }) : null,
              ),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* Activation                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Drop dictionaries an earlier generation of this module registered. The disposer
     * is parked on `globalThis` because an HMR reload resets this module's scope while
     * the previous claim can still be live.
     */
    function releaseDictionaries() {
      const host = typeof globalThis !== 'undefined' ? globalThis : undefined
      if (host === undefined) return
      const previous = host[DISPOSER_KEY]
      if (typeof previous !== 'function') return
      delete host[DISPOSER_KEY]
      try {
        previous()
      } catch {
        // A torn-down generation may already have run it; the new claim below wins.
      }
    }

    function apply(ctx) {
      const model = createModel()
      /*
       * `locale` is a HARD dependency (declared in the returned `inject`), so the service
       * is guaranteed present here. Probing with `ctx.get('locale')` was a real defect:
       * the locale plugin itself waits on the connection, settings and remotes services,
       * so on a cold page this plugin could apply first, read `undefined`, never register
       * its dictionaries, and then render through a dictionary-less `t` — English (or raw
       * keys) that stayed English even after switching the language back.
       */
      const locale = ctx.locale

      ctx.effect(() => {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE_TEXT
        document.head.append(style)
        return () => {
          style.remove()
        }
      }, 'dsh-recent-usage-metrics: style')

      ctx.effect(() => {
        releaseDictionaries()
        const dispose = locale.register(NS, { zh, en })
        const host = typeof globalThis !== 'undefined' ? globalThis : undefined
        if (host !== undefined) host[DISPOSER_KEY] = dispose
        return () => {
          const owner = host !== undefined && host[DISPOSER_KEY] === dispose
          if (owner) delete host[DISPOSER_KEY]
          if (owner) dispose()
        }
      }, 'dsh-recent-usage-metrics: zh/en strings')

      /*
       * `configForms` is optional: a profile may compose this bundle without the settings
       * domain. `ctx.inject` waits for it instead of probing once at apply time, so a cold
       * page cannot latch the row onto the fallback preference for the whole session.
       */
      const preference = createPreference()
      ctx.effect(() => () => preference.dispose(), 'dsh-recent-usage-metrics: preference teardown')
      ctx.effect(
        () =>
          ctx.inject(['configForms'], (scope) => {
            let form = null
            try {
              form = scope.configForms.get(CHAT_NS)
            } catch {
              form = null
            }
            preference.bind(form)
            return () => preference.bind(null)
          }),
        'dsh-recent-usage-metrics: shipped preference mirror',
      )

      /* The replacement row: same cell id and order, lower priority so it wins. */
      ctx.effect(
        () =>
          ctx.slots.inject('settings.general.item', () =>
            ctx.slots.register(
              {
                name: 'settings.general.item',
                id: NATIVE_ROW_ID,
                order: 30,
                priority: -1,
                locale: NS,
                label: () => locale.bind(NS)('settingsTitle'),
                inject: () => ({
                  hooks: {
                    performanceUsage: preference.source,
                    geek: { getSnapshot: model.getMode, subscribe: model.subscribe },
                  },
                  setPerformanceUsage: (value) => preference.set(value),
                  setGeek: (value) => model.setMode(value),
                }),
              },
              PerformanceUsageRow,
            ),
          ),
        'dsh-recent-usage-metrics: performance row',
      )

      /* The live reading and its drawer, left of the shipped status pills. */
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'recent-usage-metrics',
                order: -10,
                locale: NS,
                label: () => locale.bind(NS)('drawerTitle'),
                inject: () => ({
                  hooks: {
                    geek: { getSnapshot: model.getMode, subscribe: model.subscribe },
                    rows: { getSnapshot: model.getRows, subscribe: model.subscribe },
                  },
                  record: (reading) => model.record(reading),
                  seed: (readings) => model.seed(readings),
                  backfill: (rows) => model.backfill(rows),
                }),
              },
              GeekStatus,
            ),
          ),
        'dsh-recent-usage-metrics: composer status',
      )
    }

    return {
      name: 'dsh-recent-usage-metrics',
      /*
       * `locale` is required, not optional. Its absence on a cold page is what produced
       * the reported post-restart failure: English (or raw keys) that never switched
       * back, because the dictionaries were silently never registered.
       */
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
