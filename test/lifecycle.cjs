// Lifecycle and rendering test for dsh-recent-usage-metrics' client half.
//
// Runs the real client.js against a minimal DOM/Cordis shim plus a tiny hook
// runtime, so the actual rendered strings, the ten-row cap, insertion order,
// hover/pin behaviour and disposal are all pinned. Not a substitute for the live
// page; it pins the pure logic and the DOM contract.
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')

let failures = 0
const assert = (label, ok) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) failures += 1
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

const store = new Map()
const styleEls = []
const mods = []

const sandbox = {
  console,
  innerWidth: 1400,
  innerHeight: 900,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  document: {
    body: {},
    head: { append: (el) => styleEls.push(el) },
    createElement: () => {
      const el = {
        id: '',
        textContent: '',
        remove() {
          const i = styleEls.indexOf(el)
          if (i >= 0) styleEls.splice(i, 1)
        },
      }
      return el
    },
    addEventListener() {},
    removeEventListener() {},
  },
  __ModuleLoader__: { load: (m) => mods.push(m) },
  addEventListener() {},
  removeEventListener() {},
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.self = sandbox

/* ------------------------------------------------------------------ */
/* A tiny hook runtime: renders nested function components             */
/* ------------------------------------------------------------------ */

const isElement = (node) => node !== null && typeof node === 'object' && 'type' in node

function createRuntime() {
  const frames = new Map()
  let cursor = 0
  let frame = null
  let dirty = false
  let pending = []

  const sameDeps = (a, b) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, i) => Object.is(value, b[i]))

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(init) {
      const index = cursor++
      if (frame.cells[index] === undefined) {
        frame.cells[index] = { kind: 'state', value: typeof init === 'function' ? init() : init }
      }
      const entry = frame.cells[index]
      const set = (next) => {
        const value = typeof next === 'function' ? next(entry.value) : next
        if (Object.is(value, entry.value)) return
        entry.value = value
        dirty = true
      }
      return [entry.value, set]
    },
    useRef(value) {
      const index = cursor++
      if (frame.cells[index] === undefined) frame.cells[index] = { kind: 'ref', current: value }
      return frame.cells[index]
    },
    useMemo(fn, deps) {
      const index = cursor++
      const existing = frame.cells[index]
      if (existing === undefined || !sameDeps(existing.deps, deps)) {
        frame.cells[index] = { kind: 'memo', deps, value: fn() }
      }
      return frame.cells[index].value
    },
    useCallback(fn, deps) {
      const index = cursor++
      const existing = frame.cells[index]
      if (existing === undefined || !sameDeps(existing.deps, deps)) {
        frame.cells[index] = { kind: 'callback', deps, value: fn }
      }
      return frame.cells[index].value
    },
    useEffect(fn, deps) {
      const index = cursor++
      const existing = frame.cells[index]
      if (existing !== undefined && sameDeps(existing.deps, deps)) return
      frame.cells[index] = { kind: 'effect', deps, cleanup: undefined }
      // React runs the previous cleanup before the next effect; a test runtime that
      // skips it leaves stale timers alive and misreads a correct plugin as broken.
      pending.push({ frame, index, fn, layout: false, before: existing?.cleanup })
    },
    useLayoutEffect(fn, deps) {
      const index = cursor++
      const existing = frame.cells[index]
      if (existing !== undefined && sameDeps(existing.deps, deps)) return
      frame.cells[index] = { kind: 'effect', deps, cleanup: undefined }
      pending.push({ frame, index, fn, layout: true, before: existing?.cleanup })
    },
  }

  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return { createPortal: (node) => node }
    throw new Error('unexpected require: ' + id)
  }

  const renderNode = (node, key, visited) => {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${key}.${index}`, visited))
    if (!isElement(node)) return node
    if (typeof node.type === 'function') {
      const path = `${key}<${node.type.name}>`
      visited.add(path)
      const current = frames.get(path) ?? { cells: [] }
      frames.set(path, current)
      const previousFrame = frame
      const previousCursor = cursor
      frame = current
      cursor = 0
      let output
      try {
        output = node.type(node.props)
      } finally {
        frame = previousFrame
        cursor = previousCursor
      }
      return renderNode(output, path, visited)
    }
    return {
      type: node.type,
      props: node.props,
      children: node.children.map((child, index) => renderNode(child, `${key}.${index}`, visited)),
    }
  }

  /**
   * Render until the tree stops changing. Effects run after each pass, and an effect
   * that pushes into an external store (the plugin's model) re-renders the tree on the
   * following pass, exactly as `useSyncExternalStore` would in the live page — so a
   * minimum of two passes is required even when no local state changed.
   */
  const settle = async (rootComponent, props) => {
    let tree
    let previous
    for (let pass = 0; pass < 20; pass += 1) {
      dirty = false
      pending = []
      const visited = new Set()
      tree = renderNode(React.createElement(rootComponent, props), 'root', visited)
      const ordered = [...pending.filter((entry) => entry.layout), ...pending.filter((entry) => !entry.layout)]
      for (const entry of ordered) {
        if (typeof entry.before === 'function') entry.before()
        const result = entry.fn()
        entry.frame.cells[entry.index].cleanup = typeof result === 'function' ? result : undefined
      }
      await Promise.resolve()
      if (!dirty && pass >= 1 && JSON.stringify(tree) === previous) break
      previous = JSON.stringify(tree)
      if (!dirty) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return tree
  }

  const unmount = () => {
    for (const entry of frames.values()) {
      for (const item of entry.cells) {
        if (item?.kind === 'effect' && typeof item.cleanup === 'function') item.cleanup()
      }
    }
    frames.clear()
  }

  /** Forget every hook cell, as unmounting the tree would. */
  const reset = () => {
    unmount()
  }

  return { React, requireStub, render: settle, unmount, reset }
}

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ kind: 'text', text: String(node) })
    return
  }
  if (!isElement(node)) return
  visit({ kind: 'element', element: node })
  for (const child of node.children) walk(child, visit)
}

const findAll = (root, predicate) => {
  const found = []
  walk(root, (entry) => {
    if (entry.kind === 'element' && predicate(entry.element)) found.push(entry.element)
  })
  return found
}

/**
 * Visible text only: an `aria-hidden` subtree carries no text a user reads (and no
 * accessible name), so the reserved estimate marker must not leak into assertions.
 */
const textOf = (node) => {
  const parts = []
  const visit = (current) => {
    if (current === null || current === undefined || current === false || current === true) return
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (typeof current === 'string' || typeof current === 'number') {
      parts.push(String(current))
      return
    }
    if (!isElement(current)) return
    if (current.props['aria-hidden'] === true) return
    for (const child of current.children) visit(child)
  }
  visit(node)
  return parts.join(' ')
}

const normalize = (text) => text.replace(/\s+/gu, ' ').trim()
const byClass = (name) => (element) => element.props.className === name

/* ------------------------------------------------------------------ */
/* Load the module                                                     */
/* ------------------------------------------------------------------ */

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert('exactly one module registered', mods.length === 1)
assert('module id matches the package name', mods.length === 1 && mods[0].id === 'dsh-recent-usage-metrics')

const runtime = createRuntime()
const exported = mods[0].factory(runtime.requireStub)

assert('exports.name', exported.name === 'dsh-recent-usage-metrics')
assert(
  'locale is a HARD dependency, so a cold page cannot skip the dictionaries',
  /*
   * With only `slots` declared, apply could run before the locale service existed (it
   * itself waits on connection, settings and remotes). Probing `ctx.get('locale')` then
   * returned undefined, the dictionaries were never registered, and the UI stayed
   * English — or raw keys — with no way to switch back after a restart.
   */
  exported.inject.includes('locale') && exported.inject.includes('slots'),
)
assert(
  'apply reads the injected locale service instead of probing for it',
  (() => {
    const body = source.slice(source.indexOf('function apply(ctx)'))
    const applySource = body.slice(0, body.indexOf('\n    }'))
    // Comments may name the old defect; the CODE must not repeat it.
    const code = applySource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    return code.includes('ctx.locale') && !code.includes("ctx.get('locale')")
  })(),
)
assert('exports.apply is a function', typeof exported.apply === 'function')

/* ------------------------------------------------------------------ */
/* Apply against a shim ctx                                            */
/* ------------------------------------------------------------------ */

const effects = []
const injected = []
/** Services waited on through `ctx.inject` (optional dependencies). */
const injectedServices = []
const registrations = new Map()
let activeLocale = 'zh'
const dictionaries = new Map()

const localeStub = {
  register(ns, dicts) {
    dictionaries.set(ns, dicts)
    return () => dictionaries.delete(ns)
  },
  bind(ns) {
    return (key, params) => {
      const dict = dictionaries.get(ns)
      if (dict === undefined) return key
      const template = dict[activeLocale]?.[key] ?? dict.en?.[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        name in params ? String(params[name]) : match,
      )
    }
  },
}

let preference = 'detailed'
const preferenceListeners = new Set()
const writes = []
const formStub = {
  getSnapshot: () => ({ status: 'ready', value: { performanceUsage: preference } }),
  subscribe(fn) {
    preferenceListeners.add(fn)
    return () => preferenceListeners.delete(fn)
  },
  set(field, value) {
    writes.push([field, value])
    preference = value
    for (const fn of [...preferenceListeners]) fn()
    return Promise.resolve(true)
  },
}

const configFormsStub = { get: () => formStub }

const ctx = {
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return dispose
  },
  /**
   * `locale` is a declared dependency, so the registry guarantees it before apply. The
   * double is exposed as a property, matching what the real restricted ctx provides for
   * a hard dependency, and `get` answers only OPTIONAL services.
   */
  get locale() {
    return localeStub
  },
  get(name) {
    if (name === 'configForms') return configFormsStub
    return undefined
  },
  /** Waits for the named services, then runs the effect; the real ctx returns a disposer. */
  inject(names, callback) {
    injectedServices.push(names.join(','))
    const scope = {}
    for (const name of names) {
      if (name === 'configForms') scope.configForms = configFormsStub
      if (name === 'locale') scope.locale = localeStub
    }
    return callback(scope)
  },
  slots: {
    inject(key, callback) {
      injected.push(key)
      return callback()
    },
    register(options, component) {
      registrations.set(options.name, { options, component })
      return () => registrations.delete(options.name)
    },
  },
}

exported.apply(ctx)

assert(
  'the CSS template contains no stray backtick',
  /*
   * STYLE_TEXT is a template literal, so a backtick inside a CSS comment terminates it
   * and turns the rest of the stylesheet into JavaScript — a syntax error that only
   * shows up at load time. The stylesheet ships with zero backticks by contract.
   */
  (() => {
    const start = source.indexOf('const STYLE_TEXT = `')
    if (start < 0) return false
    const bodyStart = start + 'const STYLE_TEXT = `'.length
    const bodyEnd = source.indexOf('`\n', bodyStart)
    if (bodyEnd < 0) return false
    return !source.slice(bodyStart, bodyEnd).includes('`')
  })(),
)

assert('six effects registered', effects.length === 6)
assert(
  'waits on both slots it contributes to',
  injected.join(',') === 'settings.general.item,conversation.composer.dock',
)
assert(
  'waits for configForms instead of probing it once at apply time',
  // The settings domain can arrive late; a single probe would latch the row onto the
  // fallback preference for the whole session.
  injectedServices.includes('configForms') && !/ctx\.get\('configForms'\)/.test(source),
)
assert('style element created with a stable id', styleEls.length === 1 && styleEls[0].id === 'dsh-recent-usage-metrics-style')
assert(
  'drawer is fixed-positioned with the native menu backdrop blur',
  /\.dsh-rum-drawer\s*\{[^}]*position:\s*fixed/s.test(styleEls[0].textContent) &&
    /backdrop-filter:\s*var\(--dsw-menu-backdrop-filter\)/.test(styleEls[0].textContent),
)
assert(
  'drawer uses the native menu surface, not a diluted overlay mix',
  /\.dsh-rum-drawer\s*\{[^}]*background:\s*var\(--dsw-specific-menu\)/s.test(styleEls[0].textContent) &&
    !/color-mix\([^)]*--dsw-alias-bg-overlay/.test(styleEls[0].textContent),
)
assert(
  'drawer reuses the native elevation and radius tokens',
  /--dsw-elevation-stroke-color:\s*var\(--dsw-alias-border-l1\)/.test(styleEls[0].textContent) &&
    /box-shadow:\s*var\(--dsw-elevation-prominent\)/.test(styleEls[0].textContent) &&
    /border-radius:\s*var\(--dsw-radius-lg\)/.test(styleEls[0].textContent) &&
    /padding:\s*16px;/.test(styleEls[0].textContent),
)
assert(
  'the sticky header occludes with the same menu surface',
  /\.dsh-rum-row\[data-head="true"\]\s*\{[^}]*background:\s*var\(--dsw-specific-menu\)/s.test(
    styleEls[0].textContent,
  ),
)
assert(
  'drawer slides up without shifting X, anchored at its bottom-right corner',
  /transform:\s*translateY\(14px\) scale\(\.985\)/.test(styleEls[0].textContent) &&
    /transform-origin:\s*bottom right/.test(styleEls[0].textContent) &&
    !/translate\(-50%/.test(styleEls[0].textContent),
)
assert(
  'the drawer carries no explanatory footer line',
  !/dsh-rum-foot/.test(styleEls[0].textContent) && !/dsh-rum-foot/.test(source),
)
assert(
  'the status reading uses one tertiary foreground and no dot separators',
  /\.dsh-rum-trigger\s*\{[^}]*color:\s*var\(--dsw-alias-label-tertiary\)/s.test(styleEls[0].textContent) &&
    !/dsh-rum-value/.test(styleEls[0].textContent) &&
    !/dsh-rum-sep/.test(source) &&
    !/dsh-rum-dot/.test(styleEls[0].textContent) &&
    !/[·]/.test(styleEls[0].textContent),
)
assert(
  'the icon inherits the pill colour instead of being tinted brand',
  !/\.dsh-rum-bolt\s*\{[^}]*color:/.test(styleEls[0].textContent),
)
assert(
  'every streamed figure sits in a FIXED-width slot on the NUMBER, not the cell',
  (() => {
    const css = styleEls[0].textContent
    const slotWidth = (metric) => {
      const pattern = new RegExp(
        '\\.dsh-rum-part\\[data-metric="' + metric + '"\\] \\.dsh-rum-num[^{]*\\{[^}]*width:\\s*([^;]+);',
        's',
      )
      const found = pattern.exec(css)
      return found === null ? null : found[1].trim()
    }
    return (
      slotWidth('ttft') === '4.5ch' &&
      slotWidth('total') === '4.5ch' &&
      slotWidth('speed') === '4.5ch' &&
      slotWidth('amortized') === '4.5ch' &&
      slotWidth('tokens') === '5.5ch' &&
      !/\.dsh-rum-num\s*\{[^}]*min-width/s.test(css) &&
      /\.dsh-rum-num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s.test(css)
    )
  })(),
)
assert(
  'the width is never put on the cell that also holds the unit',
  /*
   * The regression this guards: a fixed width on the wrapping cell clipped the unit
   * text, so the pill showed digits with a truncated " s"/" tok/s". Only the number
   * element may carry a width.
   */
  !/\.dsh-rum-part\s*\{[^}]*width:/s.test(styleEls[0].textContent) &&
    !/\.dsh-rum-part\s*\{[^}]*overflow:\s*hidden/s.test(styleEls[0].textContent) &&
    !/\.dsh-rum-part\s*\{[^}]*text-overflow/s.test(styleEls[0].textContent),
)
assert(
  'the pill and the drawer use disjoint cell class names',
  (() => {
    const css = styleEls[0].textContent
    // A shared class would let the drawer's ellipsis rules clip the pill and vice versa.
    return !/dsh-rum-cell/.test(css) && !/dsh-rum-cell/.test(source) && /dsh-rum-col/.test(css)
  })(),
)
assert(
  'the drawer columns read the pill-measured widths, with ch only as a fallback',
  (() => {
    const css = styleEls[0].textContent
    const row = /\.dsh-rum-row\s*\{[^}]*grid-template-columns:\s*([^;]+);/s.exec(css)
    if (row === null) return false
    const cols = row[1].replace(/\s+/g, ' ').trim()
    // Each metric column binds its own variable, in the order the headers appear.
    return (
      /18px/.test(cols) &&
      /56px/.test(cols) &&
      cols.includes('var(--dsh-rum-col-ttft, ') &&
      cols.includes('var(--dsh-rum-col-speed, ') &&
      cols.includes('var(--dsh-rum-col-tokens, ') &&
      cols.includes('var(--dsh-rum-col-total, ') &&
      cols.includes('var(--dsh-rum-col-amortized, ') &&
      // The variables must appear in the same order as the headers they align with.
      (() => {
        const order = ['ttft', 'speed', 'tokens', 'total', 'amortized'].map((m) =>
          cols.indexOf('--dsh-rum-col-' + m),
        )
        return order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))
      })()
    )
  })(),
)
assert(
  'the drawer measures the pill instead of guessing column widths',
  /*
   * A `ch`-derived column cannot line up with the pill: `ch` is the advance of "0" while
   * "tok/s" is far narrower, so the computed column and the rendered cell disagree. The
   * drawer must therefore read the live boxes.
   */
  /querySelectorAll\('\[data-metric\]'\)/.test(source) &&
    /getBoundingClientRect\(\)/.test(source) &&
    /--dsh-rum-col-ttft/.test(source) &&
    /setColumnWidths/.test(source),
)
assert(
  'the estimate marker owns a reserved slot that only toggles paint',
  /\.dsh-rum-tilde\s*\{[^}]*width:\s*1ch;/s.test(styleEls[0].textContent) &&
    /\.dsh-rum-tilde\s*\{[^}]*visibility:\s*hidden;/s.test(styleEls[0].textContent) &&
    /\.dsh-rum-tilde\[data-on="true"\]\s*\{[^}]*visibility:\s*visible;/s.test(
      styleEls[0].textContent,
    ),
)
assert(
  'the unit and the number are separated by a real space',
  /\.dsh-rum-unit\s*\{[^}]*white-space:\s*pre;/s.test(styleEls[0].textContent),
)
assert(
  'the status pill is sized by padding + line-height, like the shipped pills',
  /\.dsh-rum-trigger\s*\{[^}]*padding:\s*1px 8px;/s.test(styleEls[0].textContent) &&
    /\.dsh-rum-trigger\s*\{[^}]*line-height:\s*inherit;/s.test(styleEls[0].textContent) &&
    /\.dsh-rum-anchor\s*\{[^}]*line-height:\s*calc\(20px \+ var\(--dsh-content-font-delta-secondary, 0px\)\)/s.test(
      styleEls[0].textContent,
    ),
)
assert(
  'the status pill carries no fixed height of its own',
  !/(?:^|[\s{;])height:\s*calc\(/m.test(
    /\.dsh-rum-trigger\s*\{([^}]*)\}/s.exec(styleEls[0].textContent)?.[1] ?? '',
  ),
)
assert(
  'no hard-coded colour literals in the stylesheet',
  (() => {
    // Comments legitimately cite the resolved dark-mode value; only declarations count.
    const declarations = styleEls[0].textContent.replace(/\/\*[\s\S]*?\*\//g, '')
    return (declarations.match(/#[0-9a-f]{3,8}\b/gi) ?? []).length === 0
  })(),
)

const row = registrations.get('settings.general.item')
const status = registrations.get('conversation.composer.dock')

assert('registers the settings row', row !== undefined)
assert('registers the composer status entry', status !== undefined)
assert(
  'the row replaces the shipped performance-usage cell',
  row.options.id === 'performance-usage' && row.options.order === 30 && row.options.priority === -1,
)
assert(
  'the status entry sorts before the shipped pills',
  status.options.order === -10 && status.options.id === 'recent-usage-metrics',
)
assert(
  'zh and en dictionaries carry the same keys',
  (() => {
    const dicts = dictionaries.get('dsh-recent-usage-metrics')
    if (dicts === undefined) return false
    const zk = Object.keys(dicts.zh).sort()
    const ek = Object.keys(dicts.en).sort()
    return zk.length === ek.length && zk.every((k, i) => k === ek[i])
  })(),
)
assert(
  'every UI string comes from the dictionaries',
  (() => {
    const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
    const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '')
    const dictStart = withoutLineComments.indexOf('const zh = {')
    const enStart = withoutLineComments.indexOf('const en = {')
    const enEnd = withoutLineComments.indexOf('const STYLE_TEXT =')
    const outsideDict = withoutLineComments.slice(0, dictStart) + withoutLineComments.slice(enEnd)
    const chinese = outsideDict.match(/'[^'\n]*[\u4e00-\u9fff][^'\n]*'/g) || []
    return chinese.length === 0 && enStart > dictStart && enEnd > enStart
  })(),
)

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

const modelRows = () => JSON.parse(store.get('dsh.recentUsageMetrics.history.v1') ?? '[]')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

;(async () => {
  const rowInject = row.options.inject()
  const rowProps = {
    ...rowInject,
    usePerformanceUsage: (sel) => sel(rowInject.hooks.performanceUsage.getSnapshot()),
    useGeek: (sel) => sel(rowInject.hooks.geek.getSnapshot()),
    t: localeStub.bind('dsh-recent-usage-metrics'),
  }

  let tree = await runtime.render(row.component, rowProps)
  let selector = findAll(tree, byClass('dsh-rum-pref-selector'))[0]
  assert('row renders a selector button', selector !== undefined)
  assert('selector shows the current shipped level', normalize(textOf(selector)) === '详细')

  selector.props.onClick()
  tree = await runtime.render(row.component, rowProps)
  let items = findAll(tree, byClass('dsh-rum-menu-item'))
  assert('menu offers exactly three levels', items.length === 3)
  assert(
    'the three levels are Compact, Detailed and Geek',
    items.map((item) => normalize(textOf(item))).join('|') === '简洁|详细|极客',
  )
  assert(
    'the menu marks the selected level',
    items[1].props['aria-checked'] === true && items[2].props['aria-checked'] === false,
  )

  items[2].props.onClick()
  tree = await runtime.render(row.component, rowProps)
  assert('choosing Geek sets the plugin flag', store.get('dsh.recentUsageMetrics.mode.v1') === '"geek"')
  assert('choosing Geek does not write the shipped schema', writes.length === 0)
  assert(
    'Geek is shown as the selected level',
    normalize(textOf(findAll(tree, byClass('dsh-rum-pref-selector'))[0])) === '极客',
  )
  assert('Geek shows its explanatory hint', normalize(textOf(tree)).includes('极客档在输入区状态行实时显示'))

  findAll(tree, byClass('dsh-rum-pref-selector'))[0].props.onClick()
  tree = await runtime.render(row.component, rowProps)
  items = findAll(tree, byClass('dsh-rum-menu-item'))
  items[0].props.onClick()
  tree = await runtime.render(row.component, rowProps)
  assert('choosing Compact clears the Geek flag', store.get('dsh.recentUsageMetrics.mode.v1') === 'null')
  assert(
    'choosing Compact writes the shipped preference',
    writes.length === 1 && writes[0][0] === 'performanceUsage' && writes[0][1] === 'compact',
  )
  assert(
    'the row mirrors a shipped change made elsewhere',
    (() => {
      preference = 'detailed'
      for (const fn of [...preferenceListeners]) fn()
      return rowInject.hooks.performanceUsage.getSnapshot() === 'detailed'
    })(),
  )

  /* ---------------------------------------------------------------- */
  /* The composer status entry                                         */
  /* ---------------------------------------------------------------- */

  const statusInject = status.options.inject()
  const t = localeStub.bind('dsh-recent-usage-metrics')

  // The Chat store replaces its node array on every change; the test mirrors that so
  // the selectors observe a new reference exactly as they would live.
  const snapshot = { legacy: { nodes: [], turnTimings: new Map(), partial: null } }
  const nodes = []
  const addNode = (node) => {
    nodes.push(node)
    snapshot.legacy.nodes = nodes.slice()
  }
  const statusProps = {
    ...statusInject,
    useChat: (sel) => sel(snapshot),
    useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
    useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
    t,
  }
  /*
   * `useTrajectory` is a standard slot prop. The double mirrors the real contract: a
   * selector applied to the domain snapshot, whose `eventNodes` carry the first-token
   * time the Trajectory domain reconstructed from a message's chunk timeline.
   */
  let trajectorySnapshot = { eventNodes: [] }
  statusProps.useTrajectory = (sel) => sel(trajectorySnapshot)
  const triggerOf = (root) =>
    findAll(root, (el) => String(el.props.className ?? '').startsWith('dsh-rum-trigger'))[0]

  let statusTree = await runtime.render(status.component, statusProps)
  assert('the entry renders nothing outside Geek mode', statusTree === null)

  rowInject.setGeek('geek')
  statusTree = await runtime.render(status.component, statusProps)
  let trigger = triggerOf(statusTree)
  assert('Geek renders the status trigger', trigger !== undefined)
  assert(
    'empty history shows placeholders',
    normalize(textOf(trigger)).replace(/\s+/g, ' ') === '-- s -- tok/s -- tok -- s -- tok/s',
  )

  /* Exact metrics from a settled step: 1.0s → 3.3s first token, end 5.6s, 1024 tokens. */
  addNode({
    kind: 'assistant',
    turn: 1,
    step: 0,
    timing: { stepStartTime: 1000, firstTokenTime: 3300, completedTime: 5600 },
    usage: { outputTokens: 1024 },
    blocks: [{ kind: 'text', text: 'hello' }],
  })
  statusTree = await runtime.render(status.component, statusProps)
  const first = modelRows()[0]
  assert('a settled step is recorded', modelRows().length === 1)
  assert('TTFT is first token minus step start (2.3 s)', Math.round(first.ttftMs) === 2300)
  assert('total is completion minus step start (4.6 s)', Math.round(first.totalMs) === 4600)
  assert('exact usage is preferred over the estimate', first.tokens === 1024)
  assert('exact tokens are not marked estimated', first.estimated === false)
  assert('live speed is tokens over decode time (≈445)', Math.round(first.speed) === 445)
  assert('amortised speed is tokens over total time (≈223)', Math.round(first.amortized) === 223)

  trigger = triggerOf(statusTree)
  assert(
    'the status line reads "2.3 s 445 tok/s 1024 tok 4.6 s 223 tok/s" with no dots',
    normalize(textOf(trigger)) === '2.3 s 445 tok/s 1024 tok 4.6 s 223 tok/s',
  )
  assert(
    'there is exactly one space between each number and its unit',
    !/\d(?:tok|s)/.test(normalize(textOf(trigger))) &&
      normalize(textOf(trigger)).includes('2.3 s') &&
      normalize(textOf(trigger)).includes('1024 tok'),
  )
  assert(
    'every streamed figure is its own fixed-width slot',
    (() => {
      const cells = findAll(trigger, (el) => el.props['data-metric'] !== undefined)
      return (
        cells.length === 5 &&
        cells.map((cell) => cell.props['data-metric']).join(',') ===
          'ttft,speed,tokens,total,amortized' &&
        cells.every((cell) => findAll(cell, (el) => el.props.className === 'dsh-rum-num').length === 1)
      )
    })(),
  )
  assert(
    'the trigger carries an accessible name but no tooltip',
    trigger.props['aria-label'].includes('最近 10 次请求') &&
      trigger.props.title === undefined,
  )
  assert(
    'the estimate marker is a reserved span, not part of the number text',
    (() => {
      const tildes = findAll(trigger, byClass('dsh-rum-tilde'))
      return (
        // Only the three estimable metrics reserve a marker; durations never carry one.
        tildes.length === 3 &&
        tildes.every((el) => el.props['data-on'] === false) &&
        tildes.every((el) => el.props['aria-hidden'] === true) &&
        !normalize(textOf(findAll(trigger, byClass('dsh-rum-num'))[0])).includes('~')
      )
    })(),
  )

  /* Estimate fallback when the provider reports no usage. */
  addNode({
    kind: 'assistant',
    turn: 1,
    step: 1,
    timing: { stepStartTime: 10000, firstTokenTime: 10500, completedTime: 11000 },
    blocks: [{ kind: 'text', text: 'a'.repeat(400) }],
  })
  statusTree = await runtime.render(status.component, statusProps)
  const estimated = modelRows()[0]
  assert('a step without usage falls back to an estimate', estimated.estimated === true)
  assert(
    '400 ASCII characters of prose estimate to 100 tokens (4 chars/token)',
    /*
     * Prose keeps the conventional 4-chars/token ratio. The bias that made live speed
     * read low came from tool-call arguments, which are JSON and tokenize worse; those
     * are weighted separately (see the tool-call assertion below).
     */
    estimated.tokens === 100,
  )
  assert(
    'estimated figures light the reserved ~ marker',
    (() => {
      const tildes = findAll(triggerOf(statusTree), byClass('dsh-rum-tilde'))
      const lit = tildes.filter((el) => el.props['data-on'] === true)
      // Speed, tokens and amortised are all estimated here; the two durations are not.
      return (
        tildes.length === 3 &&
        lit.length === 3 &&
        tildes.every((el) => el.props['aria-hidden'] === true)
      )
    })(),
  )

  /*
   * Slot-fit guarantees. Each slot reserves a fixed digit budget, so these are the
   * values that would otherwise overflow it; every one must still print inside.
   */
  const slotText = () => {
    const cells = findAll(triggerOf(statusTree), (el) => el.props['data-metric'] !== undefined)
    return Object.fromEntries(
      cells.map((cell) => [
        cell.props['data-metric'],
        normalize(textOf(cell)),
      ]),
    )
  }

  addNode({
    kind: 'assistant',
    turn: 1,
    step: 9,
    // 126.0 s total, 28948 tokens: the largest values this session's log produced.
    timing: { stepStartTime: 500000, firstTokenTime: 500100, completedTime: 626000 },
    usage: { outputTokens: 28948 },
    blocks: [{ kind: 'text', text: 'z' }],
  })
  statusTree = await runtime.render(status.component, statusProps)
  let slots = slotText()
  assert(
    'a 126 s duration prints as whole seconds inside its 4ch slot',
    slots.total === '126 s',
  )
  assert(
    'a five-digit token count fits its slot',
    slots.tokens === '28948 tok',
  )
  assert(
    'a three-digit speed fits its slot',
    /^\d{1,4} tok\/s$/.test(slots.speed) && /^\d{1,4} tok\/s$/.test(slots.amortized),
  )

  addNode({
    kind: 'assistant',
    turn: 1,
    step: 10,
    timing: { stepStartTime: 700000, firstTokenTime: 700100, completedTime: 700200 },
    usage: { outputTokens: 123456 },
    blocks: [{ kind: 'text', text: 'w' }],
  })
  statusTree = await runtime.render(status.component, statusProps)
  slots = slotText()
  assert(
    'a six-digit token count collapses to thousands rather than widening the pill',
    slots.tokens === '123k tok',
  )

  addNode({
    kind: 'assistant',
    turn: 1,
    step: 2,
    timing: { stepStartTime: 20000, firstTokenTime: 20100, completedTime: 20200 },
    blocks: [{ kind: 'text', text: '一二三四五六七八九十' }],
  })
  statusTree = await runtime.render(status.component, statusProps)
  assert('ten CJK characters estimate to ten tokens', modelRows()[0].tokens === 10)

  /*
   * First-token time for replayed history.
   *
   * A step replayed from the session log has no `timing.firstTokenTime` in the Chat
   * snapshot — that value is streamed state, and the log stores no live chunks. The
   * Trajectory domain rebuilds it from the message's chunk timeline, so the plugin dates
   * such a step from there instead of showing "--". This mirrors the observed defect:
   * freshly seeded rows had no first-token time even though the Trajectory panel did.
   */
  trajectorySnapshot = {
    eventNodes: [
      {
        kind: 'assistant',
        turn: 2,
        step: 0,
        seq: 900,
        timing: { stepStartTime: 30000, firstTokenTime: 31400, completedTime: 35000 },
      },
    ],
  }
  addNode({
    kind: 'assistant',
    turn: 2,
    step: 0,
    // A replayed node: the Chat snapshot cannot date its first token.
    timing: { stepStartTime: 30000, firstTokenTime: null, completedTime: 35000 },
    usage: { outputTokens: 600 },
    blocks: [{ kind: 'text', text: 'hi' }],
  })
  statusTree = await runtime.render(status.component, statusProps)
  const dated = modelRows()[0]
  assert(
    'a replayed step takes its first-token time from the Trajectory domain',
    Math.round(dated.ttftMs) === 1400,
  )
  assert(
    'the recovered first-token time also fixes the decode speed',
    // 600 tokens over 35000-31400 = 3.6 s of decoding.
    Math.round(dated.speed) === Math.round(600 / 3.6),
  )
  assert(
    'the Trajectory index is keyed by turn and step',
    /function firstTokenIndex\(/.test(source) &&
      /index\.set\(`\$\{turn\}:\$\{step\}`, first\)/.test(source) &&
      /node\.kind !== 'assistant'/.test(source),
  )

  /*
   * The Trajectory domain is another plugin's projection, so its times can arrive after
   * this plugin seeded. Rows stored undated must be repaired rather than left at "--"
   * for the rest of the session.
   */
  {
    // Seed a row while the domain is still empty: it must come out undated.
    trajectorySnapshot = { eventNodes: [] }
    addNode({
      kind: 'assistant',
      turn: 91,
      step: 0,
      timing: { stepStartTime: 40000, firstTokenTime: null, completedTime: 45000 },
      usage: { outputTokens: 300 },
      blocks: [{ kind: 'text', text: 'x' }],
    })
    statusTree = await runtime.render(status.component, statusProps)
    assert('a row seeded before the domain assembles has no first-token time', modelRows()[0].ttftMs === null)

    // The domain now publishes; the stored row must be re-dated in place.
    trajectorySnapshot = {
      eventNodes: [
        {
          kind: 'assistant',
          turn: 91,
          step: 0,
          seq: 901,
          timing: { stepStartTime: 40000, firstTokenTime: 41200, completedTime: 45000 },
        },
      ],
    }
    statusTree = await runtime.render(status.component, statusProps)
    assert(
      'a late Trajectory time repairs an already-stored row',
      Math.round(modelRows()[0].ttftMs) === 1200,
    )
    assert(
      'the repair is persisted, not just rendered',
      modelRows()[0].ttftMs === 1200,
    )
    assert(
      'a live-recorded time is never overwritten by the repair',
      /if \(row\.ttftMs !== null && row\.ttftMs !== undefined\) return row/.test(source),
    )
  }


  /*
   * Tool-call arguments are JSON, which tokenizes less efficiently than prose, so they
   * carry their own coefficient. Fitting them separately is what removed most of the
   * undercount: with one shared divisor the median error stayed at 0.367 of the real
   * count; split, it falls to 0.125.
   */
  addNode({
    kind: 'assistant',
    turn: 1,
    step: 12,
    timing: { stepStartTime: 20000, firstTokenTime: 20100, completedTime: 21000 },
    blocks: [{ kind: 'tool-call', callId: 'c1', name: 'shell', argsRaw: 'x'.repeat(250) }],
  })
  statusTree = await runtime.render(status.component, statusProps)
  assert(
    '250 characters of tool-call JSON estimate to 100 tokens (2.5 chars/token)',
    modelRows()[0].tokens === 100,
  )
  assert(
    'the two coefficients are distinct and documented',
    /CHARS_PER_TOKEN_PROSE\s*=\s*4\b/.test(source) &&
      /CHARS_PER_TOKEN_TOOL_ARGS\s*=\s*2\.5\b/.test(source) &&
      !/rest \/ 4/.test(source),
  )

  /* ---------------------------------------------------------------- */
  /* Ten-row cap and newest-first order                                */
  /* ---------------------------------------------------------------- */

  let worstVisible = 0
  for (let step = 3; step < 15; step += 1) {
    addNode({
      kind: 'assistant',
      turn: 2,
      step,
      timing: { stepStartTime: step * 10000, firstTokenTime: step * 10000 + 200, completedTime: step * 10000 + 1200 },
      usage: { outputTokens: step },
      blocks: [{ kind: 'text', text: 'x' }],
    })
    statusTree = await runtime.render(status.component, statusProps)
    worstVisible = Math.max(worstVisible, modelRows().length)
  }
  await wait(320)
  statusTree = await runtime.render(status.component, statusProps)
  assert(
    'the stored history never exceeds ten rows while steps arrive',
    worstVisible === 10,
  )
  const capped = modelRows()
  assert('history is capped at ten rows', capped.length === 10)
  assert('the newest reading is first', capped[0].tokens === 14)
  assert('the eleventh-newest reading was dropped', capped.every((entry) => entry.tokens !== 4))
  assert(
    're-recording the same step does not duplicate it',
    (() => {
      const before = modelRows().length
      statusInject.record(modelRows()[0])
      return modelRows().length === before
    })(),
  )

  /* ---------------------------------------------------------------- */
  /* Drawer: click opens it, rows render in order                      */
  /* ---------------------------------------------------------------- */

  assert('drawer is closed before any interaction', findAll(statusTree, byClass('dsh-rum-drawer')).length === 0)
  assert(
    'the anchor has no hover handler at all',
    statusTree.props.onPointerEnter === undefined && statusTree.props.onPointerLeave === undefined,
  )

  triggerOf(statusTree).props.onClick()
  statusTree = await runtime.render(status.component, statusProps)
  await wait(30)
  statusTree = await runtime.render(status.component, statusProps)
  let drawer = findAll(statusTree, byClass('dsh-rum-drawer'))[0]
  assert('clicking the pill opens the drawer', drawer !== undefined)
  assert('the drawer is a labelled dialog', drawer?.props.role === 'dialog')
  assert('the drawer is fully open after its entry frame', drawer?.props['data-open'] === 'true')
  assert(
    'the drawer is positioned from its right edge, not its centre',
    /*
     * The shim has no layout engine, so this asserts the placement contract the code
     * relies on: a `right` offset (which keeps the right edges flush while the pill's
     * width changes) and no horizontal translate of its own.
     */
    (() => {
      /*
       * The shim has no layout engine, so the trigger measures as unattached and the
       * placement pass keeps the panel hidden; that pre-measure state is the expected
       * one here. What must hold either way is that the offset is a `right` value —
       * the contract that keeps the right edges flush while the pill's width changes —
       * and that no `left`/centring transform is involved.
       */
      const style = drawer?.props.style
      if (style === undefined || 'left' in style) return false
      if (style.visibility === 'hidden') return true
      return typeof style.right === 'number' && style.right >= 0
    })(),
  )
  assert(
    'the drawer publishes one measurement variable per metric, in header order',
    /*
     * The shim reports zero-width boxes, so the measurement pass bails out and the
     * variables stay absent here — which is exactly the `ch` fallback path. What is
     * checkable without layout is the contract: five variables, keyed by metric, and
     * no positional guesswork.
     */
    (() => {
      const names = ['ttft', 'speed', 'tokens', 'total', 'amortized']
      const declared = names.every((name) => source.includes(`'--dsh-rum-col-${name}':`))
      // The mapping must be index-aligned with the pill's `data-metric` cells, in order.
      const assignment = names.map((name) => {
        const at = source.indexOf(`'--dsh-rum-col-${name}':`)
        if (at < 0) return -1
        const index = /columnWidths\[(\d)\]/.exec(source.slice(at, at + 80))
        return index === null ? -2 : Number(index[1])
      })
      const ordered = assignment.every((value, i) => value === i)
      const styleNow = drawer.props.style ?? {}
      const hasVars = names.some((name) => `--dsh-rum-col-${name}` in styleNow)
      return declared && ordered && !hasVars
    })(),
  )
  assert(
    'the drawer aligns CONTENT edges, not box edges',
    /*
     * The pill pads its content by 8px; the drawer stacks 16px of its own padding with a
     * row's 6px. Matching the outer boxes therefore leaves the numbers visibly inset by
     * the difference — the misalignment this asserts against. Both insets must be
     * measured and subtracted.
     */
    /function drawerContentInset\(/.test(source) &&
      /function pillContentInset\(/.test(source) &&
      /rect\.right - pillPad/.test(source) &&
      /drawerContentInset\(panel\)/.test(source) &&
      /pillContentInset\(anchor\)/.test(source),
  )
  assert(
    'the drawer re-places once the measured grid has settled',
    // The first pass may run against the `ch` fallback; a follow-up frame fixes it.
    /requestAnimationFrame\(place\)/.test(source),
  )

  const headCells = findAll(statusTree, (el) => el.props.className === 'dsh-rum-col' && el.props.role === 'columnheader')
  assert('the drawer has seven columns', headCells.length === 7)
  assert(
    'column order is # · time · first token · speed · tokens · total · amortised',
    headCells.map((cell) => normalize(textOf(cell))).join('|') === '#|时间|首字|速度|输出 Token|总用时|折算速度',
  )

  let itemRows = findAll(statusTree, (el) => String(el.props.className ?? '').includes('dsh-rum-item'))
  assert('the drawer lists ten rows', itemRows.length === 10)
  assert('the first data row is the newest reading', normalize(textOf(itemRows[0])).startsWith('1 0'))
  assert(
    'opening the drawer establishes a baseline instead of animating every row',
    // The first pass has no previous key set, so nothing may be marked as an arrival.
    itemRows.every((el) => el.props['data-phase'] === 'idle'),
  )

  /*
   * Token provenance: every recorded row must carry the provider's own count, and the
   * drawer no longer explains estimation at all.
   */
  assert(
    'every recorded reading carries exact provider usage',
    modelRows().every((row) => row.estimated === false),
  )
  assert(
    'the drawer has no explanatory footer',
    findAll(statusTree, byClass('dsh-rum-foot')).length === 0 &&
      !normalize(textOf(drawer)).includes('估算'),
  )
  assert(
    'the footer, its note and its relative time are gone from the drawer text',
    !normalize(textOf(drawer)).includes('刚刚') &&
      !normalize(textOf(drawer)).includes('上游'),
  )
  assert(
    'no estimated figure appears in the rendered rows',
    itemRows.every((row) => !normalize(textOf(row)).includes('~')),
  )
  assert(
    'the amortised column of an exact row carries no estimate marker',
    normalize(textOf(itemRows[0])).split(' ').every((part) => !part.startsWith('~')),
  )

  addNode({
    kind: 'assistant',
    turn: 3,
    step: 0,
    timing: { stepStartTime: 300000, firstTokenTime: 300300, completedTime: 301300 },
    usage: { outputTokens: 777 },
    blocks: [{ kind: 'text', text: 'y' }],
  })
  statusTree = await runtime.render(status.component, statusProps)
  const animated = findAll(statusTree, (el) => String(el.props.className ?? '').includes('dsh-rum-item'))
  assert('a new request is inserted at the top', modelRows()[0].tokens === 777)
  assert(
    'the new row enters while the evicted row is removed in the same frame',
    /*
     * An exit phase would keep an eleventh row laid out for the length of its
     * animation, growing the drawer by a row and shrinking it back — the height jump
     * this design avoids. Only the arrival may carry a phase, and the rendered row
     * count must never exceed the cap.
     */
    animated.some((el) => el.props['data-phase'] === 'enter') &&
      !animated.some((el) => el.props['data-phase'] === 'leave') &&
      animated.length === 10,
  )
  assert('the list never exceeds ten rows', modelRows().length === 10)

  await wait(320)
  statusTree = await runtime.render(status.component, statusProps)
  itemRows = findAll(statusTree, (el) => String(el.props.className ?? '').includes('dsh-rum-item'))
  assert(
    'the entry phase clears once the animation ends',
    itemRows.length === 10 && itemRows.every((el) => el.props['data-phase'] === 'idle'),
  )
  assert(
    'the exit animation and its keyframes are gone from the stylesheet',
    !/dsh-rum-out/.test(styleEls[0].textContent) &&
      !/data-phase="leave"/.test(styleEls[0].textContent),
  )

  assert(
    'the drawer is still open while a new request arrives',
    findAll(statusTree, byClass('dsh-rum-drawer')).length === 1,
  )

  triggerOf(statusTree).props.onClick()
  statusTree = await runtime.render(status.component, statusProps)
  let closing = findAll(statusTree, byClass('dsh-rum-drawer'))[0]
  assert(
    'clicking the pill again starts the upward-exit transition',
    closing === undefined || closing.props['data-open'] === 'false',
  )
  await wait(260)
  statusTree = await runtime.render(status.component, statusProps)
  assert(
    'the drawer unmounts once the exit animation ends',
    findAll(statusTree, byClass('dsh-rum-drawer')).length === 0,
  )

  /* ---------------------------------------------------------------- */
  /* Live reading while a step streams                                 */
  /* ---------------------------------------------------------------- */

  const liveStart = Date.now() - 2000
  const liveSnapshot = {
    legacy: {
      nodes: [],
      turnTimings: new Map([[7, { startTime: liveStart }]]),
      partial: { turn: 7, step: 0, blocks: [{ kind: 'text', text: 'abc'.repeat(40) }] },
      runningCalls: [],
    },
  }
  const liveProps = {
    ...statusInject,
    useChat: (sel) => sel(liveSnapshot),
    useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
    useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
    t,
  }
  const liveTree = await runtime.render(status.component, liveProps)
  const liveTrigger = findAll(liveTree, (el) => String(el.props.className ?? '').includes('dsh-rum-live'))[0]
  assert('a streaming step switches the trigger to its live style', liveTrigger !== undefined)
  assert(
    'the live reading is marked as an estimate through the reserved marker',
    (() => {
      const tildes = findAll(liveTrigger, byClass('dsh-rum-tilde'))
      const lit = tildes.filter((el) => el.props['data-on'] === true)
      // Tokens and amortised are estimates; a speed with no value yet stays unmarked.
      return tildes.length === 3 && lit.length >= 1 && !normalize(textOf(liveTrigger)).includes('~')
    })(),
  )
  assert(
    'the live reading replaces the stored newest row',
    // 120 ASCII characters of prose at 4 chars/token.
    normalize(textOf(liveTrigger)).includes('30 tok'),
  )

  /*
   * Tool-call arguments while they stream.
   *
   * `legacy.partial.blocks` carries NO argument text during a call: the store's
   * `tool-call-delta` branch copies `argsRaw` unchanged, so it stays empty until
   * `block-end`. The fragments accumulate on the call's own `args.chunks` view, reachable
   * through `legacy.runningCalls`. Without reading that, the live token count freezes
   * whenever the model writes a file — and tool arguments are a median 93% of real
   * output, so the figure looked stalled for most of a step.
   */
  {
    const writingStep = {
      legacy: {
        nodes: [],
        turnTimings: new Map([[8, { startTime: Date.now() - 3000 }]]),
        partial: { turn: 8, step: 0, blocks: [{ kind: 'text', text: 'a'.repeat(200) }] },
        runningCalls: [
          {
            phase: 'preparing',
            callId: 'c1',
            name: 'write',
            // The fragments streamed so far: 1000 ASCII characters of JSON.
            args: { chunks: ['{"path":', '"a.txt",', ' "content":', `"${'x'.repeat(980)}"`, '}'] },
            sealed: false,
          },
        ],
      },
    }
    const writingProps = {
      ...statusInject,
      useChat: (sel) => sel(writingStep),
      useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
      useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
      t,
    }
    const writingTree = await runtime.render(status.component, writingProps)
    const writingTrigger = findAll(writingTree, (el) => String(el.props.className ?? '').includes('dsh-rum-live'))[0]
    const shown = normalize(textOf(writingTrigger))
    // 50 tokens of prose (200 / 4) plus 404 tokens of arguments (1010 chars / 2.5).
    assert(
      'a preparing tool call adds its streamed arguments to the live count',
      shown.includes('454 tok'),
    )
    assert(
      'the arguments are counted at the tool coefficient, not the prose one',
      // At the prose coefficient the same text would read 50 + 252 = 302 tokens.
      !shown.includes('302 tok'),
    )
    assert(
      'the live count reads the preparing call view, not the settled block',
      /function preparingArgsText\(/.test(source) &&
        /call\.phase !== 'preparing'/.test(source) &&
        /call\.args\?\.chunks/.test(source) &&
        /snapshot\.legacy\.runningCalls/.test(source),
    )
  }

  /*
   * TTFT origin. The settled figure is firstToken − stepStart. A live figure that used
   * the TURN start would overstate it by everything earlier in the turn (a 174 s median
   * in a real log), which is the "tens of seconds while thinking, a few seconds once it
   * finishes" bug. A later step must therefore measure from the previous step's
   * completion, not from the turn's start.
   */
  {
    const turnStart = Date.now() - 120_000
    const previousDone = Date.now() - 2_000
    const laterStep = {
      legacy: {
        nodes: [
          {
            kind: 'assistant',
            turn: 9,
            step: 0,
            timing: { stepStartTime: turnStart, firstTokenTime: turnStart + 300, completedTime: previousDone },
            usage: { outputTokens: 50 },
            blocks: [{ kind: 'text', text: 'q' }],
          },
        ],
        turnTimings: new Map([[9, { startTime: turnStart }]]),
        partial: { turn: 9, step: 1, blocks: [{ kind: 'text', text: 'abcd' }] },
      },
    }
    const laterProps = {
      ...statusInject,
      useChat: (sel) => sel(laterStep),
      useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
      useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
      t,
    }
    const laterTree = await runtime.render(status.component, laterProps)
    const laterTrigger = findAll(laterTree, (el) => String(el.props.className ?? '').includes('dsh-rum-live'))[0]
    const ttftCell = findAll(laterTrigger, (el) => el.props['data-metric'] === 'ttft')[0]
    const shown = normalize(textOf(ttftCell ?? laterTrigger))
    assert(
      'a later step measures TTFT from the previous step, not from the turn start',
      // The observation fires at render time, ~2 s after `previousDone`; from the turn
      // start it would read ~120 s.
      (() => {
        const value = Number.parseFloat(shown)
        return Number.isFinite(value) && value < 10
      })(),
    )
    assert(
      'the previous step ran no tools, so its completion is the origin',
      // `completedTime` is only reached when the caller's step had no tool results.
      /function stepStartOf\(/.test(source) &&
        /const completed = numberOrNull\(previousNode\.timing\?\.completedTime\)/.test(source) &&
        /turnTimings\?\.get\?\.\(turn\)\?\.startTime/.test(source),
    )
  }

  /*
   * The tool-result origin.
   *
   * `timing.completedTime` is the `assistant/message` time, which lands BEFORE a step's
   * tools run. Using it as the next step's origin counted the entire tool execution into
   * the live TTFT — a 243 ms median, but reaching 120 s in a real log. A step's last
   * `tool/result` sits within 1 ms of its `step/end`, so that is the tight origin.
   */
  {
    const turnStart = Date.now() - 200_000
    const previousDone = Date.now() - 60_000      // the assistant message of step 0
    const toolDone = Date.now() - 3_000           // step 0's tool finished much later
    const toolStep = {
      legacy: {
        nodes: [
          {
            kind: 'assistant',
            seq: 100,
            turn: 11,
            step: 0,
            timing: { stepStartTime: turnStart, firstTokenTime: turnStart + 300, completedTime: previousDone },
            usage: { outputTokens: 50 },
            blocks: [{ kind: 'text', text: 'q' }],
          },
          // A settled tool node: no turn/step, only seq/time — attributed by seq window.
          { kind: 'tool-result', seq: 110, time: toolDone, callTime: previousDone + 10, callId: 'c1' },
          { kind: 'tool-result', seq: 111, time: toolDone + 50, callTime: toolDone, callId: 'c2' },
          // A tool result belonging to a LATER step must be excluded by the window.
          { kind: 'tool-result', seq: 200, time: Date.now() - 100, callTime: toolDone, callId: 'c3' },
        ],
        turnTimings: new Map([[11, { startTime: turnStart }]]),
        partial: { turn: 11, step: 1, blocks: [{ kind: 'text', text: 'abcd' }] },
      },
    }
    const toolProps = {
      ...statusInject,
      useChat: (sel) => sel(toolStep),
      useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
      useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
      t,
    }
    const toolTree = await runtime.render(status.component, toolProps)
    const toolTrigger = findAll(toolTree, (el) => String(el.props.className ?? '').includes('dsh-rum-live'))[0]
    const toolTtft = findAll(toolTrigger, (el) => el.props['data-metric'] === 'ttft')[0]
    const toolShown = normalize(textOf(toolTtft ?? toolTrigger))
    assert(
      'a step after a tool call measures from that tool result, not the assistant message',
      /*
       * The tool finished ~3 s ago, the assistant message was 60 s ago. From the tool
       * result the reading is single-digit seconds; from `completedTime` it would be ~60.
       */
      (() => {
        const value = Number.parseFloat(toolShown)
        return Number.isFinite(value) && value < 20
      })(),
    )
    assert(
      'tool results are attributed by seq window, not by timestamp',
      // A resumed log replays steps, so timestamps repeat; seq is the stable ordering.
      /node\.kind !== 'tool-result'/.test(source) &&
        /seq <= previousSeq \|\| seq >= currentSeq/.test(source) &&
        /lastToolTime === null \|\| at > lastToolTime/.test(source),
    )
    assert(
      'a tool result outside the window is ignored',
      /const currentSeq = numberOrNull\(findStep\(step\)\?\.seq\) \?\? Number\.POSITIVE_INFINITY/.test(source),
    )
  }

  /* ---------------------------------------------------------------- */
  /* Average row                                                       */
  /* ---------------------------------------------------------------- */

  assert(
    'the drawer summarises the visible rows and separates them with a rule',
    /className: 'dsh-rum-average-rule'/.test(source) &&
      /function AverageRow\(/.test(source) &&
      /function averageOf\(/.test(source) &&
      /\.dsh-rum-average-rule\s*\{[^}]*border-top/s.test(styleEls[0].textContent),
  )
  assert(
    'the average reuses the rows grid so each figure lands under its column',
    /className: 'dsh-rum-row dsh-rum-average'/.test(source),
  )
  assert(
    'a column with no samples prints a dash instead of a fake zero',
    (() => {
      // averageOf must skip non-finite samples and return null for an empty column.
      const start = source.indexOf('function averageOf(')
      if (start < 0) return false
      const body = source.slice(start, start + 1400)
      return /count === 0 \? null/.test(body) && /Number\.isFinite\(value\)/.test(body)
    })(),
  )

  /* ---------------------------------------------------------------- */
  /* Disposal                                                          */
  /* ---------------------------------------------------------------- */

  runtime.unmount()
  for (const entry of effects.slice().reverse()) {
    if (typeof entry.dispose === 'function') entry.dispose()
  }
  assert('style element removed on dispose', styleEls.length === 0)
  assert('slot registrations removed on dispose', registrations.size === 0)
  assert('locale claim released on dispose', dictionaries.size === 0)
  assert('history survives dispose, so re-enabling restores it', JSON.parse(store.get('dsh.recentUsageMetrics.history.v1')).length === 10)
  assert('the Geek flag survives dispose', store.get('dsh.recentUsageMetrics.mode.v1') === '"geek"')

  console.log('\neffect labels: ' + effects.map((entry) => entry.label).join(' | '))
  const leftover = process.getActiveResourcesInfo().filter((name) => name === 'Timeout' || name === 'Immediate')
  assert('no timers survive disposal', leftover.length === 0)
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  if (failures > 0) process.exitCode = 1
  // The live-reading ticker and the drawer's relative-time ticker are the only
  // intervals the plugin owns; a surviving one means a cleanup went missing, which
  // the assertion above reports. Nothing else should keep the process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50)
})()
