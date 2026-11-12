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
    /** Drawer capacity: the newest settled requests it lists. */
    /*
     * The version this bundle was built from.
     *
     * Kept in the source rather than read from package.json: the page has no filesystem access,
     * and a stale value here is exactly what the header tooltip exists to expose — so it has to
     * be visible in the file that actually ships.
     */
    const VERSION = '0.7.9'

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
      /* Which build is loaded. A stale bundle is otherwise indistinguishable from a fresh one. */
      versionHint: '版本 {version}',
      drawerCount: '最近 {count} 条',
      drawerEmpty: '还没有完成的请求。发一条消息后，它的指标会出现在这里。',
      drawerLive: '生成中',
      drawerTools: '调用工具中',
      drawerCompacting: '上下文压缩中',
      drawerCompacted: '上下文压缩完成',
      interrupted: '中断',
      /*
       * The compaction phase has no model of its own until it finishes: `compaction/start`
       * records only an id and a turn, and `compaction/summary` is what reports the model. While
       * it runs, the summarizer reuses the routed model of the last request, so that is what the
       * row can honestly say — falling back to this general wording when even that is unknown.
       */
      compactionSpeed: '压缩上下文',
      usingChatModel: '使用对话模型',
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
      // Column-header hints. `{bolt}` / `{tools}` / `{compact}` are replaced by the glyphs
      // themselves, which is why these are rendered by the tooltip component and not by title.
      /*
       * The index hint is three lines: what the column holds, what the glyphs mean, then what
       * the row colours mean. Splitting them keeps each line short enough to read at a glance
       * instead of being one long sentence the eye has to parse.
       */
      hintIndexRows: '行号：1–10 为已完成的最近记录',
      hintIndexGlyphs: '{bolt} 为模型输出中，{tools} 为工具调用中，{compact} 为压缩上下文中',
      hintColour: '整行黄色表示缓存命中过低，蓝色表示这一步切换了模型',
      /* The row-number hint: only a highlighted row carries one, and it says why in numbers. */
      rowSwitched: '该行切换模型至：{model}',
      rowLowCache: '缓存命中 {rate}，低于 {threshold}%',
      rowConfigChanged: '该行请求配置变更（工具集 {from}→{to}）',
      rowConfigChangedUnknown: '该行请求配置变更，缓存前缀失效',
      /* A running tool call, shared by the marker and the total column. */
      toolRunningHint: '正在调用工具 {name} · 已用 {elapsed} s',
      /* The bolt marker: what the live row is doing, and for how long. */
      liveWritingHint: '正在生成 · {model} · 已用 {elapsed} s',
      liveWritingNoModelHint: '正在生成 · 已用 {elapsed} s',
      /* A blue live row switched models on this very request. */
      liveSwitchedHint: '已切换至 {model} · 已用 {elapsed} s',
      liveSwitchedNoModelHint: '已切换模型 · 已用 {elapsed} s',
      /* The compaction bars: which model is summarising, and for how long. */
      liveCompactingHint: '正在使用 {model} 压缩，已用 {elapsed} s',
      /*
       * The idle pill's hint. It reports only what the pill cannot show: the other five figures are
       * already on screen, so repeating them would waste the one line available.
       */
      pillStep: '第 {step} 步',
      /* The numbered row's own position, which the list index cannot express. */
      stepPosition: '第 {turn} 轮第 {step} 步',
      stepPositionShort: '第 {step} 步',
      rowCompactionPosition: '第 {turn} 轮 · 压缩',
      pillModel: '{provider} / {model}',
      pillInput: '输入 {input}',
      pillCache: '缓存命中 {hit}',
      pillTools: '调用工具 {count} 次 {elapsed}',
      pillToolsNone: '调用工具 0 次',
      /* One separator for every part, so the line reads as a list rather than a sentence. */
      pillSep: '  ·  ',
      toolRunningUnnamed: '工具',
      hintTime: '请求发出的时刻（本地时间）',
      hintTtft: '从发出到收到第一个 token 的耗时',
      hintSpeed: '模型生成速度 = 输出 token ÷ 解码时长',
      hintTokens: '模型本次生成的 token 数',
      hintTotal: '请求耗时：从发出请求一直到模型输出结束，不含工具调用时间',
      hintAmortized: '输出 token ÷ 总用时，包含请求时间和响应时间，更加能表明本地到模型输出完整链路的速度',
      tokensHint: '输入 {input} · 缓存命中 {hit}',
      toolHintOne: '工具调用 {count} 次 · {total}',
      toolHintTwo: '工具调用 {count} 次 · 串行 {total} · 并行合并 {wall}',
      toolHintNone: '无工具调用',
      toolHintCompaction: '压缩上下文不计工具时间',
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
      versionHint: 'version {version}',
      drawerCount: 'Last {count}',
      drawerEmpty: 'No completed requests yet. Send a message and its metrics appear here.',
      drawerLive: 'Streaming',
      drawerTools: 'Calling tools',
      drawerCompacting: 'Compacting context',
      drawerCompacted: 'Context compacted',
      interrupted: 'Interrupted',
      compactionSpeed: 'Compaction',
      usingChatModel: 'Chat model',
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
      hintIndexRows: 'Row number: 1–10 are the most recent finished records',
      hintIndexGlyphs: '{bolt} is a model reply, {tools} is a tool call, {compact} is a context compaction',
      hintColour: 'A yellow row means a low cache hit; a blue row means this step switched models',
      rowSwitched: 'This row switched to {model}',
      rowLowCache: 'Cache hit {rate}, below {threshold}%',
      rowConfigChanged: 'Request configuration changed on this row (tools {from}→{to})',
      rowConfigChangedUnknown: 'Request configuration changed on this row; the cached prefix was lost',
      toolRunningHint: 'Calling {name} · {elapsed} s elapsed',
      liveWritingHint: 'Writing · {model} · {elapsed} s elapsed',
      liveWritingNoModelHint: 'Writing · {elapsed} s elapsed',
      liveSwitchedHint: 'Switched to {model} · {elapsed} s elapsed',
      liveSwitchedNoModelHint: 'Switched models · {elapsed} s elapsed',
      liveCompactingHint: 'Compacting with {model}, {elapsed} s elapsed',
      pillStep: 'step {step}',
      stepPosition: 'turn {turn}, step {step}',
      stepPositionShort: 'step {step}',
      rowCompactionPosition: 'turn {turn} · compaction',
      pillModel: '{provider} / {model}',
      pillInput: 'Input {input}',
      pillCache: 'cache hit {hit}',
      pillTools: 'called {count} tools · {elapsed}',
      pillToolsNone: 'called no tools',
      pillSep: '  ·  ',
      toolRunningUnnamed: 'a tool',
      hintTime: 'When the request was issued (local time)',
      hintTtft: 'Time from issuing the request to receiving its first token',
      hintSpeed: 'Generation speed = output tokens ÷ decode time',
      hintTokens: 'Tokens this reply generated',
      hintTotal: 'Request time: from issuing the request until the model finished replying, not counting tool calls',
      hintAmortized: 'Output tokens ÷ total time, including both queueing and response — the throughput of the whole local-to-model path',
      tokensHint: 'Input {input} · cache hit {hit}',
      toolHintOne: 'Tool calls: {count} · {total}',
      toolHintTwo: 'Tool calls: {count} · serial {total} · parallel-merged {wall}',
      toolHintNone: 'No tool calls',
      toolHintCompaction: 'A compaction spends no time on tools',
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
  /*
   * These three numbers mirror the drawer row so the two rows can line up: the row insets 6px,
   * gives its number column 18px, then leaves a 10px gap before the clock. The pill spends the
   * same 34px before its own clock — icon slot included, since the status line has no number.
   */
  gap: 10px;
  max-width: 100%;
  padding: 1px 8px 1px 6px;
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
/*
 * The slot, not the glyph, is what aligns. All three markers — the bolt, the T and the
 * compaction bars — sit in the same 18px box, so swapping phases never shifts the clock
 * column underneath it.
 *
 * The glyph hugs the LEFT of that slot, matching the drawer: its number column is a flex box
 * with justify-content: flex-start, and the markers it shows (the T, the compaction bars) hug
 * the same edge. Centring here instead would push the icon 2px right — the slot would still
 * line up while the drawing inside it did not, which is the same trap the clock column fell
 * into.
 */
.dsh-rum-trigger > svg,
.dsh-rum-trigger > .dsh-rum-compact-anchor {
  flex: none;
  /*
   * 11px, the same size the drawer number cell uses for its own markers.
   *
   * An earlier version tried to give this an 18px slot with the glyph inside it, but wrote
   * that slot and the glyph as two rules with the SAME selector — so the later width won and
   * the box simply became 11px. One element cannot be both slot and content; the width here
   * is the drawing, and the space around it comes from the trigger padding and gap.
   *
   * The 1px nudge is optical, not structural. A plain row shows a DIGIT in the drawer, and a
   * digit starts at the very edge of its cell; the bolt is an svg whose viewBox has 3.4 units
   * of empty space before the path begins, so its ink sits slightly right of where a digit
   * would. Pulling the svg 1px left puts the INK, not the box, under the same edge.
   */
  width: 11px;
  height: 11px;
  margin-left: -1px;
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
/*
 * The clock sits where the drawer puts it, at the same 56px, so the two rows line up column
 * for column.
 *
 * It also has to be aligned the same way INSIDE that slot. The drawer clock is a plain grid
 * child with text-align: left, so its digits hug the left edge; this one is an inline-flex
 * cell, whose default is to centre. With identical slots but different alignment, the two
 * read as offset by half a column even though every box matches to the pixel — measured at
 * left 562.3 / right 618.3 on both sides, yet the text landed ~14px apart.
 */
.dsh-rum-part-clock {
  flex: none;
  width: 56px;
  justify-content: flex-start;
  text-align: left;
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
    /*
     * The clock column repeats the pill's measured width, so a drawer row sits exactly under
     * the status line it describes. 56px is only the fallback for the frame before measurement
     * lands, and for a detached tree.
     */
    var(--dsh-rum-col-clock, 56px)
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
/*
 * A highlighted row colours EVERY cell, not just the ones that inherit.
 *
 * The index, clock and primary cells each set their own colour, so without this they stay
 * grey inside a blue or yellow row and the highlight reads as a stray word rather than as a
 * whole row. Their own rules stay in place for every unhighlighted row.
 *
 * The specificity is deliberately higher than each of those cell rules: one class plus two
 * attribute selectors beats a plain class selector.
 */
.dsh-rum-item[data-switched="true"] .dsh-rum-col,
.dsh-rum-item[data-switched="true"] .dsh-rum-index,
.dsh-rum-item[data-switched="true"] .dsh-rum-clock {
  color: inherit;
}
.dsh-rum-item[data-lowcache="true"] .dsh-rum-col,
.dsh-rum-item[data-lowcache="true"] .dsh-rum-index,
.dsh-rum-item[data-lowcache="true"] .dsh-rum-clock {
  color: inherit;
}
/*
 * The index cells are flex boxes so a row number and the streaming dot share one alignment
 * rule. With inline content, a 6px dot aligned on the text baseline sits visibly lower than
 * a digit: the baseline is the bottom of the glyph, while the dot has no descender. Centring
 * both on the same line box is what makes the dot appear level with "1", "2", "3".
 */
.dsh-rum-index {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-height: 1.4em;
}
/*
 * The row-number cell is 18px wide, which is a small target for a hover — the hint it carries
 * explains a highlight in a full sentence and is easy to miss if the pointer must land on a
 * digit.
 *
 * A transparent pseudo-element extends the hit area without touching the grid: the column keeps
 * its 18px, so every other column stays exactly where it is and the drawer's width does not move.
 *
 * Horizontal: 22px to the left reaches the drawer's own edge (16px of drawer padding plus the
 * row's 6px), and 6px to the right stops short of the time column so that column keeps its own
 * target.
 *
 * Vertical: none. The row is 24.8px tall with a 1px margin, so anything above 0.5px per side makes
 * two neighbours overlap, and the later row wins that band — the pointer would show the wrong
 * hint. Four pixels each way overlapped by 7px, a quarter of a row. The cell already spans the
 * full row height, so the vertical extension was buying very little and costing correctness.
 *
 * The event still bubbles from the pseudo-element to the cell that owns the handler, and
 * getBoundingClientRect on that cell is unchanged, so the box is drawn in the same place.
 */
.dsh-rum-index {
  position: relative;
}
/* Only a cell that actually has something to say advertises it. */
.dsh-rum-index[data-hint="true"] {
  cursor: help;
}
.dsh-rum-index::after {
  content: '';
  position: absolute;
  inset: 0 -6px 0 -22px;
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
/*
 * Two reasons a finished row is worth a second look.
 *
 * Both use the theme's own state tokens, never a literal colour, so they follow dark mode and
 * any future palette change. The text colour carries the meaning; the left bar makes the row
 * findable when the drawer is scanned rather than read.
 *
 * Cache-outranks-switch: a cold prompt is a performance fact the user can act on, while a model
 * change is context. When both are true the warn colour wins and the bar keeps the business
 * colour, so neither signal is lost.
 */
.dsh-rum-item[data-switched="true"] {
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
}
.dsh-rum-item[data-lowcache="true"] {
  color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warn-label));
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warn-label));
}
/* The bar keeps the switch signal when a cold prompt outranks it in the text. */
.dsh-rum-item[data-switched="true"][data-lowcache="true"] {
  color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warn-label));
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
}
/*
 * The streaming marker: the same bolt the status pill pulses, sized for the index column.
 *
 * It shares the pill's dsh-rum-pulse keyframes, so the two markers breathe in step instead
 * of one fading while the other sits still.
 */
.dsh-rum-live-bolt {
  width: 11px;
  height: 11px;
  flex: none;
  color: var(--dsw-alias-brand-primary);
  animation: dsh-rum-pulse 1.4s ease-in-out infinite;
}
/*
 * The tool-phase marker.
 *
 * Same box and same pulse as the bolt, so the pill does not shift when the state changes — only
 * the glyph inside changes. The colour is the state blue rather than the brand blue so the two
 * phases remain distinguishable for a reader who cannot see which shape is drawn.
 */
.dsh-rum-tool-icon {
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
}
/*
 * The compaction marker.
 *
 * Shares the bolt's box and pulse so switching phases never moves the pill; only the glyph
 * inside changes. The colour is deliberately its own — the three phases must stay apart for a
 * reader who cannot tell the shapes apart.
 */
.dsh-rum-compaction-icon {
  color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary));
}
/* A finished compaction keeps its glyph but stops breathing, so "done" looks settled. */
.dsh-rum-still {
  animation: none;
}
/*
 * The compaction reading replaces the five metric slots with a clock, a model, the wording and
 * a running span.
 *
 * The button reserves the width the idle layout needs, measured once and refreshed on resize.
 * Every segment inside is either fixed-width or clipped, so no value can grow the pill while
 * it is showing — the composer below would shift on each tick otherwise.
 */
.dsh-rum-compact-anchor {
  min-width: var(--dsh-rum-pill-width, auto);
}
.dsh-rum-compact-parts {
  align-items: baseline;
  gap: 8px;
}
.dsh-rum-compact-clock {
  flex: none;
  font-variant-numeric: tabular-nums;
}
.dsh-rum-compact-model {
  /*
   * The model name is the only segment whose length is unknown, so it absorbs the slack and
   * truncates. Without the cap a long provider/model pair would push the wording out of the
   * pill and the drawer's own edge would no longer line up with it.
   */
  flex: 0 1 auto;
  max-width: 18ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-rum-compact-span {
  /* "12.3" up to "999.9": five characters plus the decimal point, reserved. */
  width: 5.5ch;
}
/*
 * The hover hint.
 *
 * Fixed on the body so no scroll container can clip it, above the anchor by default. The
 * surface is the same menu material the drawer uses, so the hint cannot look foreign beside it.
 */
.dsh-rum-tip {
  position: fixed;
  z-index: 2147483100;
  max-width: 320px;
  /*
   * No floor here. This class is shared by every hint, and a global min-width would stretch a
   * four-character header hint to the width chosen for the pill's two-line reading. A floor is
   * only wanted where a hint's own width varies between readings; see data-wide below.
   */
  padding: 7px 9px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l1, transparent);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  box-shadow: var(--dsw-elevation-prominent, 0 6px 20px rgba(0, 0, 0, .28));
  transform: translateY(-100%);
  margin-top: -8px;
  pointer-events: none;
  white-space: normal;
}
/*
 * The pill's idle hint is two lines whose width depends on the model name and the tool count,
 * so it alone asks for a floor: without one the box would resize between readings.
 */
.dsh-rum-tip[data-wide="true"] {
  min-width: 240px;
}
/* The glyphs the index hint names, drawn inline so the hint can show them rather than spell them. */
.dsh-rum-tip svg {
  width: 10px;
  height: 10px;
  vertical-align: -1px;
  margin: 0 1px;
}
.dsh-rum-tip .dsh-rum-tip-icon {
  color: var(--dsw-alias-brand-primary);
}
/*
 * The index hint is two lines: what the glyphs mean, then what the row colours mean.
 *
 * The colour line leads with two swatches instead of naming the hues, so a reader matches a
 * row against the legend by colour rather than by translating a word. The swatches take the
 * same tokens the rows take, so the two can never disagreement.
 */
.dsh-rum-tip-body {
  display: block;
}
.dsh-rum-tip-line {
  display: block;
}
.dsh-rum-tip-line + .dsh-rum-tip-line {
  margin-top: 5px;
}
.dsh-rum-tip-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 3px;
  vertical-align: 0;
}
.dsh-rum-tip-swatch + .dsh-rum-tip-swatch {
  margin-left: 6px;
}
.dsh-rum-tip-swatch[data-hue="lowcache"] {
  background: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warn-label));
}
.dsh-rum-tip-swatch[data-hue="switched"] {
  background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
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
        // The clock reads the step's own start, matching the statistics-derived rows: a
        // row means "when this request was issued", not when it finished.
        at: start ?? end ?? Date.now(),
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

    /**
     * The session statistics target, which the shipped Statistics view reads.
     *
     * That view's own per-step derivation is `firstToken − step/start`, so reading the same
     * target makes this drawer's figures agree with it by construction instead of by a
     * parallel calculation that has to be kept in step. Its steps also carry the figures
     * this drawer never derived itself (model time, decode time, tool time).
     *
     * `target()` hands back `{ getSnapshot, subscribe }`, and a target stays undefined until
     * something subscribes — activation is permanent and shared, so one subscription at
     * apply time is enough and does not add a second fold alongside the Statistics view.
     */
    const STATS_TARGET = 'stats'

    /** The steps the statistics target currently holds, oldest first. */
    function statsSteps(statsSnapshot) {
      const turns = statsSnapshot?.turns
      if (!Array.isArray(turns)) return []
      const steps = []
      for (const turn of turns) {
        if (turn === null || typeof turn !== 'object') continue
        if (!Array.isArray(turn.steps)) continue
        for (const step of turn.steps) {
          if (step === null || typeof step !== 'object') continue
          if (typeof step.turn !== 'number' || typeof step.step !== 'number') continue
          steps.push({ turn: step.turn, step: step.step, metrics: step })
        }
      }
      steps.sort((left, right) =>
        left.turn === right.turn ? left.step - right.step : left.turn - right.turn,
      )
      return steps
    }

    /**
     * One drawer row from a statistics step.
     *
     * The statistics step already carries `ttft`, `model`, `decode`, `tps`, `output` and
     * `wall`, computed by the shipped fold from the durable log — the very figures the
     * Statistics view renders. `null` means that figure is genuinely unavailable for the
     * step (a cancelled request assembles no message, for one), so it stays null rather
     * than becoming a zero the drawer would print as if it were measured.
     *
     * The row's clock is `startTime` (the `step/start` event), matching the Statistics
     * view: a row means "when this request was issued". Using `endTime` instead would
     * contradict the total beside it — a row stamped 13:59:15 with a 11.4 s total finished
     * at 13:59:26, yet read as having happened at 13:59:15 — and would order the list by
     * completion rather than by issue.
     */
    function readingOfStatsStep(entry) {
      const stats = entry.metrics
      /*
       * A step the fold marks aborted ended without a settled reply: the user stopped it, or the
       * upstream failed mid-request. Either way there is no `messageTime`, so `model`, `decode`
       * and `tps` are all null and the row would be entirely blank.
       */
      const interrupted = stats.aborted === true || stats.interrupted === true
      const wallMs = numberOrNull(stats.wall)
      /*
       * The first-token column of an interrupted request.
       *
       * The live reading counts up from the moment the request was issued, so a stopped request
       * did have a first-token figure on screen — it simply never landed in the log as `ttft`,
       * because the fold only writes that once a first token actually arrived. Two cases:
       *
       * - No first token ever came: the counter was still running when the request stopped, so
       *   the figure it showed was the elapsed span. `wall` is that span, and reporting it keeps
       *   the column honest instead of printing a dash for a request that demonstrably waited.
       * - A first token did arrive: `ttft` is set and frozen, so the row keeps the real value,
       *   which is smaller than the total — exactly the ordering the user expects to see.
       */
      const ttftMs = numberOrNull(stats.ttft) ?? (interrupted ? wallMs : null)
      /*
       * The drawer's "total" is the Statistics view's MODEL time, not its wall time.
       *
       * `wall` is `endTime - startTime`, which also contains the step's tool calls: a step that
       * thinks for 11.5 s and then runs a 31 s command reports `wall` 41.9 s but `model` 11.5 s.
       * The drawer answers "how long did this request take to answer", so it reports `model` —
       * and that figure is final the moment the reply lands, which is why it must not climb
       * while tools run.
       *
       * An interrupted step has no `model` at all, so it falls back to `wall`. That is the
       * figure the user actually wants there: how long the request ran before it was stopped.
       * It is a log fact — `endTime - startTime` — so it survives a reload unchanged, unlike
       * the live reading, which is recomputed and lost.
       */
      const totalMs = numberOrNull(stats.model) ?? (interrupted ? wallMs : null)
      const tokens = numberOrNull(stats.output)
      const speed = numberOrNull(stats.tps)
      return {
        key: `${entry.turn}:${entry.step}`,
        /* The position, for the number hint: a list index says nothing about where it sits. */
        turn: numberOrNull(entry.turn),
        step: numberOrNull(entry.step),
        at: numberOrNull(stats.startTime) ?? numberOrNull(stats.endTime),
        startMs: numberOrNull(stats.startTime),
        ttftMs,
        interrupted,
        totalMs,
        /*
         * `0` is a real measurement, so an unreported count must stay `null` and print the
         * drawer's placeholder. Coercing it to zero would render "0 tok" for a step that is
         * still running, and `estimated` would then falsely claim a character estimate.
         */
        tokens,
        estimated: false,
        speed,
        amortized:
          tokens !== null && tokens > 0 && totalMs !== null && totalMs > 0
            ? tokens / (totalMs / 1000)
            : null,
        /*
         * The model that answered, and the input-side accounting, all for tooltips. The fold
         * does not put a provider/model on a step — it only carries them for a compaction — so
         * the caller fills these from the chat snapshot's own assistant nodes.
         */
        model: null,
        provider: null,
        context: numberOrNull(stats.context),
        cacheRead: numberOrNull(stats.cacheRead),
        /*
         * Tool time, for the total column hint. `tool` sums each call from its dispatch to its
         * result, so three parallel 10 s tools report 30 s; `toolWall` unions the intervals, so
         * the same three report 10 s. Both are reported because the gap between them is exactly
         * how much the parallelism bought.
         */
        toolMs: numberOrNull(stats.tool),
        toolWallMs: numberOrNull(stats.toolWall),
        /** How many calls the step made, from the fold's own call list. */
        toolCalls: Array.isArray(stats.calls) ? stats.calls.length : null,
        cacheHit: numberOrNull(stats.cacheHit),
      }
    }

    /**
     * Whether a statistics step has produced anything worth a drawer row yet.
     *
     * A step exists from `step/start`, but reports nothing until its first token arrives,
     * and `endTime` only lands on `step/end` — after the model turn and its tool calls. A
     * step with no first-token latency yet is therefore the one the pill already shows as
     * "streaming": it has no row of its own, or the drawer would print an empty `#1` for it
     * while the live row above reports the same request.
     *
     * `ttft` is the figure that appears exactly when the first token arrives, so it is the
     * signal for "has anything happened".
     */
    /**
     * Whether a statistics step reports anything at all.
     *
     * A step that was cancelled before its first token has no `ttft`, no `output` and no
     * `endTime` on some paths, yet it is still a request the user issued and stopped — it
     * belongs in the drawer, marked as interrupted. Only a step that has not started is
     * excluded.
     */
    function statsStepHasFigures(metrics) {
      return (
        numberOrNull(metrics.ttft) !== null ||
        numberOrNull(metrics.output) !== null ||
        numberOrNull(metrics.endTime) !== null ||
        metrics.interrupted === true ||
        metrics.aborted === true
      )
    }

    /**
     * A compaction transaction as a drawer row.
     *
     * Compaction is not a step: it lives on `turn.compactions[]`, opened by `compaction/start`
     * and closed by `compaction/end`, and it never produces an `assistant/message`. So it has
     * no first token, no decode span and no generation rate — the three columns that depend on
     * a settled reply stay empty, and the speed column says what is happening instead.
     *
     * What it does have is a wall-clock span, which is the figure the user wants: how long the
     * summarization ran. While it runs, `endTime` is null and the drawer counts up from
     * `startTime`; once it lands, `wall` freezes the same span.
     */
    function readingOfCompaction(compaction) {
      const startMs = numberOrNull(compaction.startTime)
      const wallMs = numberOrNull(compaction.wall)
      const running = compaction.running === true
      const tokens = numberOrNull(compaction.output)
      return {
        key: `compaction:${compaction.compactionId}`,
        compaction: true,
        compactionId: compaction.compactionId,
        /* A compaction has a turn but no step, which is exactly what its hint reports. */
        turn: numberOrNull(compaction.turn),
        step: null,
        running,
        at: startMs,
        startMs,
        // A compaction has no first token, so the column is always the dash.
        ttftMs: null,
        interrupted: false,
        totalMs: running ? null : wallMs,
        tokens,
        estimated: false,
        speed: null,
        /*
         * The amortised figure a compaction can report is `output ÷ wall` — the throughput of
         * the whole summarization call, which includes replaying the conversation prefix. It
         * is not the decode rate an ordinary row reports, but it is a real measurement of this
         * transaction, so it is shown as-is rather than hidden behind the estimate marker.
         */
        amortized:
          !running && tokens !== null && tokens > 0 && wallMs !== null && wallMs > 0
            ? tokens / (wallMs / 1000)
            : null,
        /** Which model summarised. Only `compaction/summary` reports it, so it lands at the end. */
        model: typeof compaction.model === 'string' && compaction.model !== '' ? compaction.model : null,
        provider:
          typeof compaction.provider === 'string' && compaction.provider !== '' ? compaction.provider : null,
        /** Input-side accounting, for the tokens column's tooltip. */
        context: numberOrNull(compaction.context),
        cacheRead: numberOrNull(compaction.cacheRead),
        cacheHit: numberOrNull(compaction.cacheHit),
        shadowedTokens: numberOrNull(compaction.shadowedTokens),
      }
    }

    /**
     * Every compaction the session fold knows about, oldest first.
     *
     * They are read separately from the steps because they are not steps: `historyFromStats`
     * merges the two streams and orders them by start time, so a compaction lands in the
     * drawer exactly where it happened in the transcript.
     */
    function compactionsFromStats(statsSnapshot) {
      const turns = statsSnapshot?.turns
      if (!Array.isArray(turns)) return []
      const rows = []
      for (const turn of turns) {
        if (!Array.isArray(turn.compactions)) continue
        for (const compaction of turn.compactions) {
          if (typeof compaction?.compactionId !== 'string') continue
          if (numberOrNull(compaction.startTime) === null) continue
          rows.push(readingOfCompaction(compaction))
        }
      }
      return rows
    }

    /**
     * Which model answered each step, keyed `turn:step`.
     *
     * Read from the Trajectory domain's assistant nodes, which carry `providerMetadata` copied
     * straight from `assistant/message.source`. That is the only per-step source of truth the
     * client half can reach:
     *
     * - The statistics fold puts no provider/model on a step, and its `request-header` rows are
     *   written only when the routed model or tool set CHANGES — 24 of them for 3139 requests in
     *   a real session, so they describe about 1% of steps and mislabel the rest.
     * - The Chat snapshot's assistant nodes drop the source entirely.
     *
     * A compaction is not covered here: it has its own `compaction.model`.
     */
    function modelIndexFromTrajectory(trajectorySnapshot) {
      const index = new Map()
      const nodes = trajectorySnapshot?.eventNodes
      if (!Array.isArray(nodes)) return index
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue
        if (node.kind !== 'assistant') continue
        const meta = node.providerMetadata
        if (meta === null || typeof meta !== 'object') continue
        const model = typeof meta.model === 'string' && meta.model !== '' ? meta.model : null
        const provider = typeof meta.provider === 'string' && meta.provider !== '' ? meta.provider : null
        if (model === null && provider === null) continue
        if (typeof node.turn !== 'number' || typeof node.step !== 'number') continue
        index.set(`${node.turn}:${node.step}`, { provider, model, switched: false, source: 'trajectory' })
      }
      return index
    }

    /**
     * Which model a step used, whether that request changed models, and whether it changed the
     * routed configuration at all.
     *
     * A `request/header` is written when the routed configuration changes, and that includes far
     * more than the model: enabling or disabling a plugin changes the tool list, which rewrites
     * the request prefix and invalidates the provider's cache. Measured on a real session, 27
     * headers covered only 7 genuine model switches, so "a header exists" is NOT "the model
     * changed" — treating the two as one flagged every plugin toggle as a model switch.
     *
     * The three signals are therefore separated:
     *
     * - `switched` — a header landed in the step's window AND the model differs from the one
     *   before it. When the previous model is unknown the header is trusted, because there is
     *   nothing to contradict it.
     * - `configChanged` — a header landed in the window but the model did NOT change, so the
     *   change was elsewhere in the configuration (the tool list). Its visible consequence is a
     *   cold cache, which is why it is reported beside the low-cache highlight.
     * - `toolCount` / `previousToolCount` — the tool-list sizes the two headers carried, so the
     *   hint can say what actually moved rather than gesturing at "the configuration".
     */
    function modelPlanFromStats(statsSnapshot, known) {
      const plan = new Map()
      const turns = statsSnapshot?.turns
      if (!Array.isArray(turns)) return plan
      /*
       * The plan walks the session's steps in time order across turns, not turn by turn, because
       * "the previous model" has to compare against the step before it even when that step lives
       * in an earlier turn — a turn's first step is exactly where a switch is most likely.
       */
      const sequence = []
      for (const turn of turns) {
        if (!Array.isArray(turn.steps)) continue
        const headers = []
        if (Array.isArray(turn.events)) {
          for (const event of turn.events) {
            if (event?.kind !== 'request-header') continue
            const at = numberOrNull(event.time)
            if (at === null) continue
            if (typeof event.model !== 'string' && typeof event.provider !== 'string') continue
            headers.push({
              time: at,
              provider: event.provider ?? null,
              model: event.model ?? null,
              tools: numberOrNull(event.toolCount),
            })
          }
          headers.sort((left, right) => left.time - right.time)
        }
        const steps = []
        for (const step of turn.steps) {
          const at = numberOrNull(step.startTime)
          if (at === null || typeof step.step !== 'number') continue
          steps.push({ at, step: step.step })
        }
        steps.sort((left, right) => left.at - right.at)
        for (const step of steps) sequence.push({ turn: turn.turn, step: step.step, at: step.at, headers })
      }
      sequence.sort((left, right) => left.at - right.at)

      /** The model of the step before this one, or null when it is not known. */
      let previousModel = null
      let previousTools = null
      let inForce = null

      for (let index = 0; index < sequence.length; index += 1) {
        const entry = sequence[index]
        const key = `${entry.turn}:${entry.step}`
        const nextAt = index + 1 < sequence.length ? sequence[index + 1].at : Number.POSITIVE_INFINITY
        let inside = null
        for (const header of entry.headers) {
          if (header.time < entry.at) continue
          if (header.time >= nextAt) break
          inside = header
        }

        const settled = known === undefined ? undefined : known.get(key)
        const settledModel =
          settled !== undefined && settled.model !== null
            ? { provider: settled.provider, model: settled.model }
            : null

        if (inside !== null) {
          const headerModel = { provider: inside.provider, model: inside.model }
          const changed =
            previousModel === null ||
            headerModel.model === null ||
            previousModel.model !== headerModel.model ||
            previousModel.provider !== headerModel.provider
          plan.set(key, {
            provider: inside.provider,
            model: inside.model,
            /*
             * A header alone proves only that the routed configuration changed. Saying "the model
             * switched" additionally requires that the model itself differs — and when the
             * previous model is unknown, the header is the only evidence, so it is trusted.
             */
            switched: changed,
            configChanged: !changed,
            toolCount: inside.tools,
            previousToolCount: previousTools,
            source: 'header',
          })
          inForce = headerModel
          previousModel = headerModel
          previousTools = inside.tools
          continue
        }

        /*
         * No header: the step reused what was already routed. A finished reply outranks the
         * carried model, because `assistant/message.source` is the authority for a settled step.
         */
        const resolved = settledModel ?? inForce
        if (resolved !== null) {
          plan.set(key, {
            provider: resolved.provider,
            model: resolved.model,
            switched: false,
            configChanged: false,
            toolCount: null,
            previousToolCount: null,
            source: settledModel !== null ? 'reply' : 'inherit',
          })
          inForce = resolved
          previousModel = resolved
        }
      }
      return plan
    }


    /**
     * Whether any step started after this compaction finished.
     *
     * That is what ends the "just compacted" wording: the fold keeps a compaction record for
     * the life of the session, so its presence alone can never mean "this just happened".
     * A step whose `startTime` is later than the compaction's end is the next request.
     */
    function compactionHadSuccessor(compaction, statsSnapshot) {
      const turns = statsSnapshot?.turns
      if (!Array.isArray(turns)) return false
      const endedAt = numberOrNull(compaction.totalMs) === null ? null : compaction.at + compaction.totalMs
      if (endedAt === null) return false
      for (const turn of turns) {
        if (!Array.isArray(turn.steps)) continue
        for (const step of turn.steps) {
          const start = numberOrNull(step.startTime)
          if (start !== null && start > endedAt) return true
        }
      }
      return false
    }

    /**
     * The newest compaction in a snapshot, or null.
     *
     * The pill and the live row both need one record, not the list, so this picks by start
     * time: a session can compact several times, and only the latest is "what is happening".
     */
    function compactionsOf(statsSnapshot) {
      const all = compactionsFromStats(statsSnapshot)
      if (all.length === 0) return null
      let newest = all[0]
      for (const row of all) if ((row.at ?? 0) > (newest.at ?? 0)) newest = row
      return newest
    }

    /**
     * The newest readings for a session, newest first.
     *
     * A step is included as soon as it has produced a figure, not only once `step/end`
     * arrives. Waiting for `step/end` made the drawer lag the Statistics view by however
     * many steps were mid-flight — that event lands after the model turn *and* its tool
     * calls, so the newest three rows of a busy turn were missing while the Statistics page
     * already listed them.
     *
     * Conversely a step that has produced nothing yet is left out: the live row at the top
     * of the drawer reports that request, and giving it a numbered row as well listed the
     * same request twice, with the numbered one empty.
     *
     * The caller decides how many to keep, because the live step is excluded from the list
     * *after* selection: capping here at ten and then dropping the live step left the drawer
     * showing nine rows for as long as a request was streaming.
     */
    function historyFromStats(statsSnapshot, models) {
      const steps = statsSteps(statsSnapshot)
      /*
       * `models` carries the per-step attribution worked out from the trajectory nodes and the
       * turn's request headers. It answers two questions at once: which model, and whether this
       * request changed it — the drawer colours a row for the second.
       */
      const plan = modelPlanFromStats(statsSnapshot, models)
      const rows = []
      for (const entry of steps) {
        // A step only has a row once it has started; `step/start` is what supplies this.
        if (numberOrNull(entry.metrics.startTime) === null) continue
        if (!statsStepHasFigures(entry.metrics)) continue
        const row = readingOfStatsStep(entry)
        const owner = plan.get(row.key) ?? (models === undefined ? undefined : models.get(row.key))
        if (owner !== undefined) {
          row.model = owner.model
          row.provider = owner.provider
          row.switched = owner.switched === true
          /*
           * A configuration change that was not a model switch still rewrote the request prefix,
           * so it is worth naming when the cache came back cold: that is the difference between
           * "the account changed" and "the tool list moved".
           */
          row.configChanged = owner.configChanged === true
          row.toolCount = owner.toolCount ?? null
          row.previousToolCount = owner.previousToolCount ?? null
        }
        rows.push(row)
      }
      // Compactions are not steps, so they are collected separately and then ordered together.
      for (const row of compactionsFromStats(statsSnapshot)) rows.push(row)
      /*
       * Newest first, by start time. The two streams interleave in real time — a turn can run
       * several steps, compact, then run more — so ordering them by the moment each began is
       * what puts the compaction where it actually happened rather than at either end.
       */
      rows.sort((left, right) => (right.at ?? 0) - (left.at ?? 0))
      return rows
    }

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

    /**
     * The plugin's own state: the durable Geek flag plus this session's newest-first history.
     * One instance per activation; components read it through the injected hook sources and
     * hand it new readings through `replace`.
     */
    function createModel() {
      let mode = readJson(MODE_KEY) === GEEK ? GEEK : null
      /*
       * History is held in memory only, and replaced wholesale from the session's own
       * stats records. Two earlier designs were wrong:
       *
       * - It used to persist to localStorage under one global key, with the row key being
       *   `${turn}:${step}`. Turn and step both restart at 1 in every session, so the row
       *   for one conversation's "1:1" collided with another's — switching conversations
       *   mixed the two, and switching back showed the wrong figures.
       * - It used to seed once and refuse to reseed while non-empty, so the mixed rows
       *   were never repaired.
       *
       * The session log is the authority for these numbers, so the drawer reads them from
       * there and keeps no copy of its own. Nothing survives a page reload, which is
       * correct: the records are rebuilt from the log on the next mount.
       */
      let rows = []
      let sessionId = null
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
        /**
         * Point the model at one session. A different id clears the rows, because the old
         * ones belong to another conversation and would otherwise be read as this one's.
         */
        useSession(next) {
          if (next === sessionId) return
          sessionId = next
          rows = []
          emit()
        },
        /**
         * Replace the whole list with the readings derived from the session's stats.
         *
         * The caller owns the selection (newest first, capped) and the ordering; this only
         * stores what it hands over.
         */
        replace(next) {
          const value = Array.isArray(next) ? next.slice(0, MAX_ROWS) : []
          /*
           * Every rendered figure takes part in the comparison.
           *
           * Comparing only `key` and `ttftMs` skipped the update that matters most: a row
           * whose step moves from running to settled keeps its key, and its first-token time
           * was already known, so the new token count, total and speeds were dropped and the
           * drawer stayed on its placeholders until something else changed.
           */
          const same =
            value.length === rows.length &&
            value.every((row, index) => {
              const previous = rows[index]
              return (
                row.key === previous.key &&
                row.at === previous.at &&
                row.ttftMs === previous.ttftMs &&
                row.totalMs === previous.totalMs &&
                row.tokens === previous.tokens &&
                row.speed === previous.speed &&
                row.amortized === previous.amortized
              )
            })
          if (same) return
          rows = value
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

    /**
     * Cache-hit rate below which a row is worth flagging.
     *
     * Measured over 2921 replies in a real session: the median is 99.9% and the 1st percentile
     * is 92.4%, because a warm conversation re-reads its prefix almost every time. 90% therefore
     * marks a genuinely cold request rather than ordinary variation, and flags only 0.9% of rows.
     * A threshold at 70% would flag 0.6% — nearly the same rows, with less headroom above the
     * noise.
     */
    const LOW_CACHE_HIT = 0.9

    /**
     * Whether a row should be drawn as a low-cache-hit row.
     *
     * Only a REPORTED rate counts. A provider that folds cache reads into its input count (trae
     * does) reports none, and treating "not reported" as "0%" would flag every one of its rows.
     * A compaction is excluded: it already announces itself in the speed column, and its cache
     * figure describes replaying the conversation rather than serving a request.
     */
    function isLowCacheHit(row) {
      if (row.compaction === true) return false
      const rate = numberOrNull(row.cacheHit)
      if (rate === null) return false
      return rate < LOW_CACHE_HIT
    }

    /**
     * A whole token count with thousands separators, for a hover hint.
     *
     * The cell itself has to stay narrow, so it abbreviates (`4.9k tok`). The hint has room, and
     * a reader comparing an input of 370683 against one of 1914 needs the exact digits — `370k`
     * and `371k` would hide the difference.
     *
     * The separator is a comma in both languages this plugin ships, so it is written out rather
     * than derived from the host locale: that keeps the hint identical in zh and en, and avoids
     * depending on a locale tag the slot props do not provide.
     */
    function tokensExact(value, t) {
      if (value === null || value === undefined || !Number.isFinite(value)) return t('none')
      const digits = String(Math.round(Math.abs(value)))
      let grouped = ''
      for (let i = 0; i < digits.length; i += 1) {
        const fromEnd = digits.length - i
        grouped += digits[i]
        if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) grouped += ','
      }
      return t('tokensUnit', { value: value < 0 ? `-${grouped}` : grouped })
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

    /**
     * The tool-phase marker: a capital T.
     *
     * The plugin has two kinds of "busy": the model writing, and the request still in flight
     * while its tools run. The first keeps the bolt; the second gets this, so the two are
     * distinguishable at a glance without reading the numbers.
     *
     * Drawn as a path rather than as text: an svg scales with the pill's icon box and inherits
     * currentColor, so it animates and themes exactly like the bolt beside it.
     */
    function ToolIcon(props) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', className: props.className, 'aria-hidden': true, fill: 'currentColor' },
        /*
         * A capital T sized to sit like the bolt beside it.
         *
         * The bolt's glyph occupies roughly 6.5 x 14 of the 16-unit box — narrow and tall. A
         * full-width T read as heavier at the same 14px svg size and made the pill look like it
         * had grown. The path is therefore inset: a 8.4-wide bar and a 3.0-wide stem, centred,
         * spanning 11.6 vertically. The svg's own box is unchanged, so nothing shifts when the
         * two glyphs swap.
         */
        h('path', {
          d: 'M4.3 3.2h7.4a.8.8 0 0 1 0 1.6H8.5v9.9a.8.8 0 0 1-1.6 0V4.8H4.3a.8.8 0 0 1-.8-.8z',
        }),
      )
    }

    /**
     * The compaction marker: three stacked bars, each shorter than the one above.
     *
     * Chosen over the converging-chevron and arrow-pair candidates because at 14px the three
     * bars keep visible gaps between them, while the pointed shapes blurred into a single
     * blob. It also carries the meaning directly — a long history reduced to a short one.
     *
     * Bar widths and gaps mirror the bolt's vertical extent so the three glyphs (bolt, T,
     * compactor) share one optical size inside the same 14x14 box.
     */
    function CompactionIcon(props) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', className: props.className, 'aria-hidden': true, fill: 'currentColor' },
        h('rect', { x: 2.8, y: 3.1, width: 10.4, height: 2, rx: 1 }),
        h('rect', { x: 4.6, y: 7, width: 6.8, height: 2, rx: 1 }),
        h('rect', { x: 6.5, y: 10.9, width: 3, height: 2, rx: 1 }),
      )
    }

    /**
     * The full timestamp, for the clock column's hint.
     *
     * `MM-DD HH:mm:ss.SSS` — the clock cell itself only has room for the time of day, and the
     * relative wording it replaced ("3 minutes ago") cannot answer which request a row is.
     */
    function absoluteStamp(at) {
      const ms = numberOrNull(at)
      if (ms === null) return ''
      const date = new Date(ms)
      const pad = (value, width) => String(value).padStart(width, '0')
      return (
        `${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)} ` +
        `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.` +
        `${pad(date.getMilliseconds(), 3)}`
      )
    }

    /**
     * The wording for a step whose tools are still running.
     *
     * One sentence serves both places it appears — the T marker's hint and the total column's
     * hint — because they describe the same fact and two phrasings would invite the reader to
     * look for a difference that is not there.
     *
     * A step whose tools have all returned gets nothing: the step has not ended yet, but nothing
     * is running, so calling it "calling tools" would be false.
     */
    function toolRunHint(live, now, t) {
      const run = live?.toolRun
      if (run === undefined || run === null || run.count === 0 || run.since === null) return null
      const elapsed = Math.max(0, now - run.since)
      return t('toolRunningHint', {
        name: run.name === null ? t('toolRunningUnnamed') : run.name,
        elapsed: (elapsed / 1000).toFixed(1),
      })
    }

    /**
     * The live row's marker hint, chosen by what the marker is showing.
     *
     * Three glyphs stand for three situations, and each has something different to say:
     *
     * - the compactor bars already name themselves in the speed column, so the marker stays quiet;
     * - the T is a running tool call, with its name and span;
     * - the bolt is a reply being written. A BLUE bolt is a reply written after a model switch, so
     *   it leads with that, mirroring what a numbered row's number says — the reader hovered the
     *   marker exactly because the row changed colour and wants to know why.
     *
     * The span is measured from the step's own start, the same origin the total column counts
     * from, so the two can never disagree.
     */
    function liveMarkerHint(live, t) {
      if (live === null) return null
      /*
       * The compactor bars name the model doing the summarising and how long it has been at it.
       * They used to stay silent on the grounds that the speed column already said "compaction" —
       * but that column says WHAT is happening, not which model is doing it or for how long, and
       * the three markers should read alike.
       */
      if (live.compaction !== null && live.compaction !== undefined) {
        const span = compactionSpan(live.compaction, Date.now())
        return t('liveCompactingHint', {
          model: compactionModelName(live.compaction, t),
          elapsed: span === null ? '0.0' : (Math.max(0, span) / 1000).toFixed(1),
        })
      }
      if (live.phase === 'tools') return toolRunHint(live, Date.now(), t)
      const elapsed = numberOrNull(live.totalMs)
      const span = elapsed === null ? '0.0' : (Math.max(0, elapsed) / 1000).toFixed(1)
      const model = typeof live.model === 'string' && live.model !== '' ? live.model : null
      if (live.switched === true) {
        return model === null
          ? t('liveSwitchedNoModelHint', { elapsed: span })
          : t('liveSwitchedHint', { model: modelHintText(live, t), elapsed: span })
      }
      return model === null
        ? t('liveWritingNoModelHint', { elapsed: span })
        : t('liveWritingHint', { model: modelHintText(live, t), elapsed: span })
    }


    /**
     * The status pill's hint.
     *
     * While something is happening the pill answers with the same sentence its marker would give —
     * the two views describe one request, and two phrasings would invite a search for a difference
     * that does not exist.
     *
     * When idle the pill shows the newest finished request, and its five figures are already on
     * screen. The hint therefore reports only what the pill cannot: when it ran, which model, how
     * much was fed in, how well the cache did, and what the tools cost. Repeating a figure the
     * reader can see would waste the single line available.
     *
     * A missing figure still gets a slot rather than being dropped. A dash says "the upstream did
     * not report this", which is information; an absent segment says nothing and reads as if the
     * plugin forgot to measure it.
     */
function pillHint(live, base, t, now) {
      if (live !== null) return liveMarkerHint(live, t)
      if (base === null || base === undefined) return null
      /*
       * Two lines, split by meaning rather than by width: the first says which request and who
       * served it, the second says what it cost. Letting the box wrap on its own put the break in
       * the middle of a field, which reads as a mistake.
       */
      const identity = []
      const cost = []
      /*
       * The pill leads with the step, then the moment it ran.
       *
       * The list index cannot say which step this was, and the pill has no other way to say it;
       * the clock cannot say it either, but it answers "when", which the step alone leaves open
       * once the reading is older than the session in front of you. Both fit on one line.
       */
      const stepNo = numberOrNull(base.step)
      const at = numberOrNull(base.at)
      /*
       * The date only earns its width when the reading is not from today. A step from an earlier
       * day is indistinguishable from one just now without it.
       */
      const clock = at === null
        ? t('none')
        : (() => {
            const date = new Date(at)
            const pad = (value) => String(value).padStart(2, '0')
            const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
            const midnight = new Date(now)
            midnight.setHours(0, 0, 0, 0)
            if (at >= midnight.getTime()) return time
            return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
          })()
      identity.push(
        stepNo === null
          ? clock
          : `${t('pillStep', { step: stepNo })} ${clock}`,
      )
      const model = typeof base.model === 'string' && base.model !== '' ? base.model : null
      const provider = typeof base.provider === 'string' && base.provider !== '' ? base.provider : null
      if (model !== null) {
        identity.push(provider === null ? model : t('pillModel', { provider, model }))
      }
      cost.push(t('pillInput', { input: tokensExact(numberOrNull(base.context), t) }))
      const hit = numberOrNull(base.cacheHit)
      cost.push(t('pillCache', { hit: hit === null ? t('none') : `${(hit * 100).toFixed(1)}%` }))
      const calls = numberOrNull(base.toolCalls)
      const toolMs = numberOrNull(base.toolMs)
      if (calls === null || calls === 0) {
        cost.push(t('pillToolsNone'))
      } else {
        cost.push(
          t('pillTools', {
            count: calls,
            elapsed: toolMs === null ? t('none') : `${(Math.max(0, toolMs) / 1000).toFixed(1)} s`,
          }),
        )
      }
      const lineOne = identity.join(t('pillSep'))
      const lineTwo = cost.join(t('pillSep'))
      if (lineTwo === '') return lineOne
      /*
       * The same two-line body the index hint uses, so the drawer and the pill share one layout
       * rule instead of each inventing line spacing.
       */
      return h(
        'span',
        { className: 'dsh-rum-tip-body' },
        h('span', { className: 'dsh-rum-tip-line' }, lineOne),
        h('span', { className: 'dsh-rum-tip-line' }, lineTwo),
      )
    }

    /**
     * The row-number hint, or an empty list when the row is not highlighted.
     * A highlighted row is worth explaining, and the number column is the one place that has room
     * without competing with a figure. Two independent reasons can apply, so the result is a list
     * of lines rather than a sentence:
     *
     * - the model switched, named outright;
     * - the cache came back cold, with the rate and the threshold it fell below.
     *
     * A cold row that ALSO changed its routed configuration names the tool-list movement, because
     * that is the usual cause of a lost prefix and the difference between "the account rotated"
     * and "a plugin was enabled". When the two tool counts are not both known, the line says only
     * that the configuration changed rather than inventing numbers.
     */
    function rowHintLines(row, t) {
      const lines = []
      /*
       * Every row leads with where it sits. The list index cannot answer that: #1 is whichever
       * step is newest, not step one, and two turns can share a list. The position is therefore
       * the hint a plain row gets — it used to get nothing at all, which made the column feel
       * inert outside the two highlight cases.
       */
      const turn = numberOrNull(row.turn)
      const step = numberOrNull(row.step)
      if (row.compaction === true) {
        /* A compaction has a turn but no step, and says so rather than printing a blank. */
        if (turn !== null) lines.push(t('rowCompactionPosition', { turn }))
        return lines
      }
      if (turn !== null && step !== null) {
        lines.push(t('stepPosition', { turn, step }))
      } else if (step !== null) {
        lines.push(t('stepPositionShort', { step }))
      }
      if (row.switched === true) {
        lines.push(t('rowSwitched', { model: modelHintText(row, t) }))
      }
      if (isLowCacheHit(row)) {
        if (row.configChanged === true) {
          const from = numberOrNull(row.previousToolCount)
          const to = numberOrNull(row.toolCount)
          lines.push(
            from !== null && to !== null
              ? t('rowConfigChanged', { from, to })
              : t('rowConfigChangedUnknown'),
          )
        }
        lines.push(
          t('rowLowCache', {
            rate: `${(row.cacheHit * 100).toFixed(1)}%`,
            threshold: Math.round(LOW_CACHE_HIT * 100),
          }),
        )
      }
      return lines
    }

    /**
     * The speed column's hint: which model served this row.
     *
     * A request with no attribution shows the dash rather than a guess. "Chat model" would read
     * as a fact about the request when it is only what the plugin would have assumed, and a
     * wrong model name is worse than none — that is the whole reason this column stopped
     * borrowing `request/header` rows.
     *
     * A compaction is different: it does not "have no model", it has one that is only reported
     * once the summary lands, so while it runs the generic wording is honest.
     */
    function modelHintText(row, t) {
      if (row.compaction === true) return compactionModelName(row, t)
      const model = typeof row.model === 'string' && row.model !== '' ? row.model : null
      const provider = typeof row.provider === 'string' && row.provider !== '' ? row.provider : null
      if (model === null && provider === null) return t('none')
      if (model === null) return provider
      return provider === null ? model : `${provider} / ${model}`
    }

    /**
     * The total column's hint: how much of the request was tool time.
     *
     * Two figures, because they answer different questions. `tool` adds up each call, so it
     * says how much tool work there was; `toolWall` unions the intervals, so it says how much
     * wall time the tools occupied. Three parallel 10 s calls are 30 s of work in 10 s of
     * elapsed time, and the gap is what parallelism bought.
     *
     * Neither is part of the total above, which is model time only — the header says so.
     */
    function toolHintText(row, t) {
      if (row.compaction === true) return t('toolHintCompaction')
      const calls = numberOrNull(row.toolCalls)
      const serial = numberOrNull(row.toolMs)
      if (serial === null && calls === null) return t('toolHintNone')
      if (serial === null) return t('toolHintNone')
      const wall = numberOrNull(row.toolWallMs)
      const count = calls === null ? 0 : calls
      if (wall === null || wall === serial) {
        return t('toolHintOne', { count, total: secondsValue(serial, t) })
      }
      return t('toolHintTwo', {
        count,
        total: secondsValue(serial, t),
        wall: secondsValue(wall, t),
      })
    }

    /** A duration as the hint spells it: seconds, one decimal, no unit label of its own. */
    function secondsValue(ms, t) {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return t('none')
      const seconds = ms / 1000
      const text = seconds < 100 ? seconds.toFixed(1) : String(Math.round(seconds))
      return `${text} s`
    }

    /** The tokens column's hint: the input side, which the cell itself does not show. */
    function tokensHintText(row, t) {
      const none = t('none')
      /*
       * The input is spelled out with thousands separators; the cell above it abbreviates. The
       * hint exists precisely for the cases where the abbreviation loses information.
       */
      const input = row.context === null || row.context === undefined ? none : tokensExact(row.context, t)
      const hit =
        row.cacheHit === null || row.cacheHit === undefined
          ? none
          : `${(row.cacheHit * 100).toFixed(1)}%`
      return t('tokensHint', { input, hit })
    }

    /**
     * The index header's hint, with the three phase glyphs drawn in place.
     *
     * This is the reason the drawer owns a tooltip component at all: `title` can only carry
     * plain text, and the hint has to name the bolt, the T and the compaction bars. The glyphs
     * are rendered as elements and substituted into the sentence, so the wording and the
     * drawer's own markers can never drift apart.
     */
    function indexHint(t) {
      const glyph = (Icon) => h(Icon, { className: 'dsh-rum-tip-icon' })
      /*
       * Turn one sentence into elements, replacing each glyph placeholder with the glyph itself.
       * A single pass over a token list is simpler to follow than nesting one split per
       * placeholder, and it keeps the placeholders in whatever order a translation uses.
       */
      const withGlyphs = (text) => {
        const tokens = text.split(/(\{bolt\}|\{tools\}|\{compact\})/)
        const nodes = []
        for (const token of tokens) {
          if (token === '') continue
          if (token === '{bolt}') nodes.push(glyph(BoltIcon))
          else if (token === '{tools}') nodes.push(glyph(ToolIcon))
          else if (token === '{compact}') nodes.push(glyph(CompactionIcon))
          else nodes.push(token)
        }
        return nodes
      }
      /*
       * Three lines: what the column holds, what the glyphs mean, then what the row colours mean.
       * The colour line leads with two swatches instead of naming the hues, so a reader matches a
       * row against the legend by colour rather than by translating a word. The swatches take the
       * same tokens the rows take, so the two cannot drift apart.
       */
      return h(
        'span',
        { className: 'dsh-rum-tip-body' },
        h('span', { className: 'dsh-rum-tip-line' }, t('hintIndexRows')),
        h('span', { className: 'dsh-rum-tip-line' }, ...withGlyphs(t('hintIndexGlyphs'))),
        h(
          'span',
          { className: 'dsh-rum-tip-line' },
          h('span', { className: 'dsh-rum-tip-swatch', 'data-hue': 'lowcache' }),
          h('span', { className: 'dsh-rum-tip-swatch', 'data-hue': 'switched' }),
          t('hintColour'),
        ),
      )
    }

    /**
     * A hover hint, rendered as real DOM rather than through `title`.
     *
     * `title` can only show plain text, and the `#` header's hint names the three state glyphs
     * — it has to draw them. Owning the tooltip also keeps one visual language across the
     * drawer, lets it follow the theme's own surfaces, and avoids the browser's one-second
     * delay.
     *
     * It is positioned `fixed` on the body so no scroll container can clip it, and flipped
     * below the anchor when there is no room above.
     */
    function Tooltip(props) {
      const { open, x, y, children, wide } = props
      if (!open) return null
      return portal(
        h(
          'div',
          {
            className: 'dsh-rum-tip',
            role: 'tooltip',
            /* Only a hint whose width varies between readings asks for a floor. */
            'data-wide': wide === true ? 'true' : undefined,
            style: { left: `${x}px`, top: `${y}px` },
          },
          children,
        ),
      )
    }

    /**
     * Hover state for one row or one header.
     *
     * A short delay keeps a hint from flashing while the pointer sweeps across the drawer,
     * and a single shared timer is enough because only one hint can be open at a time.
     */
    /**
     * Hover state for one row or one header.
     *
     * `content` may be a FUNCTION, and the tooltip calls it on every render instead of once. That
     * is what makes a live figure live: the tool-phase hint counts up while the pointer rests on
     * the marker, and storing the rendered string would freeze it at whatever it read when the
     * pointer arrived — which is how it sat at 0.0 s.
     *
     * A short delay keeps a hint from flashing while the pointer sweeps across the drawer, and a
     * single shared timer is enough because only one hint can be open at a time.
     */
    /**
     * Hover state for the drawer's hints.
     *
     * The model is a POSITION, not a rendered string: the hook remembers which element the pointer
     * is over, and the content is recomputed on every render from a supplier the caller registers.
     * Storing the rendered text froze it on arrival — that is what made a live figure sit still —
     * and every patch since (a heartbeat, a scope guard, an empty-body check) was working around
     * that one decision.
     *
     * Recomputing on render fixes all of it at once: a live span moves because the component
     * re-renders on its own ticker, a hint closes when its supplier has nothing to say, and a hint
     * re-opens by itself when the row it is over starts describing something new — all without the
     * pointer moving.
     *
     * `anchor` names the cell: one per row per column, so the live row and a numbered row never
     * share an identity even when they show the same column.
     */
    function useHint(delay) {
      const [hover, setHover] = useState(null)
      const timer = useRef(null)
      const cancel = useCallback(() => {
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
      }, [])
      const enter = useCallback(
        (anchor, event) => {
          cancel()
          /*
           * Read the geometry NOW, not in the timer.
           *
           * React pools its synthetic event objects: `currentTarget` is nulled once the handler
           * returns, so reading it inside a deferred callback finds nothing and the hint never
           * opens. That is exactly what happened — every hint silently declined.
           */
          const rect = event?.currentTarget?.getBoundingClientRect?.()
          if (rect === undefined) return
          timer.current = setTimeout(() => {
            timer.current = null
            setHover({ anchor, x: rect.left, y: rect.top })
          }, delay)
        },
        [cancel, delay],
      )
      const leave = useCallback(() => {
        cancel()
        setHover(null)
      }, [cancel])
      useEffect(() => cancel, [cancel])
      /*
       * Resolve a supplier only while its own anchor is the one being hovered.
       *
       * The early return matters: every cell on screen calls this on every render, and only one of
       * them can match. Leaving it out would evaluate all of them, once per tick, for nothing.
       */
      const bodyFor = useCallback(
        (anchor, supplier) => {
          if (hover === null || hover.anchor !== anchor) return null
          const body = typeof supplier === 'function' ? supplier() : supplier
          return body === undefined ? null : body
        },
        [hover],
      )
      /** Where to draw the box, or null when nothing is hovered. */
      const origin = hover === null ? null : { x: hover.x, y: hover.y }
      return { hover, origin, enter, leave, bodyFor }
    }


    /**
     * The compaction wording as one sentence, for the button's accessible name.
     */
    function compactionSentence(compaction, phase, now, t) {
      const elapsed = compactionSpan(compaction, now)
      const parts = [
        clockText(compaction.at),
        compactionModelName(compaction, t),
        phase === 'compacting' ? t('drawerCompacting') : t('drawerCompacted'),
        secondsText(elapsed, t),
      ]
      return parts.join(' · ')
    }

    /**
     * How long a compaction has run: live while it runs, frozen once it lands.
     *
     * The live figure counts from `startTime`, which is the same origin the drawer row uses,
     * so the pill and the row can never disagree. Once the fold reports `wall`, that log value
     * takes over so a reload shows the same span it showed live.
     */
    function compactionSpan(compaction, now) {
      if (compaction.running === true) {
        if (compaction.startMs === null) return null
        return Math.max(0, now - compaction.startMs)
      }
      return compaction.totalMs
    }

    /**
     * The model a compaction used, or the wording that stands in for it.
     *
     * `compaction/summary` reports the real model, so a finished compaction always knows it.
     * While one runs the fold has only an id and a turn — the summarizer's own request is not
     * logged as a header — so the routed model of the last request is the honest reading, and
     * the general wording is the last resort.
     */
    function compactionModelName(compaction, t) {
      if (typeof compaction.model === 'string' && compaction.model !== '') return compaction.model
      return t('usingChatModel')
    }

    /**
     * The compaction variant of the status reading.
     *
     * Three segments replace the five metric slots: the clock the compaction began at, the
     * model doing it, and how long it has been running. The pill's own width is left to
     * `--dsh-rum-pill-width`, measured from the idle layout, so switching into this phase
     * cannot move anything beside it.
     */
    function CompactionReading(props) {
      const { compaction, phase, now, t } = props
      const span = compactionSpan(compaction, now)
      return h(
        'span',
        { className: 'dsh-rum-parts dsh-rum-compact-parts' },
        h('span', { className: 'dsh-rum-part dsh-rum-compact-clock' }, clockText(compaction.at)),
        h(
          'span',
          { className: 'dsh-rum-part dsh-rum-compact-model', title: compactionModelName(compaction, t) },
          compactionModelName(compaction, t),
        ),
        h(
          'span',
          { className: 'dsh-rum-part' },
          phase === 'compacting' ? t('drawerCompacting') : t('drawerCompacted'),
        ),
        h(
          'span',
          { className: 'dsh-rum-part' },
          h('span', { className: 'dsh-rum-num dsh-rum-compact-span' }, durationSlot(span)),
          h('span', { className: 'dsh-rum-unit' }, DURATION_UNIT),
        ),
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

    function useLiveReading(
      useChat,
      enabled,
      trajectory,
      runningStatsStep,
      sessionTurnOpen,
      sessionRunning,
      sessionStats,
      models,
    ) {
      const partial = useChat((snapshot) => snapshot.legacy.partial)
      const nodes = useChat((snapshot) => snapshot.legacy.nodes)
      const turnTimings = useChat((snapshot) => snapshot.legacy.turnTimings)
      const runningCalls = useChat((snapshot) => snapshot.legacy.runningCalls)

      /*
       * A step is live from `step/start`, not from its first visible block.
       *
       * Three sources, tightest first:
       * 1. The statistics fold's own `running` step. It is fed by the same durable log the
       *    Statistics view renders, so it appears at once and never disagrees with the rows.
       * 2. The Trajectory domain's running request — authoritative when present, but it lags
       *    a fold that has already seen `step/start`.
       * 3. `legacy.partial`, which only exists once the step has visible content.
       *
       * Reading the statistics first is what keeps the live row and the numbered rows from
       * disagreeing: a step the fold calls running is excluded from the list by key, and the
       * live row reports it. When the live step came only from a lagging source, the running
       * step still appeared in the list and took `#1` while the live row was empty.
       */
      /*
       * Whether a turn is in flight.
       *
       * `sessionRunning` comes from the framework's session store and is the one signal that
       * clears on ANY ending, including a manual stop. `sessionTurnOpen`, derived from the
       * statistics fold, only clears when a closing event arrives — a cancelled step may never
       * get one. So the store wins when it has an opinion, and the fold is only a fallback.
       */
      const turnIsOpen =
        sessionRunning === undefined || sessionRunning === null
          ? sessionTurnOpen !== false
          : sessionRunning === true
      const request = runningRequestOf(trajectory)
      /*
       * Three states, all decided from the statistics fold:
       *
       * 1. `writing` — the model is producing the reply. `model` is null because it is
       *    `messageTime - startTime`.
       * 2. `tools` — the reply is complete but the step has not ended: its tool calls are
       *    running. `model` is fixed and `endTime` is still null.
       * 3. idle — the step ended, or there is no running step at all.
       *
       * The distinction matters because only the first is "the model is working". The second is
       * this plugin's own idea of activity worth marking: the request is still in flight, so it
       * keeps a live row, but the model has stopped writing, so the marker changes from the
       * bolt to a tool glyph and the drawer header says so.
       *
       * A closed turn admits no live step at all, so a step still flagged running in a stale
       * snapshot cannot revive either marker.
       */
      /*
       * Three states, decided by the statistics fold when it has a running step:
       *
       * 1. `writing` — the model is producing the reply (`model` is null).
       * 2. `tools` — the reply is complete but the step has not ended (`model` fixed,
       *    `endTime` null), so its tool calls are running.
       * 3. idle — the step ended, or the turn closed.
       *
       * A composition without that fold falls back to the other sources, and there the phase is
       * simply `writing`: a partial block or a Trajectory request is by definition the model
       * streaming. Treating "no fold" as idle is what would break the fallback entirely.
       *
       * A closed turn admits no live step at all, so a step still flagged running in a stale
       * snapshot cannot revive either marker.
       */
      /*
       * The newest compaction in the session, running or just finished.
       *
       * Compaction is a fourth kind of activity that overlaps the others: it runs between
       * steps, belongs to no step, and can take tens of seconds. Without it the pill simply
       * froze on the previous figures for the whole summarization, which is exactly the
       * "I cannot tell what it is doing" complaint.
       */
      const compactionNow = compactionsOf(sessionStats)
      const liveCompaction = compactionNow?.running === true ? compactionNow : null
      /*
       * A compaction that finished and has not yet been followed by a new request.
       *
       * The pill keeps saying "compacted" until the next request starts, so the user can see
       * that the long pause was the summarization finishing rather than the app stalling. A
       * step that began after the compaction ended is what ends it — the fold keeps the
       * compaction record forever, so its mere presence cannot mean "just happened".
       */
      const recentCompaction =
        liveCompaction !== null
          ? null
          : compactionNow !== null && !compactionHadSuccessor(compactionNow, sessionStats)
            ? compactionNow
            : null
      const livePhase = (() => {
        /*
         * Compaction wins over the step phases: it happens between steps, so a running
         * compaction and a running step cannot both be true, and checking it first keeps the
         * "compacted, waiting for the next request" state from being mistaken for idle.
         */
        if (liveCompaction !== null) return 'compacting'
        if (recentCompaction !== null) return 'compacted'
        if (!turnIsOpen) return null
        if (runningStatsStep !== null && runningStatsStep !== undefined) {
          const metrics = runningStatsStep.metrics
          if (numberOrNull(metrics.model) === null) return 'writing'
          if (numberOrNull(metrics.endTime) === null) return 'tools'
          return null
        }
        // No fold: the partial/request sources only ever describe a reply being written.
        if (request !== undefined) return 'writing'
        if (partial !== null && partial !== undefined) return 'writing'
        return null
      })()
      /** The compaction a render should show, whichever of the two phases is active. */
      const activeCompaction = liveCompaction ?? recentCompaction
      const liveStep = livePhase === null || activeCompaction !== null
        ? null
        : runningStatsStep !== null && runningStatsStep !== undefined
          ? { turn: runningStatsStep.turn, step: runningStatsStep.step }
          : request === undefined
            ? partial === null || partial === undefined
              ? null
              : { turn: partial.turn, step: partial.step }
            : { turn: request.turn, step: request.step }
      /*
       * A compaction is live too, even though it has no step: the clock has to tick for its
       * running span, and the early returns below gate on this flag.
       */
      const running = enabled && (liveStep !== null || activeCompaction !== null)
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
        /*
         * A compaction has no step, so there is no first-token mark to find: the guard covers
         * the compacting phase, where `running` is true but `liveStep` is null by design.
         */
        if (!running || liveStep === null) {
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
       * The step's origin, tightest source first:
       * 1. The statistics fold's `startTime` — the `step/start` event time itself, exact and
       *    the very figure the Statistics view prints. Used ONLY when the fold's running step
       *    is the one being shown: after a stop and a new turn, the fold can still hold the
       *    previous step while `liveStep` has already moved on, and taking that time counted
       *    the new request from the old one's origin — the stale total that kept growing.
       * 2. The Trajectory domain's `startedAt`, also from `step/start`, but a publication can
       *    lag the fold.
       * 3. Reconstruction from the previous step's last tool result, then the turn's start.
       */
      /*
       * The model for the running step, worked out the same way the drawer does it: a header
       * written inside this step names a switch, otherwise the previous step's model carries
       * over. A finished reply overrides both, which is why the plan prefers it.
       *
       * This is what lets the live row show a model while it is still streaming instead of
       * waiting for `assistant/message` to land.
       */
      const livePlan =
        sessionStats === undefined ? undefined : modelPlanFromStats(sessionStats, models)
      const liveOwner =
        liveStep === null || livePlan === undefined
          ? undefined
          : livePlan.get(`${liveStep.turn}:${liveStep.step}`)

      /*
       * A compaction has no step to measure, so the reading is built from the compaction alone:
       * its own clock, its own span and its own model. Returning here keeps every step-shaped
       * figure below out of the picture — there is no step to attribute them to.
       */
      if (activeCompaction !== null) {
        return {
          key: null,
          at: activeCompaction.at,
          startMs: activeCompaction.startMs,
          ttftMs: null,
          totalMs: compactionSpan(activeCompaction, now),
          tokens: activeCompaction.tokens,
          estimated: false,
          speed: null,
          amortized: activeCompaction.amortized,
          replyLanded: false,
          phase: livePhase,
          compaction: activeCompaction,
        }
      }
      const statsStart =
        runningStatsStep !== null &&
        runningStatsStep !== undefined &&
        runningStatsStep.turn === liveStep.turn &&
        runningStatsStep.step === liveStep.step
          ? numberOrNull(runningStatsStep.metrics?.startTime)
          : null
      const start =
        statsStart ??
        numberOrNull(request?.startedAt) ??
        stepStartOf(liveStep, nodes, turnTimings)
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
       * The model's reply can be finished while the step is still open.
       *
       * `assistant/message` lands when the reply is complete, but `step/end` only arrives after
       * the step's tool calls run. Between those two moments the step is still `running` and
       * has produced nothing more — every token it will ever report is already known. Counting
       * on from the clock there showed a live figure that grew while nothing was happening, and
       * the character estimate stayed at its starting value, so the pill read "~0 tok" beside a
       * total that kept climbing.
       *
       * Once the fold knows `messageTime`, the measured figures replace the estimate entirely:
       * tokens, first-token latency and the model's own duration all come from the log, and the
       * clock stops because there is nothing left to measure.
       */
      const settled = runningStatsStep !== null && runningStatsStep !== undefined
        ? runningStatsStep.metrics
        : null
      /*
       * Which tool calls are still running, and since when.
       *
       * `calls[]` carries `startedAt` for every dispatch and `endedAt: null` while one is open, so
       * a step whose reply has landed and whose tools are still going can say so with a live
       * figure. The span is measured from the EARLIEST open call, not from a sum: three parallel
       * tools occupy one wall-clock interval, and adding their durations would overstate it.
       *
       * The newest name is kept for the wording, because that is the action the reader just
       * watched start; the clock still measures from the earliest, which is the honest span.
       */
      const toolRun = (() => {
        const calls = settled === null ? null : settled.calls
        if (!Array.isArray(calls)) return { count: 0, since: null, name: null }
        let since = null
        let name = null
        let count = 0
        for (const call of calls) {
          if (call === null || typeof call !== 'object') continue
          if (call.endedAt !== null) continue
          const at = numberOrNull(call.startedAt)
          if (at === null) continue
          count += 1
          if (since === null || at < since) since = at
          if (typeof call.name === 'string' && call.name !== '') name = call.name
        }
        return { count, since, name }
      })()
      /*
       * Has the model finished writing this reply?
       *
       * The published step object has NO `messageTime` field — `stepMetrics` keeps that in the
       * fold's private state and exposes only derived figures. Checking `messageTime` therefore
       * always read `undefined`, the measured branch never ran, and the pill went on counting
       * through the tool phase with "~0 tok" beside it.
       *
       * `model` is the field that answers this: it is `messageTime - startTime`, so it is null
       * until the message lands and final afterwards. `decode` and `output` have the same
       * property for the token side.
       */
      const replyLanded =
        settled !== null && numberOrNull(settled.model) !== null && numberOrNull(settled.output) !== null
      if (replyLanded) {
        const measuredTtft = numberOrNull(settled.ttft)
        const measuredTokens = numberOrNull(settled.output)
        const measuredModel = numberOrNull(settled.model)
        const measuredSpeed = numberOrNull(settled.tps)
        /*
         * The total is the MODEL time, and it is final once the reply lands.
         *
         * `model` is `messageTime - startTime`, exactly the figure the Statistics view prints in
         * its model-time column. It contains no tool time by construction, so there is nothing
         * left to measure after the message arrives — the number freezes here instead of
         * counting on through the tool run.
         *
         * Only while the reply is still streaming does the elapsed clock stand in, and then it
         * is genuinely the model working.
         */
        const totalMs = measuredModel
        return {
          key,
          at: start ?? now,
          ttftMs: measuredTtft,
          totalMs,
          tokens: measuredTokens,
          estimated: false,
          speed: measuredSpeed,
          amortized:
            measuredTokens !== null && measuredTokens > 0 && measuredModel !== null && measuredModel > 0
              ? measuredTokens / (measuredModel / 1000)
              : null,
          replyLanded: true,
          phase: livePhase,
          model: liveOwner?.model ?? null,
          provider: liveOwner?.provider ?? null,
          switched: liveOwner?.switched === true,
          toolRun,
          /*
           * The input side, which the tooltip reports. The fold publishes it from
           * `assistant/message`, and that event lands BEFORE the step's tool calls run — measured
           * on 3239 steps, every one carried its usage by the time the first tool was dispatched.
           * So during the tool phase these are already final, not pending.
           */
          context: settled === null ? null : numberOrNull(settled.context),
          cacheRead: settled === null ? null : numberOrNull(settled.cacheRead),
          cacheHit: settled === null ? null : numberOrNull(settled.cacheHit),
          compaction: activeCompaction,
        }
      }

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
        replyLanded: false,
        phase: livePhase,
        model: liveOwner?.model ?? null,
        provider: liveOwner?.provider ?? null,
        switched: liveOwner?.switched === true,
        toolRun,
        context: settled === null ? null : numberOrNull(settled.context),
        cacheRead: settled === null ? null : numberOrNull(settled.cacheRead),
        cacheHit: settled === null ? null : numberOrNull(settled.cacheHit),
          compaction: activeCompaction,
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
     *
     * Interrupted rows are excluded from every mean. Their total is wall-clock time — it
     * includes however long the request ran before being stopped — so averaging it against
     * model times would pull the figures toward a number that describes neither case. The
     * row still counts toward `count`, because the caption names the list, not the sample.
     */
    function averageOf(rows) {
      if (rows.length === 0) return null
      const measurable = rows.filter((row) => row.interrupted !== true && row.compaction !== true)
      const mean = (pick) => {
        let sum = 0
        let count = 0
        for (const row of measurable) {
          const value = pick(row)
          if (value === null || value === undefined || !Number.isFinite(value)) continue
          sum += value
          count += 1
        }
        return count === 0 ? null : sum / count
      }
      return {
        count: rows.length,
        measured: measurable.length,
        ttftMs: mean((row) => row.ttftMs),
        speed: mean((row) => row.speed),
        tokens: mean((row) => row.tokens),
        totalMs: mean((row) => row.totalMs),
        amortized: mean((row) => row.amortized),
        // A column is "estimated" when any sample in it was; the tilde then still means
        // the same thing it does on a single row.
        estimated: measurable.some((row) => row.estimated === true),
        anyEstimated: measurable.some((row) => row.estimated === true),
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
      const { useChat, useGeek, useRows, replaceRows, bindSession, t } = props
      /*
       * The framework's own session snapshot. `running` is the authority for "a turn is in
       * flight": the store sets it when a turn starts and clears it when the turn ends,
       * including a cancelled one. The statistics fold only learns about a cancellation when
       * its closing event arrives, which is why the pill could keep counting after a manual
       * stop.
       */
      const sessionRunning = typeof props.useSession === 'function' ? props.useSession((snapshot) => snapshot?.running === true) : undefined
      const geek = useGeek((value) => value) === GEEK
      const rows = useRows((value) => value)
      const sessionId = props.sessionId
      /*
       * The Trajectory domain's snapshot. `useTrajectory` is a standard slot prop, read
       * defensively: a composition without that domain yields `undefined` and everything
       * below falls back to what the Chat snapshot alone can say.
       *
       * It is read before the live reading because that reading needs the domain's own
       * running-step record: the Chat store only publishes a step once it has visible
       * content, which is a 1.9 s median after the step begins.
       */
      const useTrajectory = props.useTrajectory
      const trajectory = typeof useTrajectory === 'function' ? useTrajectory((snapshot) => snapshot) : undefined
      /*
       * The shipped Statistics view's own data, read straight from its target.
       *
       * A view target only materializes once something subscribes, and a target's
       * `subscribe` is also what activates it. Activation is permanent and shared with the
       * Statistics view, so this does not start a second fold — it joins the one running.
       *
       * The snapshot must be held in state, not read inline: the target publishes a new
       * snapshot object on every change, but nothing re-renders this component unless it
       * subscribes. Reading it inline during render froze the rows at whatever the first
       * render saw — which is why the drawer showed timestamps minutes behind the log.
       */
      /*
       * The shipped Statistics view's data source for this session. `undefined` when that
       * view is absent — a composition without it — which is what routes the drawer to its
       * Chat-snapshot fallback. No switch decides this: the presence of the source does.
       */
      const statsSource = typeof props.statsSource === 'function' ? props.statsSource() : undefined
      const statsSubscribe = useCallback(
        (listener) => {
          if (statsSource === undefined || typeof statsSource.subscribe !== 'function') {
            return () => {}
          }
          return statsSource.subscribe(listener)
        },
        [statsSource],
      )
      const statsRead = useCallback(
        () => {
          if (statsSource === undefined || typeof statsSource.getSnapshot !== 'function') return undefined
          /*
           * Tag the snapshot with the session it came from. The tag travels with the value, so
           * a snapshot that outlives a session switch is recognisable and gets ignored instead
           * of being rendered against the wrong conversation.
           */
          return { sessionId, snapshot: statsSource.getSnapshot() }
        },
        [statsSource, sessionId],
      )
      const [statsSnapshot, setStatsSnapshot] = useState(statsRead)
      /*
       * Re-point the subscription at whatever target is current, then re-read.
       *
       * A conversation that is rebuilt underneath the drawer (a model switch, a reconnect, a
       * released binding) replaces its `BoundConversation`, and with it the view store the old
       * `target()` closure captured. Refreshing on every render rebinds the listener to the new
       * target, so the drawer cannot keep rendering a retired snapshot while the Statistics page
       * has already moved on.
       */
      if (statsSource !== undefined && typeof statsSource.refresh === 'function') {
        statsSource.refresh()
      }
      useEffect(() => {
        setStatsSnapshot(statsRead())
        return statsSubscribe(() => setStatsSnapshot(statsRead()))
      }, [statsRead, statsSubscribe])
      /*
       * Follow a conversation that is rebuilt underneath the drawer.
       *
       * A model switch, a reconnect, or a released binding replaces the session's
       * `BoundConversation`, and with it the view store the old `target()` closure captured.
       * That stale closure keeps returning its last snapshot forever — which is exactly how the
       * drawer froze on one turn while the Statistics page moved on.
       *
       * On a slow tick this re-points the listener at the target that is current now and
       * re-reads the snapshot. Both are cheap (a map lookup and a field read) and neither
       * depends on the stale chain firing.
       */
      useEffect(() => {
        if (statsSource === undefined) return undefined
        const sync = () => {
          if (typeof statsSource.refresh === 'function') statsSource.refresh()
          const next = statsRead()
          if (next !== undefined) setStatsSnapshot(next)
        }
        sync()
        const timer = setInterval(sync, 1000)
        return () => clearInterval(timer)
      }, [statsSource, statsRead])
      /*
       * A snapshot only counts while it belongs to the session being shown.
       *
       * `statsSource` follows `props.sessionId`, but `statsSnapshot` is state and survives the
       * switch: for the render or two before the new source publishes, it still held the
       * PREVIOUS conversation's data. The drawer and the pill then described the conversation
       * that had just been left, and a step that was running there kept the live bolt pulsing
       * on a finished chat. Tagging each snapshot with its session and requiring a match makes
       * the stale window impossible rather than merely short.
       */
      const sessionStats =
        statsSnapshot !== undefined && statsSnapshot.sessionId === sessionId
          ? statsSnapshot.snapshot
          : undefined
      /*
       * The step the statistics fold currently calls running, if any.
       *
       * Computed before the live reading because that reading prefers it: the fold is fed by
       * the durable log and sees `step/start` at once, while the Trajectory domain's request
       * list can still be a publication behind. When the live step came only from the slower
       * source, the running step stayed in the numbered list and took `#1` while the live row
       * was empty — the same request reported twice, once with no figures.
       */
      const runningStatsStep = useMemo(() => {
        if (sessionStats === undefined) return null
        const turns = sessionStats?.turns
        if (!Array.isArray(turns) || turns.length === 0) return null
        /*
         * Only the LAST turn can hold the live step.
         *
         * Scanning every turn for `running: true` picked up a stale one: a step whose own
         * `step/end` had long since arrived still carried the flag in a snapshot that had not
         * been fully re-folded, and the pill counted from ITS start — 309 s and climbing, on a
         * timestamp five minutes old, while the actual request sat in a later turn. A running
         * step can only exist in the newest turn, so anything older is discarded.
         */
        const last = turns[turns.length - 1]
        if (last === null || typeof last !== 'object') return null
        if (!Array.isArray(last.steps) || last.steps.length === 0) return null
        /*
         * A closed turn has no live step at all. `buildTurns` sets a turn's `running` to false
         * once its end marker is folded, and it also clears the last step's flag at that point
         * — but a snapshot that has not been re-folded can still show the step as running. The
         * turn's own flag is the cheaper, more reliable gate.
         */
        if (last.running === false) return null
        for (let index = last.steps.length - 1; index >= 0; index -= 1) {
          const metrics = last.steps[index]
          if (metrics === null || typeof metrics !== 'object') continue
          if (metrics.running !== true) continue
          /*
           * A step the fold marked `aborted` ended without a settled reply, and nothing more
           * will arrive for it — so it must not keep the clock running. `interrupted` is the
           * same story from the turn's close marker.
           *
           * Do NOT infer "finished" from a present `messageTime` alone: that field is set by
           * `assistant/message`, which lands BEFORE the step's tool calls run, so a perfectly
           * healthy step in its tool phase has a message time and no `endTime` yet. Treating
           * that as finished killed the live row mid-turn.
           */
          if (metrics.aborted === true || metrics.interrupted === true) return null
          return { turn: last.turn, step: metrics.step, metrics }
        }
        return null
      }, [sessionStats])
      /*
       * Whether the statistics fold still considers this session's last turn open.
       *
       * `buildTurns` computes exactly this: a turn's `running` is true only when it is the last
       * turn AND its end marker has not arrived, and the marker additionally clears the last
       * step's running flag. `undefined` means the fold has no opinion yet — an empty session,
       * or a snapshot that has not arrived — and the other sources are left to speak for
       * themselves.
       */
      const sessionTurnOpen = useMemo(() => {
        if (sessionStats === undefined) return undefined
        const turns = sessionStats?.turns
        if (!Array.isArray(turns) || turns.length === 0) return undefined
        const last = turns[turns.length - 1]
        if (last === null || typeof last !== 'object') return undefined
        return last.running !== false
      }, [sessionStats])
      const chatNodes = useChat((snapshot) => snapshot.legacy.nodes)
      /*
       * The per-step model attribution, computed once and shared by the live reading and the
       * history so the two can never disagree about which model a step used.
       */
      const models = useMemo(
        () => modelIndexFromTrajectory(trajectory),
        [trajectory],
      )
      const live = useLiveReading(
        useChat,
        geek,
        trajectory,
        runningStatsStep,
        sessionTurnOpen,
        sessionRunning,
        sessionStats,
        models,
      )

      const triggerRef = useRef(null)
      const drawerRef = useRef(null)
      const partsRef = useRef(null)
      const [pinned, setPinned] = useState(false)
      const [mounted, setMounted] = useState(false)
      const [entered, setEntered] = useState(false)
      const [pos, setPos] = useState(null)
      const [now, setNow] = useState(() => Date.now())
      /**
       * Measured pixel widths of the pill's five metric cells, in DOM order. The drawer
       * uses them as its grid columns so each column sits exactly under the metric it
       * reports; `ch` arithmetic cannot do this because the label glyphs are narrower
       * than the `ch` unit itself.
       */
      const [columnWidths, setColumnWidths] = useState(null)
      /* The clock column is measured on its own: the drawer repeats it at the same width. */
      const [clockWidth, setClockWidth] = useState(null)

      /* Click only: the drawer opens on the pill and closes on it, Escape, or outside. */
      const open = geek && pinned

      /*
       * Point the model at this session before reading anything from it: a different id
       * clears rows that belong to another conversation.
       */
      useEffect(() => {
        bindSession(sessionId ?? null)
      }, [sessionId, bindSession])

      /*
       * The drawer's rows come from the session's statistics, rebuilt on every publication
       * rather than accumulated locally. That is what keeps them consistent across
       * conversation switches and reloads: there is no local copy to fall out of date, and
       * every figure is the one the Statistics view renders.
       *
       * Derived during render, not in an effect: an effect would leave the first render of
       * a newly published snapshot showing the previous rows (or placeholders), which is
       * what made the drawer lag the log.
       */
      const statsRows = useMemo(
        () =>
          sessionStats === undefined
            ? undefined
            : historyFromStats(sessionStats, models),
        [sessionStats, models],
      )
      /*
       * Fallback for a composition without the statistics target: derive rows from the Chat
       * snapshot and the Trajectory domain instead. This is the pre-existing path, kept so
       * the drawer still lists something when `stats` is unavailable.
       */
      const firstTokens = useMemo(
        () => (trajectory === undefined || trajectory === null ? NO_FIRST_TOKENS : firstTokenIndex(trajectory)),
        [trajectory],
      )
      const fallbackRows = useMemo(() => {
        if (statsRows !== undefined) return undefined
        const assistants = []
        for (const node of chatNodes ?? []) {
          if (!isAssistantNode(node)) continue
          assistants.push(node)
        }
        const dated = (node) => {
          const key = `${node.turn}:${node.step}`
          const fromTrajectory = firstTokens.get(key)
          if (fromTrajectory === undefined) return readingOf(node)
          const timing = node?.timing ?? {}
          if (numberOrNull(timing.firstTokenTime) !== null) return readingOf(node)
          return readingOf({ ...node, timing: { ...timing, firstTokenTime: fromTrajectory } })
        }
        /*
         * Drop rows that carry no clock at all.
         *
         * The Chat snapshot keeps `timing` only for steps that streamed during this page's
         * lifetime; a step replayed from a trimmed window can arrive with none. Such a row
         * rendered a full line of dashes beside real ones, which reads as a broken request
         * rather than as missing data. The statistics path is the primary source precisely
         * because it does not have this gap.
         */
        return assistants
          .reverse()
          .map(dated)
          .filter((row) => numberOrNull(row.at) !== null)
      }, [statsRows, chatNodes, firstTokens])

      /*
       * The live row at the top of the drawer and the numbered rows below it must not report
       * the same request: the live row is the request streaming right now, and while it is
       * still running it has no numbered row. The moment it settles it leaves the live row
       * and enters the list at `#1` — one request, one place at a time.
       *
       * `live.key` is `${turn}:${step}`, the same key the statistics rows use, so this is an
       * exact identity rather than a timing guess.
       *
       * The cap is applied *after* the exclusion. Taking the newest ten and then dropping the
       * live one left nine rows on screen for the whole time a request was streaming, which
       * broke the "always ten" rule: the list must keep a full page and let the newest
       * settled request push the oldest out, not shrink while something runs.
       */
      const listedRows = useMemo(() => {
        const base = statsRows ?? fallbackRows ?? []
        /*
         * The running compaction is rendered as its own row above the list, so the numbered
         * list must not repeat it. A finished compaction stays in the list — it is history
         * then, and it is what the drawer is for.
         */
        const runningCompactionKey =
          live !== null && live.compaction !== null && live.compaction.running === true
            ? live.compaction.key
            : null
        let visible = base
        if (live !== null && live.key !== null) visible = visible.filter((row) => row.key !== live.key)
        if (runningCompactionKey !== null) visible = visible.filter((row) => row.key !== runningCompactionKey)
        return visible.slice(0, MAX_ROWS)
      }, [statsRows, fallbackRows, live])

      /*
       * Publish the derived rows to the model, which the pill and the drawer both read.
       * This runs after the render that computed them, so the visible tree already carries
       * the right figures.
       */
      const derivedRows = listedRows
      useEffect(() => {
        replaceRows(geek ? derivedRows : [])
      }, [geek, derivedRows, replaceRows])


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
          /* The parts row holds exactly the five figures; the clock is a sibling now. */
          const cells = host.querySelectorAll('[data-metric]')
          if (cells.length !== 5) return
          const widths = []
          for (const cell of cells) {
            const rect = cell.getBoundingClientRect()
            // getBoundingClientRect is 0 in a detached/hidden tree; keep the CSS fallback.
            if (rect.width <= 0) return
            widths.push(Math.round(rect.width * 100) / 100)
          }
          const clock = triggerRef.current?.querySelector('[data-metric="clock"]') ?? null
          if (clock !== null) {
            const clockRect = clock.getBoundingClientRect()
            if (clockRect.width > 0) {
              setClockWidth((previous) => {
                const next = Math.round(clockRect.width * 100) / 100
                return previous === next ? previous : next
              })
            }
          }
          setColumnWidths((previous) => {
            if (previous !== null && previous.every((value, index) => value === widths[index])) {
              return previous
            }
            return widths
          })
        }
        /*
         * Publish the idle layout's width so the compaction phase can reserve it.
         *
         * The compaction reading is much shorter than five metric slots, and without a floor
         * the pill would shrink while it runs — moving the composer's neighbours and then
         * moving them back when the phase ends. Measuring the settled layout once and pinning
         * it as a CSS custom property keeps the pill the same size through every phase.
         *
         * The measurement is skipped in the compaction phases themselves: that layout is the
         * one being constrained, so measuring it would ratchet the width down to itself.
         */
        const measurePillWidth = () => {
          const anchor = triggerRef.current
          if (anchor === null) return
          const phase = anchor.getAttribute('data-live-phase')
          if (phase === 'compacting' || phase === 'compacted') return
          const width = anchor.getBoundingClientRect().width
          if (!Number.isFinite(width) || width <= 0) return
          anchor.style.setProperty('--dsh-rum-pill-width', `${Math.round(width)}px`)
        }
        measure()
        measurePillWidth()
        window.addEventListener('resize', measure)
        window.addEventListener('resize', measurePillWidth)
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
          window.removeEventListener('resize', measurePillWidth)
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

      const view = useAnimatedRows(derivedRows)

      if (!geek) return null

      const current = live ?? derivedRows[0] ?? null
      /*
       * The tilde marks an ESTIMATE, not "this row is live".
       *
       * It used to be `live !== null || current?.estimated === true`, so every live reading got
       * the marker regardless of its source — and after the reply lands the live reading is
       * measured, not estimated. The row's own flag decides now: a live reading that has
       * switched to measured figures prints like a settled row.
       */
      const approximate = current?.estimated === true
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
      /*
       * The compaction phases replace the whole set of figures with one sentence: a clock, the
       * model, the wording and a running span. That layout is built as its own branch because
       * none of the five metric slots apply — a compaction has no first token and no rate.
       */
      const compaction = live?.compaction ?? null
      const compactingPhase = live?.phase === 'compacting' || live?.phase === 'compacted'
      /*
       * One hover hint serves the whole drawer: only one can be open at a time, and sharing the
       * timer is what stops a hint from a previous row lingering while the pointer moves on.
       */
      /*
       * One hover hint serves the whole drawer. The anchor names the cell, and the content is
       * resolved from it on every render — see `tipContent` below.
       */
      const hint = useHint(300)
      const compactionLabel =
        compaction === null
          ? statusLabel
          : `${t('statusAria')} · ${compactionSentence(compaction, live.phase, now, t)}`

      /*
       * Resolve the hint's content from the anchor it is hovering.
       *
       * This runs on every render and MUST stay cheap: it is reached for all seventeen cells on
       * each tick. The first comparison exits immediately for every cell that is not hovered, so
       * the cost without a hint is one string comparison per cell.
       *
       * Nothing here is cached. That is deliberate — a cached value is what froze the tool span,
       * and recomputing is how the hint notices that its row now describes something else, or that
       * it has nothing left to say.
       */
      const tipAnchor = hint.hover === null ? null : hint.hover.anchor
      const tipContent = (() => {
        if (tipAnchor === null) return null

        /* The header title reports the build, which is what makes a stale bundle visible. */
        if (tipAnchor === 'head:version') return t('versionHint', { version: VERSION })

        /* The status pill reports one request; see pillHint for what it adds to the drawer. */
        if (tipAnchor === 'pill') return pillHint(live, derivedRows[0] ?? null, t, now)

        if (tipAnchor.startsWith('header:')) {
          const column = tipAnchor.slice('header:'.length)
          if (column === 'index') return indexHint(t)
          const key = {
            time: 'hintTime',
            ttft: 'hintTtft',
            speed: 'hintSpeed',
            tokens: 'hintTokens',
            total: 'hintTotal',
            amortized: 'hintAmortized',
          }[column]
          return key === undefined ? null : t(key)
        }

        /* The live row: its figures change under the pointer, which is the whole point. */
        if (tipAnchor.startsWith('live:')) {
          if (live === null) return null
          const column = tipAnchor.slice('live:'.length)
          if (column === 'index') return liveMarkerHint(live, t)
          if (column === 'total') {
            /* The running-tool sentence; nothing to say once every tool has returned. */
            return toolRunHint(live, Date.now(), t)
          }
          if (column === 'clock') return absoluteStamp(live.at)
          if (column === 'speed') return modelHintText(live, t)
          if (column === 'tokens') {
            /* No usage has arrived yet, so declining says more than two dashes would. */
            return live.context === null || live.context === undefined ? null : tokensHintText(live, t)
          }
          return null
        }

        if (tipAnchor.startsWith('row:')) {
          const rest = tipAnchor.slice('row:'.length)
          const split = rest.lastIndexOf(':')
          if (split < 0) return null
          const key = rest.slice(0, split)
          const column = rest.slice(split + 1)
          const row = view.map((entry) => entry.row).find((candidate) => candidate.key === key)
          if (row === undefined) return null
          if (column === 'index') {
            const lines = rowHintLines(row, t)
            if (lines.length === 0) return null
            if (lines.length === 1) return lines[0]
            return h(
              'span',
              { className: 'dsh-rum-tip-body' },
              ...lines.map((line, index) => h('span', { className: 'dsh-rum-tip-line' }, line)),
            )
          }
          if (column === 'clock') return absoluteStamp(row.at)
          if (column === 'speed') return modelHintText(row, t)
          if (column === 'tokens') return tokensHintText(row, t)
          if (column === 'total') return toolHintText(row, t)
          return null
        }

        return null
      })()

      return h(
        'div',
        { className: 'dsh-rum-anchor' },
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            className:
              'dsh-rum-trigger' +
              (live !== null ? ' dsh-rum-live' : '') +
              (compactingPhase ? ' dsh-rum-compact-anchor' : ''),
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': compactionLabel,
            /* The pill explains itself on hover, the same way every drawer cell does. */
            onMouseEnter: (event) => hint.enter('pill', event),
            onMouseLeave: hint.leave,
            /* The active phase, so a test can observe it without reaching into the hooks. */
            'data-live-phase': live === null ? undefined : live.phase,
            /*
             * The compaction reading, serialised for tests. The phase attribute says which of
             * the four states is active; this says what the row actually carries — no first
             * token, no rate, a span that freezes once the fold reports `wall`.
             */
            'data-compaction-reading':
              compaction === null || live === null
                ? undefined
                : JSON.stringify({
                    compactionId: compaction.compactionId,
                    running: compaction.running,
                    ttftMs: live.ttftMs,
                    speed: live.speed,
                    totalMs: compaction.running === true ? live.totalMs : compaction.totalMs,
                    startMs: compaction.startMs,
                    tokens: compaction.running === true ? null : compaction.tokens,
                    model: compaction.model,
                  }),
            /* The four phases above are all a reader needs, but a spec also asserts the shape
             * of the compaction reading, so its identity is published too. */
            'data-compaction': compaction === null ? undefined : compaction.compactionId,
            /*
             * The input-side figures the tokens hint reports. Published so a spec can assert that
             * the live reading actually carries them: during the tool phase they are already final,
             * and leaving them out was what made the hint show two dashes.
             */
            'data-live-input':
              live === null
                ? undefined
                : JSON.stringify({ context: live.context ?? null, cacheHit: live.cacheHit ?? null }),
            onClick: () => {
              /* Opening the drawer supersedes the hint; two overlays at once would collide. */
              hint.leave()
              setPinned((current) => !current)
            },
          },
          live?.phase === 'tools'
            ? h(ToolIcon, { className: 'dsh-rum-bolt dsh-rum-tool-icon' })
            : compactingPhase
              ? h(CompactionIcon, {
                  className:
                    'dsh-rum-bolt dsh-rum-compaction-icon' +
                    (live.phase === 'compacting' ? '' : ' dsh-rum-still'),
                })
              : h(BoltIcon, { className: 'dsh-rum-bolt' }),
          /*
           * The clock is a sibling of the marker, NOT a cell inside the parts row.
           *
           * The drawer gives its clock its own grid column, so it has one gap on each side.
           * Inside the parts row it would have only the gaps between figures — one fewer on the
           * right — and since the drawer aligns its right edge to the pill's, that missing gap
           * shifts every column on the left by exactly 10px. Mirroring the structure is what
           * makes the two rows line up; no amount of tuning the numbers would.
           */
          compactingPhase && compaction !== null
            ? null
            : h(
                'span',
                { className: 'dsh-rum-part dsh-rum-part-clock', 'data-metric': 'clock' },
                h('span', { className: 'dsh-rum-num' }, clockText(current?.at)),
              ),
          compactingPhase && compaction !== null
            ? h(CompactionReading, { compaction, phase: live.phase, now, t })
            : h(
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
        h(Tooltip, {
          open: tipContent !== null,
          x: hint.origin?.x ?? 0,
          y: hint.origin?.y ?? 0,
          /* The pill's reading is the one hint whose width moves; give it a floor. */
          wide: tipAnchor === 'pill',
          children: tipContent,
        }),
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
                          ...(clockWidth === null ? null : { '--dsh-rum-col-clock': `${clockWidth}px` }),
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
                  {
                    className: 'dsh-rum-head-title',
                    /*
                     * Shows which build is loaded. The drawer has been revised many times and a
                     * stale bundle looks exactly like a fresh one, so this is the cheapest way to
                     * tell them apart without opening the page source.
                     */
                    onMouseEnter: (event) => hint.enter('head:version', event),
                    onMouseLeave: hint.leave,
                    'data-hint': 'true',
                  },
                  h(BoltIcon, { className: 'dsh-rum-bolt' }),
                  t('drawerTitle'),
                ),
                h(
                  'span',
                  { className: 'dsh-rum-head-count' },
                  /* The header counts what the list below actually holds, not the model's copy of it. */
                  live === null
                      ? t('drawerCount', { count: derivedRows.length })
                      : live.phase === 'tools'
                        ? t('drawerTools')
                        : t('drawerLive'),
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
                        {
                          className: 'dsh-rum-col',
                          role: 'columnheader',
                          'data-align': 'start',
                          onMouseEnter: (event) => hint.enter('header:index', event),
                          onMouseLeave: hint.leave,
                        },
                        t('colIndex'),
                      ),
                      h(
                        'span',
                        {
                          className: 'dsh-rum-col',
                          role: 'columnheader',
                          'data-align': 'start',
                          onMouseEnter: (event) => hint.enter('header:time', event),
                          onMouseLeave: hint.leave,
                        },
                        t('colTime'),
                      ),
                      h(
                        'span',
                        {
                          className: 'dsh-rum-col',
                          role: 'columnheader',
                          onMouseEnter: (event) => hint.enter('header:ttft', event),
                          onMouseLeave: hint.leave,
                        },
                        t('colTtft'),
                      ),
                      h(
                        'span',
                        {
                          className: 'dsh-rum-col',
                          role: 'columnheader',
                          onMouseEnter: (event) => hint.enter('header:speed', event),
                          onMouseLeave: hint.leave,
                        },
                        t('colSpeed'),
                      ),
                      h(
                        'span',
                        {
                          className: 'dsh-rum-col',
                          role: 'columnheader',
                          onMouseEnter: (event) => hint.enter('header:tokens', event),
                          onMouseLeave: hint.leave,
                        },
                        t('colTokens'),
                      ),
                      h(
                        'span',
                        {
                          className: 'dsh-rum-col',
                          role: 'columnheader',
                          onMouseEnter: (event) => hint.enter('header:total', event),
                          onMouseLeave: hint.leave,
                        },
                        t('colTotal'),
                      ),
                      h(
                        'span',
                        {
                          className: 'dsh-rum-col',
                          role: 'columnheader',
                          onMouseEnter: (event) => hint.enter('header:amortized', event),
                          onMouseLeave: hint.leave,
                        },
                        t('colAmortized'),
                      ),
                    ),
                    live !== null
                      ? h(
                          'div',
                          {
                            /*
 * `dsh-rum-item` is part of the identity, not decoration: the highlight rules are written
 * as `.dsh-rum-item[data-switched="true"]`, so a row without it silently ignores its own
 * attributes. The live row used to be the only row missing the class, which is why a
 * switched live row never turned blue.
 */
                            className: 'dsh-rum-row dsh-rum-item dsh-rum-live-row',
                            role: 'row',
                            /*
                             * The live row carries the same two highlights as a settled one, so a
                             * model switch is visible the moment the request starts rather than
                             * only once its row is numbered.
                             */
                            'data-switched': live.switched === true ? 'true' : undefined,
                            'data-lowcache': isLowCacheHit(live) ? 'true' : undefined,
                          },
                          /*
                           * A pulsing dot, no word.
                           *
                           * The row is already distinguished by its tint and its position, and
                           * the index column is narrow: printing "streaming" there pushed the
                           * whole grid right and clipped the label. The dot carries the same
                           * meaning in the space a row number would take, and the accessible
                           * name still says what it is.
                           */
                          h(
                            'span',
                            {
                              className: 'dsh-rum-col dsh-rum-index',
                              role: 'cell',
                              'aria-label':
                                live.compaction !== null && live.compaction !== undefined
                                  ? t('drawerCompacting')
                                  : t('drawerLive'),
                              /*
                               * The T marker explains itself while tools run: which tool, and how
                               * long it has been going. The total column carries the same sentence,
                               * so a reader who hovers either one learns the same thing.
                               */
                              /* A supplier, not a string: the span must keep counting while open. */
                              /*
 * A thunk plus `live: true`. The thunk re-reads the span, and the flag asks for the
 * heartbeat that causes the re-read — a thunk alone would still be frozen by the
 * component's leisurely 30 s clock. The clock itself comes from the supplier, so the
 * figure is as fresh as the heartbeat, not as fresh as the component.
 */
                              onMouseEnter: (event) =>
                                hint.enter('live:index', event),
                              onMouseLeave: hint.leave,
                            },
                            /*
                             * The same glyphs the status pill uses, so a marker means one thing
                             * wherever it appears: the bolt for a reply, the T for its tools,
                             * the three bars for a compaction.
                             */
                            live.compaction !== null && live.compaction !== undefined
                              ? h(CompactionIcon, { className: 'dsh-rum-live-bolt dsh-rum-compaction-icon' })
                              : live.phase === 'tools'
                                ? h(ToolIcon, { className: 'dsh-rum-live-bolt dsh-rum-tool-icon' })
                                : h(BoltIcon, { className: 'dsh-rum-live-bolt' }),
                          ),
                          /*
                           * The clock, not the word "streaming".
                           *
                           * The Statistics view prints a step's `step/start` time as soon as
                           * the step exists, including while it is still running. Putting the
                           * label in this column made the live row the only row in the table
                           * without a time, so it could not be matched against the log at all.
                           * The label still identifies the row — it just sits in the index
                           * column, which is where a marker belongs.
                           */
                          h(
                            'span',
                            {
                              className: 'dsh-rum-col',
                              role: 'cell',
                              'data-align': 'start',
                              /* The same absolute stamp the numbered rows show. */
                              onMouseEnter: (event) => hint.enter('live:clock', event),
                              onMouseLeave: hint.leave,
                            },
                            clockText(live.at),
                          ),
                          h('span', { className: 'dsh-rum-col', role: 'cell' }, secondsText(live.ttftMs, t)),
                          h(
                            'span',
                            {
                              className: 'dsh-rum-col dsh-rum-primary',
                              role: 'cell',
                              /*
                               * The same hint the numbered rows carry: which model is answering.
                               * A compaction names its own summarizer; a request names the model
                               * the plan worked out, and falls back to the generic wording while
                               * nothing is known yet — a turn's first step with no header.
                               */
                              onMouseEnter: (event) => hint.enter('live:speed', event),
                              onMouseLeave: hint.leave,
                            },
                            live.compaction !== null && live.compaction !== undefined
                              ? t('compactionSpeed')
                              : speedText(live.speed, live.estimated === true, t),
                          ),
                          h(
                            'span',
                            {
                              className: 'dsh-rum-col',
                              role: 'cell',
                              /* The input side, exactly as the numbered rows report it. */
                              /*
 * While the model is still writing there is no usage, so the hint would report two
 * dashes. Declining it is the same rule the total column follows: say nothing rather
 * than say nothing useful.
 */
                              onMouseEnter: (event) =>
                                hint.enter('live:tokens', event),
                              onMouseLeave: hint.leave,
                            },
                            tokensText(live.tokens, live.estimated === true, t),
                          ),
                          /*
                           * While its tools run, the total column explains what is happening
                           * instead of repeating the frozen model time — the same sentence the T
                           * marker gives. Once every tool has returned there is nothing running,
                           * so the hint disappears rather than claiming a call that already ended.
                           */
                          h(
                            'span',
                            {
                              className: 'dsh-rum-col',
                              role: 'cell',
                              /* A supplier, not a string: the span must keep counting while open. */
                              /*
 * A thunk plus `live: true`. The thunk re-reads the span, and the flag asks for the
 * heartbeat that causes the re-read — a thunk alone would still be frozen by the
 * component's leisurely 30 s clock. The clock itself comes from the supplier, so the
 * figure is as fresh as the heartbeat, not as fresh as the component.
 */
                              onMouseEnter: (event) =>
                                hint.enter('live:total', event),
                              onMouseLeave: hint.leave,
                            },
                            secondsText(
                              live.compaction !== null && live.compaction !== undefined
                                ? compactionSpan(live.compaction, now)
                                : live.totalMs,
                              t,
                            ),
                          ),
                          h(
                            'span',
                            { className: 'dsh-rum-col', role: 'cell' },
                            speedText(live.amortized, live.estimated === true, t),
                          ),
                        )
                      : null,
                    view.map((entry) =>
                      h(
                        'div',
                        {
                          key: entry.key,
                          className:
                            'dsh-rum-row dsh-rum-item' +
                            (entry.row.compaction === true ? ' dsh-rum-compaction-row' : ''),
                          'data-phase': entry.phase,
                          /*
                           * Two independent highlights. A request that changed the routed model
                           * gets the business colour; one whose cache hit fell below the threshold
                           * gets the warn colour. Both are attributes rather than inline colours so
                           * the stylesheet owns the tokens and the dark-mode behaviour.
                           */
                          'data-switched': entry.row.switched === true ? 'true' : undefined,
                          'data-lowcache': isLowCacheHit(entry.row) ? 'true' : undefined,
                          role: 'row',
                        },
                        /*
                         * The index column shows the phase glyph instead of a number while a
                         * request or a compaction is still running: the row is not a finished
                         * record yet, so numbering it would imply it belongs with the ten.
                         */
                        h(
                          'span',
                          {
                            className: 'dsh-rum-index',
                            role: 'cell',
                            /*
                             * Only a highlighted row explains itself here; an ordinary row's number
                             * needs no gloss. The handler is attached unconditionally but returns
                             * nothing to show when the list is empty, so hovering a plain row stays
                             * silent.
                             */
                            /* The attribute is what turns the enlarged target into a visible
                             * affordance; a plain row's number stays an ordinary cursor. */
                            'data-hint': rowHintLines(entry.row, t).length > 0 ? 'true' : undefined,
                            onMouseEnter: (event) => {
                              const lines = rowHintLines(entry.row, t)
                              if (lines.length === 0) return
                              hint.enter(`row:${entry.key}:index`, event)
                            },
                            onMouseLeave: hint.leave,
                          },
                          entry.row.compaction === true
                            ? h(CompactionIcon, {
                                className:
                                  'dsh-rum-live-bolt dsh-rum-compaction-icon' +
                                  (entry.row.running === true ? '' : ' dsh-rum-still'),
                              })
                            : entry.phase === 'tools'
                              ? h(ToolIcon, { className: 'dsh-rum-live-bolt dsh-rum-tool-icon' })
                              : entry.phase === 'writing'
                                ? h(BoltIcon, { className: 'dsh-rum-live-bolt' })
                                : String(entry.index + 1),
                        ),
                        /*
                         * The clock's hint is the absolute timestamp: the relative wording the
                         * cell used to carry in `title` moved into the tooltip once the drawer
                         * gained one, and "3 minutes ago" cannot answer "which one was that".
                         */
                        h(
                          'span',
                          {
                            className: 'dsh-rum-clock',
                            role: 'cell',
                            onMouseEnter: (event) => hint.enter(`row:${entry.key}:clock`, event),
                            onMouseLeave: hint.leave,
                          },
                          clockText(entry.row.at),
                        ),
                        h(
                          'span',
                          { className: 'dsh-rum-col', role: 'cell' },
                          /*
                           * A compaction has no first token, so the column is always the dash.
                           * An interrupted request keeps whatever was measured: one stopped
                           * after its first token shows that real figure.
                           */
                          secondsText(entry.row.compaction === true ? null : entry.row.ttftMs, t),
                        ),
                        h(
                          'span',
                          {
                            className: 'dsh-rum-col dsh-rum-primary',
                            role: 'cell',
                            /*
                             * The hint names the model that served this row. A compaction's
                             * summarizer reuses the routed model, and `compaction/summary`
                             * records it, so both kinds of row can answer.
                             */
                            onMouseEnter: (event) => hint.enter(`row:${entry.key}:speed`, event),
                            onMouseLeave: hint.leave,
                          },
                          /*
                           * A cancelled step never settled and a compaction never generates, so
                           * neither has a rate. The column says what happened instead of the same
                           * dash a request that has not started would show.
                           */
                          entry.row.compaction === true
                            ? t('compactionSpeed')
                            : entry.row.interrupted === true
                              ? t('interrupted')
                              : speedText(entry.row.speed, false, t),
                        ),
                        h(
                          'span',
                          {
                            className: 'dsh-rum-col',
                            role: 'cell',
                            onMouseEnter: (event) => hint.enter(`row:${entry.key}:tokens`, event),
                            onMouseLeave: hint.leave,
                          },
                          tokensText(entry.row.tokens, entry.row.estimated, t),
                        ),
                        h(
                          'span',
                          {
                            className: 'dsh-rum-col',
                            role: 'cell',
                            /*
                             * The hint explains how much of the request was tool time. The figure
                             * in the cell deliberately excludes it, which is exactly why the two
                             * need to be shown together.
                             */
                            onMouseEnter: (event) => hint.enter(`row:${entry.key}:total`, event),
                            onMouseLeave: hint.leave,
                          },
                          secondsText(
                            /*
                             * A running compaction counts up from its own start, exactly as the
                             * pill does, so the two figures cannot diverge; the frozen `wall`
                             * takes over the moment the fold reports it.
                             */
                            entry.row.compaction === true && entry.row.running === true
                              ? compactionSpan(entry.row, now)
                              : entry.row.totalMs,
                            t,
                          ),
                        ),
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

      /*
       * The shipped Statistics view's target, per session.
       *
       * A view target stays undefined until someone subscribes, and a target's `subscribe`
       * is also what activates it. Activation is permanent and shared with whoever else
       * reads it, so subscribing does not add a second fold next to the Statistics view —
       * it joins the one already running. `uiConversation` is an optional service: a
       * composition without it yields no source and the drawer keeps its Chat-derived
       * fallback.
       *
       * The source forwards the target's own `subscribe`, so the component's listener is the
       * one the fold notifies — an internal no-op subscription would activate the target but
       * leave the drawer frozen on its first snapshot.
       *
       * Sources are keyed by session id and created on demand, because the id is only known
       * once the entry renders.
       */
      const statsSources = new Map()
      /*
       * The Statistics target for one session.
       *
       * The target object is looked up FRESH on every call rather than cached alongside the
       * source. `uiConversation.binding(id)` keeps a `BoundConversation` per session, and that
       * object owns the assembler and the view store; when the conversation is rebuilt — a model
       * switch, a reconnect, a released binding — the old `target()` closure keeps pointing at
       * the retired store and returns its last snapshot forever. Caching it froze the drawer on
       * one turn while the Statistics page moved on.
       *
       * Only the subscriptions are cached, because those must be released on eviction and
       * re-subscribing on every render would multiply listeners.
       */
      const STATS_SOURCE_LIMIT = 4
      const statsSourceFor = (sessionId) => {
        if (sessionId === null || sessionId === undefined) return undefined
        const uiConversation = ctx.get('uiConversation')
        if (uiConversation === undefined || uiConversation === null) return undefined

        /** The target that is current right now, or undefined when it cannot be resolved. */
        const targetNow = () => {
          try {
            return uiConversation.binding(sessionId).target(STATS_TARGET) ?? undefined
          } catch {
            // The session was released (or is inactive) — no statistics for it right now.
            return undefined
          }
        }

        const cached = statsSources.get(sessionId)
        if (cached !== undefined) {
          // Refresh recency so the active conversation is the last one evicted.
          statsSources.delete(sessionId)
          statsSources.set(sessionId, cached)
          return cached.source
        }

        /*
         * Each listener is bound to the target that was current when it subscribed; a listener
         * whose target has since been replaced is re-bound the next time it asks, which is what
         * keeps a drawn row tracking the live fold instead of a retired one.
         */
        const subscriptions = new Map()

        const bind = (listener) => {
          const target = targetNow()
          if (target === undefined) return
          const entry = subscriptions.get(listener)
          if (entry !== undefined && entry.target === target) return
          if (entry !== undefined) {
            try {
              entry.unsubscribe()
            } catch {}
            subscriptions.delete(listener)
          }
          try {
            subscriptions.set(listener, { target, unsubscribe: target.subscribe(listener) })
          } catch {}
        }

        const dispose = (listener) => {
          const entry = subscriptions.get(listener)
          if (entry === undefined) return
          subscriptions.delete(listener)
          try {
            entry.unsubscribe()
          } catch {}
        }

        const source = {
          /** Always the newest snapshot the session's own target holds. */
          getSnapshot: () => {
            const target = targetNow()
            return target === undefined ? undefined : target.getSnapshot()
          },
          subscribe: (listener) => {
            bind(listener)
            return () => dispose(listener)
          },
          /**
           * Re-point every listener at the target that is current now.
           *
           * Called on each render: one map lookup per listener, and it is what lets the drawer
           * follow a conversation that was rebuilt underneath it.
           */
          refresh: () => {
            for (const listener of [...subscriptions.keys()]) bind(listener)
          },
          release: () => {
            for (const listener of [...subscriptions.keys()]) dispose(listener)
          },
        }

        statsSources.set(sessionId, { source })
        while (statsSources.size > STATS_SOURCE_LIMIT) {
          const oldest = statsSources.keys().next()
          if (oldest.done === true) break
          const evicted = statsSources.get(oldest.value)
          statsSources.delete(oldest.value)
          try {
            evicted?.source?.release?.()
          } catch {}
        }
        return source
      }
      ctx.effect(
        () => () => {
          for (const entry of statsSources.values()) {
            try {
              entry.source.release?.()
            } catch {}
          }
          statsSources.clear()
        },
        'dsh-recent-usage-metrics: stats targets',
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
                inject: (sessionId) => ({
                  hooks: {
                    geek: { getSnapshot: model.getMode, subscribe: model.subscribe },
                    rows: { getSnapshot: model.getRows, subscribe: model.subscribe },
                  },
                  replaceRows: (next) => model.replace(next),
                  bindSession: (id) => model.useSession(id),
                  /**
                   * The shipped Statistics view's data source for this session, or
                   * `undefined` when that view is absent. A thunk because the source is
                   * created on demand, once the entry reports its session id.
                   */
                  statsSource: () => statsSourceFor(sessionId),
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
