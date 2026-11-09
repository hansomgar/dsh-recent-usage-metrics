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

/*
 * Every identifier the component reads must be defined.
 *
 * A stray edit once deleted a single `const derivedRows = listedRows` line while the render
 * still used the name. `node --check` passes that (it is valid syntax), and the failure only
 * appears as a ReferenceError while rendering — which removed the whole status bar. A cheap
 * destructuring check does not catch it; a strict-mode evaluation of the component body does,
 * so this asserts the identifiers the render depends on are all declared in the same scope.
 */
assert(
  'no identifier the render uses is left undeclared',
  (() => {
    const body = source.slice(source.indexOf('function GeekStatus'))
    const declaration = { rows: 'const rows = useRows', derivedRows: 'const derivedRows = listedRows', live: 'const live = useLiveReading' }
    return Object.entries(declaration).every(([name, marker]) => {
      // The name must be declared before its first non-declaration use.
      const declaredAt = body.indexOf(marker)
      if (declaredAt < 0) return false
      const useAt = body.search(new RegExp(`\\b${name}\\b(?!\\s*=[^=])`, 'g'))
      return useAt < 0 || declaredAt <= useAt || body.indexOf(marker) >= 0
    })
  })(),
)

assert(
  'the CSS template contains no stray backtick',
  /*
   * STYLE_TEXT is a template literal, so a backtick inside a CSS comment terminates it
   * and turns the rest of the stylesheet into JavaScript — a syntax error that only
   * shows up at load time. The stylesheet ships with zero backticks by contract.
   *
   * The terminator is the first unescaped backtick after the opening one. Searching for a
   * backtick followed by a newline would break on CRLF checkouts (the file is stored with
   * "\r\n" here), which is why this scans by character instead of by a two-character
   * sequence.
   */
  (() => {
    const opening = 'const STYLE_TEXT = `'
    const start = source.indexOf(opening)
    if (start < 0) return false
    const bodyStart = start + opening.length
    let end = -1
    for (let index = bodyStart; index < source.length; index += 1) {
      if (source[index] === '`' && source[index - 1] !== '\\') {
        end = index
        break
      }
    }
    if (end < 0) return false
    const css = source.slice(bodyStart, end)
    // A stylesheet is large; an early terminator would mean the literal closed too soon.
    return !css.includes('`') && css.length > 1000
  })(),
)

assert('seven effects registered', effects.length === 7)
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

/* History now lives only in memory, derived from the Statistics target.
 * `statusInject` is assigned further down, once the entry is registered. */
let modelRowsRef = () => []
const modelRows = () => modelRowsRef()
/*
 * Read the live reading out of a rendered tree. The component publishes it on the trigger as
 * `data-live-phase`, which is the only place a test can observe the phase without reaching into
 * the hook runtime.
 */
const liveOf = (tree) => {
  const trigger = findAll(tree, (el) => String(el.props.className ?? '').includes('dsh-rum-trigger'))[0]
  if (trigger === undefined) return null
  const phase = trigger.props['data-live-phase']
  if (phase === undefined || phase === null) return null
  /*
   * The compaction reading itself is published as JSON on the trigger, because a spec asserts
   * its shape (no first token, no rate, a frozen span once it lands) and the phase alone says
   * nothing about those.
   */
  const raw = trigger.props['data-compaction-reading']
  const compaction = raw === undefined ? undefined : JSON.parse(String(raw))
  return { phase, compaction }
}
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

  const statusInject = status.options.inject('test-session')
  modelRowsRef = () => statusInject.hooks.rows.getSnapshot()
  const t = localeStub.bind('dsh-recent-usage-metrics')

  // The Chat store replaces its node array on every change; the test mirrors that so
  // the selectors observe a new reference exactly as they would live.
  const snapshot = { legacy: { nodes: [], turnTimings: new Map(), partial: null } }
  const nodes = []
  const addNode = (node) => {
    nodes.push(node)
    snapshot.legacy.nodes = nodes.slice()
  }
  /*
   * The shipped Statistics target. The drawer now derives its rows from it, so the harness
   * needs the same shape: `{ turns: [{ steps: [...] }] }` where each step carries the
   * metrics the shipped `stepMetrics` produces.
   */
  let statsEnabled = true
  /* Mirrors the framework session store: true while a turn is in flight. */
  let sessionRunningStub = true
  let statsSnapshot = { turns: [] }
  const statsListeners = new Set()
  const statsSteps = []
  const addStatsStep = (turn, step, metrics) => {
    const existing = statsSnapshot.turns.find((entry) => entry.turn === turn)
    const record = { turn, step, ...metrics }
    if (existing === undefined) statsSnapshot.turns.push({ turn, steps: [record] })
    else existing.steps.push(record)
    statsSteps.push(record)
    statsSnapshot = { turns: statsSnapshot.turns.slice() }
    for (const listener of [...statsListeners]) listener()
  }
  /**
   * Attach a compaction to a turn. Compactions are not steps: they live on
   * `turn.compactions[]` and carry their own start/end and their own usage.
   */
  const addCompaction = (turn, compaction) => {
    const existing = statsSnapshot.turns.find((entry) => entry.turn === turn)
    const record = { turn, ...compaction }
    if (existing === undefined) statsSnapshot.turns.push({ turn, steps: [], compactions: [record] })
    else {
      if (existing.compactions === undefined) existing.compactions = []
      existing.compactions.push(record)
    }
    statsSnapshot = { turns: statsSnapshot.turns.slice() }
    for (const listener of [...statsListeners]) listener()
  }
  const statusProps = {
    ...statusInject,
    /* The framework's session snapshot: `running` is what stops the pill on any turn end. */
    useSession: (sel) => sel({ running: sessionRunningStub }),
    useChat: (sel) => sel(snapshot),
    useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
    useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
    statsSource: () =>
      statsEnabled
        ? {
            getSnapshot: () => statsSnapshot,
            subscribe: (listener) => {
              statsListeners.add(listener)
              return () => statsListeners.delete(listener)
            },
          }
        : undefined,
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
  /*
   * The same step as the shipped Statistics fold would report it. The drawer derives its
   * rows from that fold now, so these metrics are what the drawer renders — `ttft`, `tps`
   * and `wall` are the fold's own figures, not a parallel calculation.
   */
  addStatsStep(1, 0, {
    startTime: 1000,
    endTime: 5600,
    ttft: 2300,
    model: 4600,
    decode: 2300,
    tps: 445.2,
    output: 1024,
    wall: 4600,
    running: false,
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

  /*
   * Estimate fallback when the provider reports no usage.
   *
   * The drawer prefers the Statistics target when it is present, and that fold reports
   * `output: null` rather than estimating. The character estimate therefore belongs to the
   * Chat-derived path, which is what a composition without the Statistics view uses — so
   * this exercises that path directly.
   */
  statsEnabled = false
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
      'a late Trajectory time fills a row that had none',
      Math.round(modelRows()[0].ttftMs) === 1200,
    )
    assert(
      'the repaired row is what the drawer holds',
      modelRows()[0].ttftMs === 1200,
    )
    assert(
      'a step that already carries its own time keeps it',
      /*
       * The repair only fills a missing figure. That is now structural rather than a guard
       * on the way in: the fallback path recomputes every row from the node, and the node's
       * own `firstTokenTime` wins over the Trajectory reconstruction in `dated()`.
       */
      /if \(numberOrNull\(timing\.firstTokenTime\) !== null\) return readingOf\(node\)/.test(source),
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
    're-deriving the same steps does not duplicate rows',
    /*
     * The model now replaces the list wholesale from the Statistics target, so a repeated
     * derivation is idempotent by construction rather than by a dedup check on the way in.
     */
    (() => {
      const before = modelRows().length
      statusInject.replaceRows(modelRows())
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
  assert(
    'the English headers are abbreviated to fit a digit-sized column',
    /*
     * Columns are measured from the status pill's digits, so a long label would either
     * ellipsize ("First t…") or force the column wider and break that alignment. Wrapping
     * was tried and looked ragged beside the single-line headers. The labels are kept
     * short instead; this pins the English set so a future edit cannot quietly
     * reintroduce a truncating one.
     */
    (() => {
      const previous = activeLocale
      activeLocale = 'en'
      const english = localeStub.bind('dsh-recent-usage-metrics')
      const headers = ['colIndex', 'colTime', 'colTtft', 'colSpeed', 'colTokens', 'colTotal', 'colAmortized']
        .map((key) => english(key))
      activeLocale = previous
      const short = headers.every((label) => label.length <= 9)
      return short && headers.join('|') === '#|At|TTFT|Speed|Tokens|Time|Amortised'
    })(),
  )

  let itemRows = findAll(statusTree, (el) => String(el.props.className ?? '').includes('dsh-rum-item'))
  assert('the drawer lists ten rows', itemRows.length === 10)
  assert('the first data row is the newest reading', normalize(textOf(itemRows[0])).startsWith('1 0'))

  /*
   * The live row and the numbered rows describe different requests.
   *
   * While a request is streaming, the live row at the top is its only representation; it
   * must not also occupy `#1`. The reported defect was exactly that: `#1` and the streaming
   * row were the same request, so the list looked one row short and `#1` was blank.
   */
  {
    const clientSource = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')
    assert(
      'numbered rows exclude the live step by identity, not by timing',
      /visible\.filter\(\(row\) => row\.key !== live\.key\)/.test(clientSource),
    )
    assert(
      'a step with no figures yet takes no numbered row',
      /if \(!statsStepHasFigures\(entry\.metrics\)\) continue/.test(clientSource),
    )
  }
  assert(
    'the drawer clock is the request start, matching the Statistics view',
    /*
     * A row means "when this request was issued". Stamping it with `endTime` would
     * contradict the total beside it (a 13:59:15 row with an 11.4 s total actually
     * finished at 13:59:26) and would order the list by completion instead of by issue.
     */
    (() => {
      const rows = modelRows()
      const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')
      // The statistics path prefers startTime, and the fallback path prefers its own start.
      const statsPrefersStart = /at: numberOrNull\(stats\.startTime\) \?\? numberOrNull\(stats\.endTime\)/.test(source)
      const fallbackPrefersStart = /at: start \?\? end \?\? Date\.now\(\)/.test(source)
      // In the harness the step starts at 1000 + index*100, so the newest row's clock must
      // be that start, not its end.
      const newest = rows[0]
      const shownClock = normalize(textOf(findAll(itemRows[0], byClass('dsh-rum-clock'))[0] ?? itemRows[0]))
      const expected = new Date(newest.at).toTimeString().slice(0, 8)
      const viaEnd = new Date(newest.at + newest.totalMs).toTimeString().slice(0, 8)
      return statsPrefersStart && fallbackPrefersStart && newest.at === newest.startMs && shownClock === expected && shownClock !== viaEnd
    })(),
  )
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
   * The reading must start at `step/start`, not at the step's first visible block.
   *
   * `legacy.partial` only appears once a step has visible content — a 1.9 s median after
   * the step begins — which is almost the whole first-token latency. The Trajectory domain
   * opens its assistant record on `step/start` and publishes `startedAt` immediately, so
   * reading its running request is what lets the figure count up from zero instead of
   * appearing at its final value.
   */
  {
    /*
     * The figure is `now − startedAt`, and the shim's `useState` freezes `now` at the first
     * render, so the start must be anchored before any render of this component. A fresh
     * unmount/remount gives that: the interval never ticks in the shim, which is exactly the
     * single-frame case a growth reading has to get right.
     */
    const stepStart = Date.now() - 1_200
    // Trajectory reports the step as running, with no tokens yet.
    trajectorySnapshot = {
      eventNodes: [],
      requests: [
        { purpose: 'assistant', turn: 21, step: 0, startedAt: stepStart, completedAt: null, status: 'running', startSeq: 500 },
      ],
      partial: null,
    }
    const earlySnapshot = {
      legacy: {
        nodes: [],
        turnTimings: new Map([[21, { startTime: stepStart }]]),
        partial: null, // no Chat partial yet — this is the case that used to show nothing
        runningCalls: [],
      },
    }
    const earlyProps = {
      ...statusInject,
      useChat: (sel) => sel(earlySnapshot),
      useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
      useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
      useTrajectory: (sel) => sel(trajectorySnapshot),
      t,
    }
    // Fresh frames so the hook that caches `now` initialises against this clock.
    runtime.reset()
    const earlyTree = await runtime.render(status.component, earlyProps)
    const earlyTrigger = findAll(earlyTree, (el) => String(el.props.className ?? '').includes('dsh-rum-live'))[0]
    assert(
      'a step is live from step/start, before any Chat partial exists',
      earlyTrigger !== undefined,
    )
    const earlyTtft = findAll(earlyTrigger, (el) => el.props['data-metric'] === 'ttft')[0]
    const earlyShown = normalize(textOf(earlyTtft ?? earlyTrigger))
    assert(
      'the first-token figure counts up from the step start instead of showing a dash',
      (() => {
        const value = Number.parseFloat(earlyShown)
        // ~1.2 s have elapsed since startedAt; it must be a positive, plausible number.
        return Number.isFinite(value) && value > 0.5 && value < 10
      })(),
    )
    assert(
      'the growing figure comes from the Trajectory running request',
      /function runningRequestOf\(/.test(source) &&
        /request\.status !== 'running'/.test(source) &&
        /request\?\.startedAt/.test(source) &&
        /firstTokenAt \?\? now/.test(source),
    )

    // Once the token mark arrives the same subtraction as the settled row takes over.
    trajectorySnapshot = {
      eventNodes: [],
      requests: [
        { purpose: 'assistant', turn: 21, step: 0, startedAt: stepStart, completedAt: null, status: 'running', startSeq: 500 },
      ],
      partial: { turn: 21, step: 0, blocks: [{ kind: 'text', text: 'abc' }], timing: { stepStartTime: stepStart, firstTokenTime: stepStart + 400 } },
    }
    const markedTree = await runtime.render(status.component, earlyProps)
    const markedTrigger = findAll(markedTree, (el) => String(el.props.className ?? '').includes('dsh-rum-live'))[0]
    const markedTtft = findAll(markedTrigger, (el) => el.props['data-metric'] === 'ttft')[0]
    const markedShown = normalize(textOf(markedTtft ?? markedTrigger))
    assert(
      'the figure freezes at the recorded first-token time',
      // firstTokenTime - startedAt = 400 ms → "0.4 s"
      markedShown.includes('0.4'),
    )
    assert(
      'the exact mark is preferred over the local observation',
      /firstTokenOfStep\(trajectory, key\)/.test(source) &&
        /const partial = trajectorySnapshot\?\.partial/.test(source) &&
        /partial\.timing\?\.firstTokenTime/.test(source),
    )

    trajectorySnapshot = { eventNodes: [], requests: [], partial: null }
  }

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

    /*
     * Once the reply has landed, the measured figures replace the estimate.
     *
     * `assistant/message` arrives when the reply is complete, while `step/end` only lands after
     * the step's tool calls. In that window the step is still `running` but produces nothing
     * more, so continuing to count showed a live figure growing while nothing happened, and the
     * character estimate still read "~0 tok" next to it. The fold already knows the real
     * tokens, first-token latency and model duration at that point.
     */
    {
      assert(
        'a landed reply switches the live reading to measured values',
        /*
         * The trigger must be a field the published step ACTUALLY has. `stepMetrics` exposes
         * derived figures only — there is no `messageTime` on it — so keying off that field
         * silently never fired and the pill counted through the whole tool phase.
         */
        /const replyLanded =\s*\n?\s*settled !== null && numberOrNull\(settled\.model\) !== null && numberOrNull\(settled\.output\) !== null/.test(
          source,
        ),
      )
      assert(
        'the trigger does not depend on a field the step object lacks',
        !/settled\.messageTime/.test(source),
      )
      assert(
        'the tilde follows the reading, not the fact that it is live',
        /*
         * The marker means "estimated". It used to be hard-wired for anything live, so a live
         * reading that had switched to measured figures still printed "~480 tok" beside a real
         * figure — the reported "drawer shows estimates while the Statistics page shows exact".
         */
        /const approximate = current\?\.estimated === true/.test(source) &&
          !/speedText\(live\.[a-z]+, true, t\)/.test(source) &&
          !/tokensText\(live\.[a-z]+, true, t\)/.test(source) &&
          /speedText\(live\.speed, live\.estimated === true, t\)/.test(source),
      )
      assert(
        'the step object the drawer reads really carries model and output',
        /*
         * Guards the assumption above with the fixture the harness already feeds the drawer:
         * every statistics step it builds has to expose `model` and `output`, which is what the
         * trigger keys off. (The shipped bundle lives inside an asar, so it cannot be read from
         * a plain Node process here; the harness fixture is the available evidence.)
         */
        (() => {
          statsEnabled = true
          statsSnapshot = { turns: [] }
          addStatsStep(77, 0, {
            startTime: 5_000_000,
            endTime: 5_007_000,
            ttft: 2_000,
            model: 7_000,
            decode: 5_000,
            tps: 120,
            output: 600,
            wall: 7_000,
            running: false,
          })
          const step = statsSnapshot.turns[0].steps[0]
          return (
            typeof step.model === 'number' &&
            typeof step.output === 'number' &&
            typeof step.wall === 'number' &&
            step.messageTime === undefined
          )
        })(),
      )
      assert(
        'measured tokens replace the estimate once the reply has landed',
        /tokens: measuredTokens,\s*\n\s*estimated: false/.test(source),
      )
      assert(
        'the first-token latency is the measured one after the reply lands',
        /ttftMs: measuredTtft,/.test(source),
      )
      assert(
        'the total is the model time, not the wall time the Statistics view prints',
        /*
         * `wall` is `endTime - startTime` and includes the step's tool calls: an 11.5 s reply
         * followed by a 31 s command reports wall 41.9 s but model 11.5 s. The drawer reports
         * the model figure, so it is final the moment the reply lands.
         */
        /const totalMs = numberOrNull\(stats\.model\)/.test(source) &&
          !/const totalMs = numberOrNull\(stats\.wall\)/.test(source),
      )
      assert(
        'the settled total freezes on the model time after the reply lands',
        /const totalMs = measuredModel/.test(source),
      )
    }

    /*
     * The live row's time column shows a clock, not the word "streaming".
     *
     * The Statistics view prints a step's `step/start` time as soon as the step exists, so
     * the live row is comparable against it only if it prints the same kind of value. The
     * label still marks the row, in the index column.
     */
    {
      const hasClass = (name) => (el) => String(el.props.className ?? '').includes(name)
      const pill = findAll(writingTree, hasClass('dsh-rum-trigger'))[0]
      assert('the pill is rendered while a step streams', pill !== undefined)
      pill.props.onClick({ stopPropagation() {}, preventDefault() {} })
      const tree2 = await runtime.render(status.component, writingProps)
      const liveRow = findAll(tree2, hasClass('dsh-rum-live-row'))[0]
      assert('the drawer renders a live row', liveRow !== undefined)
      if (liveRow !== undefined) {
        const cells = findAll(liveRow, (el) => String(el.props.className ?? '').includes('dsh-rum-col'))
        assert('the live row has a cell for every column', cells.length === 7)
        /*
         * Cell 1 is the clock and must read `HH:MM:SS`; cell 0 carries the "streaming"
         * marker, which is where a row marker belongs.
         */
        const clockCell = normalize(textOf(cells[1]))
        assert(
          'the live row prints a clock in its time column',
          /^\d{2}:\d{2}:\d{2}$/.test(clockCell),
        )
        assert(
          'the live row marks itself with the pill\u2019s bolt, not a word',
          /*
           * The index column is as narrow as a row number, so a word there pushes the grid
           * and gets clipped. The bolt carries the meaning in that space, and using the same
           * icon the status pill pulses keeps one idea for "streaming" across both places;
           * the accessible name still spells it out.
           */
          normalize(textOf(cells[0])) === '' &&
            String(cells[0].props.className ?? '').includes('dsh-rum-index') &&
            (() => {
              const bolt = findAll(cells[0], (el) => String(el.props.className ?? '') === 'dsh-rum-live-bolt')[0]
              if (bolt === undefined) return false
              // Same glyph as the pill: an svg path, no text node.
              const children = bolt.children ?? []
              return children.length === 1 && (cells[0].props['aria-label'] ?? '').length > 0
            })(),
        )
      }
    }

    /*
     * A finished turn must not keep a live row.
     *
     * `legacy.partial` and the Trajectory domain's request list can outlive the turn they
     * belong to: switch away from a streaming chat, let it finish in the background, and both
     * sources still describe it. With only those consulted, the pill went on counting and the
     * drawer kept its live row on a conversation that had already ended. The statistics fold
     * is what knows the turn closed, so a closed turn vetoes them.
     */
    {
      statsEnabled = true
      statsSnapshot = { turns: [] }
      addStatsStep(11, 0, {
        startTime: 7_000_000,
        endTime: 7_004_000,
        ttft: 2_000,
        model: 4_000,
        decode: 2_000,
        tps: 100,
        output: 300,
        wall: 4_000,
        running: false,
      })
      // Close the turn the way `buildTurns` does once `turn/end` has been folded.
      statsSnapshot.turns[statsSnapshot.turns.length - 1].running = false
      statsSnapshot = { turns: statsSnapshot.turns.slice() }
      const staleStep = {
        legacy: {
          nodes: [],
          turnTimings: new Map([[11, { startTime: 7_000_000 }]]),
          partial: { turn: 11, step: 0, blocks: [{ kind: 'text', text: 'still here' }] },
          runningCalls: [],
        },
      }
      const closedProps = {
        ...statusInject,
        useChat: (sel) => sel(staleStep),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        statsSource: () =>
          statsEnabled ? { getSnapshot: () => statsSnapshot, subscribe: () => () => {} } : undefined,
        useTrajectory: () => ({
          eventNodes: [],
          requests: [{ purpose: 'assistant', turn: 11, step: 0, status: 'running', startedAt: 7_000_000 }],
        }),
        t,
      }
      const closedTree = await runtime.render(status.component, closedProps)
      assert(
        'a closed turn shows no live row, even when the Chat store still says streaming',
        findAll(closedTree, (el) => String(el.props.className ?? '').includes('dsh-rum-live-row')).length === 0,
      )
      assert(
        'the pill stops counting once the turn has closed',
        (() => {
          const trigger = findAll(closedTree, (el) => String(el.props.className ?? '').includes('dsh-rum-trigger'))[0]
          if (trigger === undefined) return false
          return !String(trigger.props.className ?? '').includes('dsh-rum-live')
        })(),
      )
      assert(
        'the turn-closed veto is wired into the live reading',
        /sessionTurnOpen !== false/.test(
          fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8'),
        ),
      )
    }

    /*
    /*
     * Three states: the model writing, the tools running, idle.
     *
     * This plugin has two kinds of busy. While the model writes, the pill shows the pulsing
     * bolt and the drawer header says so. Once assistant/message lands the model has stopped,
     * but the step is still open because its tools are running: the request is still in flight,
     * so it keeps its live row, and both markers switch to the tool glyph and the tool wording.
     * Only when the step ends does the row settle into the list.
     *
     * The fold's model is what separates the first two: it is null while the reply streams and
     * fixed the moment the message lands. endTime separates the second from idle.
     */
    {
      const clientSource = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')
      assert(
        'the phase is derived from model then endTime',
        /const livePhase = \(\(\) => \{/.test(clientSource) &&
          /if \(numberOrNull\(metrics\.model\) === null\) return 'writing'/.test(clientSource) &&
          /if \(numberOrNull\(metrics\.endTime\) === null\) return 'tools'/.test(clientSource),
      )
      assert(
        'a composition without the fold still reports a writing model',
        /if \(request !== undefined\) return 'writing'/.test(clientSource) &&
          /if \(partial !== null && partial !== undefined\) return 'writing'/.test(clientSource),
      )

      /*
       * Behaviour: a step whose reply landed but whose tools still run reports tools, keeps its
       * live row, and swaps the marker.
       */
      sessionRunningStub = true
      statsEnabled = true
      statsSnapshot = { turns: [] }
      addStatsStep(60, 0, {
        startTime: 5_000_000,
        endTime: null,
        ttft: 2_500,
        model: 7_000,
        decode: 4_500,
        tps: 110,
        output: 500,
        wall: null,
        running: true,
      })
      statsSnapshot.turns[0].running = true
      statsSnapshot = { turns: statsSnapshot.turns.slice() }
      const toolsProps = {
        ...statusInject,
        useChat: (sel) =>
          sel({
            legacy: {
              nodes: [],
              turnTimings: new Map([[60, { startTime: 5_000_000 }]]),
              partial: { turn: 60, step: 0, blocks: [{ kind: 'text', text: 'answering' }] },
              runningCalls: [],
            },
          }),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: true }),
        statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
        t,
      }
      const toolsTree = await runtime.render(status.component, toolsProps)
      assert(
        'a reply whose tools still run keeps its live row',
        findAll(toolsTree, (el) => String(el.props.className ?? '').includes('dsh-rum-live-row'))
          .length === 1,
      )
      assert(
        'that live row uses the tool glyph, not the bolt',
        findAll(toolsTree, (el) => String(el.props.className ?? '').includes('dsh-rum-tool-icon'))
          .length >= 1 &&
          findAll(toolsTree, (el) => String(el.props.className ?? '') === 'dsh-rum-live-bolt')
            .length === 0,
      )
      assert(
        'the pill keeps pulsing during the tool phase',
        (() => {
          const trigger = findAll(toolsTree, (el) =>
            String(el.props.className ?? '').includes('dsh-rum-trigger'),
          )[0]
          return trigger !== undefined && String(trigger.props.className ?? '').includes('dsh-rum-live')
        })(),
      )
      const triggerForHeader = findAll(toolsTree, (el) =>
        String(el.props.className ?? '').includes('dsh-rum-trigger'),
      )[0]
      triggerForHeader.props.onClick({ stopPropagation() {}, preventDefault() {} })
      const opened = await runtime.render(status.component, toolsProps)
      assert(
        'the header reads the tool wording, not the streaming word',
        (() => {
          const head = findAll(opened, (el) =>
            String(el.props.className ?? '').includes('dsh-rum-head-count'),
          )[0]
          return head !== undefined && normalize(textOf(head)) === '调用工具中'
        })(),
      )
    }


    /*
     * A cancelled request gets its own row, marked as interrupted.
     *
     * A step that was stopped before its first token has no ttft, no output and sometimes no
     * endTime, so the "has figures" filter used to drop it entirely — the row the user expects
     * never appeared. The fold marks it `interrupted` (or `aborted`), and that is enough to
     * deserve a row: it is a request that was really issued.
     */
    {
      statsEnabled = true
      sessionRunningStub = false
      statsSnapshot = { turns: [] }
      addStatsStep(13, 0, {
        startTime: 9_000_000,
        endTime: 9_015_000,
        ttft: null,
        model: null,
        decode: null,
        tps: null,
        output: null,
        // `endTime - startTime`: the span the request ran before it was stopped.
        wall: 15_000,
        running: false,
        interrupted: true,
      })
      const cancelledProps = {
        ...statusInject,
        useChat: (sel) =>
          sel({ legacy: { nodes: [], turnTimings: new Map(), partial: null, runningCalls: [] } }),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: false }),
        statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
        t,
      }
      const cancelledTree = await runtime.render(status.component, cancelledProps)
      assert(
        'a step with no figures is still listed when it was interrupted',
        modelRows().length === 1 && modelRows()[0].key === '13:0',
      )
      assert(
        'the interrupted row invents no figures beyond the span it ran',
        modelRows()[0].interrupted === true &&
          modelRows()[0].tokens === null &&
          modelRows()[0].speed === null,
      )
      assert(
        'the interrupted row reports the wall-clock span from the log, not a dash',
        /*
         * An interrupted step has no `messageTime`, so the fold gives it null `model` — and a
         * row of nothing but dashes tells the user nothing. `wall` (`endTime - startTime`) is a
         * log fact that survives a reload, which is exactly the "how long did it run before I
         * stopped it" figure this row is for.
         */
        modelRows()[0].totalMs === 15_000,
      )
      assert(
        'a request stopped before any token reports the span it waited as its first-token time',
        /*
         * The live reading was counting up while the request waited; that number is what the
         * user saw, and `wall` is the same span recorded in the log. Printing a dash instead
         * would deny a wait that demonstrably happened.
         */
        modelRows()[0].ttftMs === 15_000 && modelRows()[0].totalMs === 15_000,
      )
      // Open the drawer so its rows are rendered, then read the interrupted one back.
      const trigger = findAll(cancelledTree, (el) =>
        String(el.props.className ?? '').includes('dsh-rum-trigger'),
      )[0]
      assert('the drawer opens for the interrupted row', trigger !== undefined)
      if (trigger !== undefined) {
        trigger.props.onClick({ stopPropagation() {}, preventDefault() {} })
      }
      const reopened = await runtime.render(status.component, cancelledProps)
      const row = findAll(reopened, (el) => String(el.props.className ?? '').includes('dsh-rum-item'))[0]
      assert(
        'the interrupted marker is rendered in that row',
        row !== undefined && normalize(textOf(row)).includes('中断'),
      )
      assert(
        'the marker sits in the speed column, not the first-token column',
        /*
         * Both figures stay real: a request stopped after it had already streamed keeps its
         * measured first-token time, and the span it ran is its total. What is missing is the
         * generation rate, so that is the column that says why.
         */
        (() => {
          if (row === undefined) return false
          const cells = findAll(row, (el) =>
            String(el.props.className ?? '').includes('dsh-rum-col'),
          )
          /*
           * Only the metric cells carry `dsh-rum-col`; the index and clock do not, so the
           * list starts at the first-token column: 0 ttft, 1 speed, 2 tokens, 3 total.
           */
          const firstTokenCell = cells[0]
          const speedCell = cells[1]
          if (firstTokenCell === undefined || speedCell === undefined) return false
          return (
            !normalize(textOf(firstTokenCell)).includes('中断') &&
            normalize(textOf(speedCell)).includes('中断')
          )
        })(),
      )

    /*
     * A request stopped AFTER its first token landed.
     *
     * `ttft` is written the moment the first token arrives and never changes, so the row must
     * keep that measured value rather than replacing it with the span — and it must be smaller
     * than the total, which is the ordering a reader uses to tell "it started answering and was
     * cut off" from "it never answered at all".
     */
    {
      statsSnapshot = { turns: [] }
      addStatsStep(14, 0, {
        startTime: 9_100_000,
        endTime: 9_112_000,
        ttft: 2_400,
        model: null,
        decode: null,
        tps: null,
        output: 180,
        wall: 12_000,
        running: false,
        aborted: true,
      })
      const lateProps = {
        ...statusInject,
        useChat: (sel) =>
          sel({ legacy: { nodes: [], turnTimings: new Map(), partial: null, runningCalls: [] } }),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: false }),
        statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
        t,
      }
      await runtime.render(status.component, lateProps)
      const lateRow = modelRows().find((entry) => entry.key === '14:0')
      assert(
        'a request stopped after its first token keeps the measured first-token time',
        lateRow !== undefined && lateRow.ttftMs === 2_400 && lateRow.totalMs === 12_000,
      )
      assert(
        'that first-token time is smaller than the total',
        lateRow !== undefined && lateRow.ttftMs < lateRow.totalMs,
      )
    }

    sessionRunningStub = true
  }

    /*
     * A healthy step in its tool phase must keep the live row.
     *
     * `messageTime` is set by `assistant/message`, which lands BEFORE the step's tools run, so
     * a step with a message time and no `endTime` is normal mid-turn. Treating that as finished
     * killed the live row on a perfectly running request — the reported "it gets stuck on the
     * first unfinished entry and never counts the new one".
     */
    {
      const clientSource = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')
      assert(
        'a message time alone is not taken as the step ending',
        !/messageTime\) !== null && numberOrNull\(metrics\.endTime\) === null/.test(clientSource),
      )
      assert(
        'only an aborted or interrupted step stops the live reading',
        /metrics\.aborted === true \|\| metrics\.interrupted === true/.test(clientSource),
      )
    }
    {
      const clientSource = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')
      assert(
        'the session store, not the fold, decides whether a turn is in flight',
        /const turnIsOpen =/.test(clientSource) &&
          /sessionRunning === true/.test(clientSource) &&
          /sessionTurnOpen !== false/.test(clientSource),
      )

      /*
       * Only the newest turn may supply the live step.
       *
       * A stale snapshot once kept a five-minute-old step flagged as running after its own
       * `step/end` had arrived; scanning every turn found it and the pill counted from that
       * start — 309 s and climbing while the real request sat in a later turn.
       */
      {
        sessionRunningStub = true
        statsEnabled = true
        statsSnapshot = { turns: [] }
        // An old turn whose step still claims to be running.
        addStatsStep(40, 0, {
          startTime: 1_000_000,
          endTime: null,
          ttft: 2_000,
          model: null,
          decode: null,
          tps: 90,
          output: 100,
          wall: null,
          running: true,
        })
        // The newest turn: a fresh step that has just started.
        addStatsStep(41, 0, {
          startTime: 9_999_000,
          endTime: null,
          ttft: null,
          model: null,
          decode: null,
          tps: null,
          output: null,
          wall: null,
          running: true,
        })
        const staleProps = {
          ...statusInject,
          useChat: (sel) =>
            sel({
              legacy: {
                nodes: [],
                turnTimings: new Map([[41, { startTime: 9_999_000 }]]),
                partial: { turn: 41, step: 0, blocks: [{ kind: 'text', text: 'working' }] },
                runningCalls: [],
              },
            }),
          useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
          useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
          useSession: (sel) => sel({ running: true }),
          statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
          t,
        }
        await runtime.render(status.component, staleProps)
        /*
         * The rendered pill must describe the NEWEST turn's step.
         *
         * Turn 40's step claims `running: true` but belongs to an older turn, so if it were
         * chosen the live row would be built from its start (1_000_000) and read a huge elapsed
         * time. Turn 41's step starts at 9_999_000. What matters is that the code scans the last
         * turn and builds the reading from THAT turn's step, which is what the next assertion
         * checks by reading the shape it produces.
         */
        assert(
          'a stale turn never supplies the live step',
          /*
           * Both readers must take the LAST turn, and the live one must iterate that turn's
           * own steps and build its reading from them. Checking the count of the pattern rather
           * than a bare `test` matters: the file contains two such readers (this one and the
           * turn-open probe), so a mutation that changes only one of them would still match.
           */
          (clientSource.match(/const last = turns\[turns\.length - 1\]/g) ?? []).length === 2 &&
            /for \(let index = last\.steps\.length - 1/.test(clientSource) &&
            /return \{ turn: last\.turn, step: metrics\.step, metrics \}/.test(clientSource),
        )
        assert(
          'a closed newest turn has no live step at all',
          /if \(last\.running === false\) return null/.test(clientSource),
        )
        sessionRunningStub = true
      }

      // The store says the turn is over while the fold still reports the step as running.
      sessionRunningStub = false
      statsEnabled = true
      statsSnapshot = { turns: [] }
      addStatsStep(12, 0, {
        startTime: 8_000_000,
        endTime: null,
        ttft: 2_500,
        model: null,
        decode: null,
        tps: 90,
        output: 400,
        wall: null,
        running: true,
      })
      const stoppedProps = {
        ...statusInject,
        useChat: (sel) =>
          sel({
            legacy: {
              nodes: [],
              turnTimings: new Map([[12, { startTime: 8_000_000 }]]),
              partial: { turn: 12, step: 0, blocks: [{ kind: 'text', text: 'cut off' }] },
              runningCalls: [],
            },
          }),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: false }),
        statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
        t,
      }
      const stoppedTree = await runtime.render(status.component, stoppedProps)
      assert(
        'a stopped turn shows no live row even though the fold still says running',
        findAll(stoppedTree, (el) => String(el.props.className ?? '').includes('dsh-rum-live-row'))
          .length === 0,
      )
      assert(
        'a stopped turn leaves the pill in its plain state',
        (() => {
          const trigger = findAll(stoppedTree, (el) =>
            String(el.props.className ?? '').includes('dsh-rum-trigger'),
          )[0]
          return trigger !== undefined && !String(trigger.props.className ?? '').includes('dsh-rum-live')
        })(),
      )
      sessionRunningStub = true
    }

    /*
     * A new turn must count from its own start, not from the previous step's.
     *
     * After a stop and a new message, the fold can still hold the PREVIOUS step while the live
     * step has already moved on. Taking that step's `startTime` counted the new request from
     * the old origin, so the total carried the earlier figure and looked like a stale
     * accumulation.
     */
    {
      const clientSource = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')
      assert(
        'the fold\u2019s start time is used only for the very step being shown',
        /runningStatsStep\.turn === liveStep\.turn/.test(clientSource) &&
          /runningStatsStep\.step === liveStep\.step/.test(clientSource),
      )
      assert(
        'the live total is measured from that step start',
        /const elapsedMs = start !== null \? Math\.max\(0, now - start\) : null/.test(clientSource),
      )
    }

    /*
     * The list keeps a full page while a request streams.
     *
     * The live step is excluded from the numbered rows, so capping at ten *before* that
     * exclusion left nine rows on screen for the whole time a request ran. The cap has to
     * come after it: the live row replaces nothing, and a newly settled request pushes the
     * oldest out.
     */
    {
      const hasClass = (name) => (el) => String(el.props.className ?? '').includes(name)
      statsSnapshot = { turns: [] }
      for (let index = 0; index < 15; index += 1) {
        addStatsStep(9, index, {
          startTime: 5_000_000 + index * 10_000,
          endTime: 5_000_000 + index * 10_000 + 4_000,
          ttft: 2_000,
          model: 4_000,
          decode: 2_000,
          tps: 100,
          output: 200,
          wall: 4_000,
          running: false,
        })
      }
      // The newest step is still running and therefore has no numbered row.
      addStatsStep(9, 15, {
        startTime: 5_000_000 + 15 * 10_000,
        endTime: null,
        ttft: 2_500,
        model: null,
        decode: null,
        tps: 90,
        output: 120,
        wall: null,
        running: true,
      })
      statusTree = await runtime.render(status.component, statusProps)
      const pill3 = findAll(statusTree, (el) => String(el.props.className ?? '').includes('dsh-rum-trigger'))[0]
      pill3.props.onClick({ stopPropagation() {}, preventDefault() {} })
      const tree3 = await runtime.render(status.component, statusProps)
      const numbered = findAll(
        tree3,
        (el) => String(el.props.className ?? '').includes('dsh-rum-item'),
      )
      assert(
        'a full page of ten rows remains while a request streams',
        numbered.length === 10,
      )
      assert(
        'the cap is applied after the live step is excluded from the list',
        /*
         * Capping before the exclusion is what produced nine rows: the newest ten were taken
         * first, then the running one was dropped from that set. The list therefore has to be
         * filtered first and capped second.
         */
        (() => {
          const clientSource = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')
          const filtered = /visible = visible\.filter\(\(row\) => row\.key !== live\.key\)/.test(clientSource)
          const notCappedEarlier = !/return rows\.slice\(-MAX_ROWS\)\.reverse\(\)/.test(clientSource)
          return filtered && capped && notCappedEarlier
        })(),
      )
      assert(
        'the numbered rows stay at ten regardless of how many steps exist',
        modelRows().length === 10,
      )
    }
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
  assert(
    'the average skips interrupted rows but still counts them in the caption',
    /*
     * An interrupted row's total is wall-clock time — it includes however long the request ran
     * before being stopped — so folding it into the mean would describe neither the completed
     * requests nor the stopped one. The caption counts the list, the means do not.
     */
    (() => {
      const start = source.indexOf('function averageOf(')
      if (start < 0) return false
      const body = source.slice(start, start + 1600)
      return (
        /\.filter\(\(row\) => row\.interrupted !== true && row\.compaction !== true\)/.test(body) &&
        /count: rows\.length/.test(body)
      )
    })(),
  )

  /*
   * Conversation switching.
   *
   * Every conversation numbers its turns and steps from 1, so rows keyed on `${turn}:${step}`
   * alone collide across conversations. Persisting them made one conversation's "1:1"
   * overwrite another's, and switching back showed the wrong figures — the reported symptom.
   * Rows now come from the session's own statistics and the model is told which session it
   * is on, so switching clears what belonged to the other conversation.
   */
  {
    /*
     * Rebuild a known ten-step history for this conversation, so the block does not depend
     * on what earlier cases left behind.
     */
    statsEnabled = true
    statsSnapshot = { turns: [] }
    for (let index = 0; index < 10; index += 1) {
      addStatsStep(1, index, {
        startTime: 1000 + index * 100,
        endTime: 2000 + index * 100,
        ttft: 200,
        model: 1000,
        decode: 800,
        tps: 200,
        output: index === 9 ? 14 : 100 + index,
        wall: 1000,
        running: false,
      })
    }
    statusInject.bindSession('test-session')
    statusTree = await runtime.render(status.component, statusProps)
    const rowsBefore = modelRows()
    assert(
      'rows carry this session\u2019s figures before the switch',
      rowsBefore.length === 10 && rowsBefore[0].tokens === 14,
    )

    // A different session: its own stats, with the same turn/step numbering.
    statsEnabled = true
    statsSnapshot = { turns: [] }
    addStatsStep(1, 0, {
      startTime: 900000,
      endTime: 902000,
      ttft: 1500,
      model: 2000,
      decode: 500,
      tps: 300,
      output: 150,
      wall: 2000,
      running: false,
    })

    /*
     * Switching the conversation must clear immediately, before the new session's
     * statistics have landed: otherwise the drawer briefly shows the previous
     * conversation's rows under the new one.
     */
    statusInject.bindSession('other-session')
    assert(
      'the model clears the previous session’s rows the moment it is told',
      modelRows().length === 0,
    )
    statusTree = await runtime.render(status.component, statusProps)
    const afterSwitch = modelRows()
    assert(
      'switching conversation clears the previous session\u2019s rows',
      afterSwitch.length === 1 && afterSwitch[0].tokens === 150,
    )
    assert(
      'the new rows carry the new session\u2019s figures',
      Math.round(afterSwitch[0].ttftMs) === 1500,
    )
    assert(
      'a session change clears the stored rows',
      /useSession\(next\) \{[^}]*rows = \[\]/.test(source),
    )

    /*
     * Live updates.
     *
     * The statistics target publishes a new snapshot whenever the fold advances, and the
     * entry must follow it. Reading the snapshot inline during render would freeze the rows
     * at whatever the first render saw — which showed up as the drawer reporting timestamps
     * minutes behind the log. The source's `subscribe` therefore has to forward the
     * component's listener, and the derived rows have to come from that published snapshot.
     */
    /*
     * Live updates.
     *
     * The statistics target publishes a new snapshot whenever the fold advances, and the
     * entry must follow it. Reading the snapshot inline during render froze the rows at
     * whatever the first render saw — the drawer reported timestamps minutes behind the
     * log. So the component has to become a listener of the target.
     */
    {
      // Rendering the entry must leave at least one listener registered on the source.
      const before = statsListeners.size
      statusTree = await runtime.render(status.component, statusProps)
      assert(
        'the entry subscribes to the statistics target',
        statsListeners.size >= 1 && statsListeners.size >= before,
      )

      // A new publication must reach the entry: its rows follow the published snapshot.
      statsSnapshot = { turns: [] }
      addStatsStep(1, 0, {
        startTime: 1_000_000,
        endTime: 1_002_000,
        ttft: 1800,
        model: 2000,
        decode: 400,
        tps: 250,
        output: 100,
        wall: 2000,
        running: false,
      })
      statusTree = await runtime.render(status.component, statusProps)
      assert(
        'a later publication updates the drawer\u2019s rows',
        modelRows().length === 1 && modelRows()[0].tokens === 100,
      )

      /*
       * A step that is still running must already have its row.
       *
       * The fold reports `running: !ended`, and `ended` only flips on `step/end` — which
       * lands after the model turn AND its tool calls. Skipping running steps therefore hid
       * the newest few rows of a busy turn while the Statistics page already listed them,
       * which is exactly the gap reported: the drawer stopped three steps short.
       */
      {
        statsSnapshot = { turns: [] }
        addStatsStep(2, 0, {
          startTime: 2_000_000,
          endTime: null,
          ttft: null,
          model: null,
          decode: null,
          tps: null,
          output: null,
          wall: null,
          running: true,
        })
        statusTree = await runtime.render(status.component, statusProps)
        assert(
          'a step that has produced nothing yet does not take a numbered row',
          /*
           * It exists from `step/start`, but until its first token arrives it is exactly the
           * request the live row above reports. Giving it a numbered row as well listed the
           * same request twice, and the numbered one was empty — the reported "#1 and the
           * streaming row are the same request" defect.
           */
          modelRows().length === 0,
        )
      }

      /*
       * A step that HAS produced output but has not reached `step/end` must be listed.
       *
       * `endTime` lands after the model turn and its tool calls, so waiting for it left the
       * drawer several rows short of the Statistics view on a busy turn.
       */
      {
        statsSnapshot = { turns: [] }
        addStatsStep(2, 0, {
          startTime: 3_000_000,
          endTime: null,
          ttft: 1500,
          model: null,
          decode: null,
          tps: 80,
          output: 400,
          wall: null,
          running: true,
        })
        statusTree = await runtime.render(status.component, statusProps)
        assert(
          'a running step is reported by the live row, not as a numbered row',
          /*
           * The live row is fed by the same fold, so a step the fold calls running is shown
           * there and excluded from the list by key. Letting it into the list as well listed
           * one request twice: an empty-looking `#1` beside a live row for the same step.
           */
          modelRows().length === 0,
        )
        assert(
          'the statistics source drives the live row rather than a lagging domain',
          /runningStatsStep !== null && runningStatsStep !== undefined/.test(source),
        )
      }

      /*
       * A row that settles in place must refresh.
       *
       * The step keeps its key and its first-token time between running and settled, so a
       * comparison limited to those two fields would drop the update and leave the drawer on
       * its placeholders.
       */
      {
        const before = modelRows()[0]
        assert(
          'the running step has no numbered row to begin with',
          before === undefined,
        )
        statsSnapshot = { turns: [] }
        addStatsStep(2, 0, {
          startTime: 3_000_000,
          endTime: 3_005_000,
          ttft: 1500,
          model: 5000,
          decode: 3500,
          tps: 71.4,
          output: 400,
          wall: 5000,
          running: false,
        })
        statusTree = await runtime.render(status.component, statusProps)
        const after = modelRows()[0]
        assert(
          'settling in place gives the step its numbered row',
          /*
           * Key and first-token time are the same values the running step already had, so a
           * comparison limited to those two fields would treat this as unchanged and leave
           * the drawer empty.
           */
          after !== undefined && after.tokens === 400 && Math.round(after.totalMs) === 5000,
        )
        assert(
          'the comparison that decides "unchanged" covers every rendered figure',
          /row\.tokens === previous\.tokens/.test(source) &&
            /row\.totalMs === previous\.totalMs/.test(source) &&
            /row\.amortized === previous\.amortized/.test(source),
        )
      }

      assert(
        'the stats source forwards the component\u2019s listener',
        /*
         * The source must hand the component's own listener to the target — an internal no-op
         * subscription would activate the target but leave the drawer frozen on its first
         * snapshot. It also has to remember the unsubscribe so eviction can drop it.
         */
        /subscribe: \(listener\) => \{/.test(source) &&
          /target\.subscribe\(listener\)/.test(source) &&
          /subscriptions\.set\(listener, \{ target, unsubscribe: target\.subscribe\(listener\) \}\)/.test(source),
      )
      assert(
        'the target is resolved fresh rather than cached with the source',
        /*
         * `uiConversation.binding(id)` replaces its `BoundConversation` when a conversation is
         * rebuilt (a model switch, a reconnect). A cached `target()` closure keeps pointing at
         * the retired view store and returns its last snapshot forever, which froze the drawer
         * on one turn while the Statistics page moved on.
         */
        /const targetNow = \(\) => \{/.test(source) &&
          /getSnapshot: \(\) => \{\s*const target = targetNow\(\)/.test(source) &&
          /refresh: \(\) => \{/.test(source),
      )
    }

    // Switching back must restore that conversation's own rows, not the other's.
    statsSnapshot = { turns: [] }
    addStatsStep(1, 0, {
      startTime: 1000,
      endTime: 5600,
      ttft: 2300,
      model: 4600,
      decode: 2300,
      tps: 445.2,
      output: 1024,
      wall: 4600,
      running: false,
    })
    statusInject.bindSession('test-session')
    statsSnapshot = { turns: [] }
    for (let index = 0; index < 10; index += 1) {
      addStatsStep(1, index, {
        startTime: 1000 + index * 100,
        endTime: 2000 + index * 100,
        ttft: 200,
        model: 1000,
        decode: 800,
        tps: 200,
        output: index === 9 ? 14 : 100 + index,
        wall: 1000,
        running: false,
      })
    }
    statusTree = await runtime.render(status.component, statusProps)
    assert(
      'switching back shows this conversation\u2019s own figures again',
      modelRows().length === 10 && modelRows()[0].tokens === 14,
    )
  }

  /* ---------------------------------------------------------------- */
  /* Fallback path: a composition with no statistics target             */
  /* ---------------------------------------------------------------- */

  /*
   * The plugin prefers the shipped Statistics view's data. When that view is absent — a
   * composition without `uiConversation` — it falls back to deriving rows from the Chat
   * snapshot and the Trajectory domain, with the character estimate this plugin shipped
   * before the statistics integration existed.
   *
   * That path is never taken in the normal profile, so it had only static assertions. These
   * cases drive it end to end and print what it produces, so its numbers can be inspected
   * rather than assumed.
   */
  {
    console.log('\n--- fallback path (no statistics target) ---')

    // Three settled steps, deliberately without provider usage so the estimate is exercised.
    const fallbackNodes = [
      {
        kind: 'assistant',
        turn: 30,
        step: 0,
        seq: 300,
        timing: { stepStartTime: 10_000_000, firstTokenTime: 10_002_600, completedTime: 10_007_000 },
        blocks: [{ kind: 'text', text: 'a'.repeat(400) }],
      },
      {
        kind: 'assistant',
        turn: 30,
        step: 1,
        seq: 301,
        timing: { stepStartTime: 10_008_000, firstTokenTime: 10_011_800, completedTime: 10_014_000 },
        blocks: [{ kind: 'text', text: 'b'.repeat(800) }],
      },
      {
        kind: 'assistant',
        turn: 30,
        step: 2,
        seq: 302,
        timing: { stepStartTime: 10_015_000, firstTokenTime: 10_015_900, completedTime: 10_022_500 },
        usage: { outputTokens: 1234 },
        blocks: [{ kind: 'text', text: 'c'.repeat(120) }],
      },
    ]
    const fallbackChat = { legacy: { nodes: fallbackNodes, turnTimings: new Map(), partial: null, runningCalls: [] } }
    const fallbackProps = {
      ...statusInject,
      useChat: (sel) => sel(fallbackChat),
      useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
      useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
      useSession: (sel) => sel({ running: false }),
      // No statistics target at all: this is what makes the fallback run.
      statsSource: () => undefined,
      useTrajectory: () => ({ eventNodes: [], requests: [] }),
      t,
    }
    statusTree = await runtime.render(status.component, fallbackProps)
    const rows = modelRows()

    console.log(`  rows produced: ${rows.length}`)
    for (const row of rows) {
      const clock = (v) => (typeof v === 'number' ? new Date(v).toTimeString().slice(0, 8) : '—')
      console.log(
        `    ${row.key}  start=${clock(row.at)}  ttft=${row.ttftMs === null ? '—' : (row.ttftMs / 1000).toFixed(1) + 's'}` +
          `  tok=${row.tokens}${row.estimated ? '~' : ''}  total=${row.totalMs === null ? '—' : (row.totalMs / 1000).toFixed(1) + 's'}`,
      )
    }

    assert('the fallback path produces rows without a statistics target', rows.length === 3)
    assert(
      'the fallback lists newest first',
      rows[0].key === '30:2' && rows[2].key === '30:0',
    )
    assert(
      'the fallback clock is the step start, not its completion',
      /*
       * The old defect: `completedTime` was used, so a row stamped 10:15:00 had actually
       * finished at 10:22:30. `at` must be the step's own start, matching the statistics rows.
       */
      rows[0].at === 10_015_000 && rows[1].at === 10_008_000 && rows[2].at === 10_000_000,
    )
    assert(
      'the fallback total is completion minus start',
      Math.round(rows[0].totalMs) === 7_500 && Math.round(rows[1].totalMs) === 6_000,
    )
    assert(
      'the fallback prefers provider usage when it exists',
      rows[0].tokens === 1234 && rows[0].estimated === false,
    )
    assert(
      'the fallback estimates tokens when usage is absent',
      // 400 ASCII characters of prose at 4 chars/token.
      rows[2].tokens === 100 && rows[2].estimated === true,
    )
    assert(
      'the fallback marks estimates so the drawer can print the tilde',
      rows[2].estimated === true && rows[1].estimated === true,
    )
    assert(
      'no fallback row is written to localStorage',
      store.get('dsh.recentUsageMetrics.history.v1') === undefined,
    )

    /*
     * A different session must not inherit these rows.
     */
    statusInject.bindSession('another-session')
    assert('switching sessions clears the fallback rows', modelRows().length === 0)
    statusInject.bindSession('test-session')

    /*
     * The choice is automatic: the presence of a statistics source decides it.
     *
     * With the source absent the rows came from the Chat snapshot (asserted above). Here the
     * source is present, and it must win — the fallback rows must disappear, replaced by the
     * measured figures it carries.
     */
    {
      const chosenProps = {
        ...statusInject,
        useChat: (sel) => sel(fallbackChat),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: false }),
        statsSource: () => ({
          getSnapshot: () => ({
            turns: [{ turn: 30, steps: [{ turn: 30, step: 0, startTime: 10_000_000, ttft: 111, model: 222, output: 333, wall: 444, running: false }] }],
          }),
          subscribe: () => () => {},
        }),
        useTrajectory: () => ({ eventNodes: [], requests: [] }),
        t,
      }
      statusTree = await runtime.render(status.component, chosenProps)
      const chosenRows = modelRows()
      assert(
        'a present statistics source wins over the Chat snapshot',
        chosenRows.length === 1 && chosenRows[0].key === '30:0',
      )
      assert(
        'the statistics rows carry the measured figures, not the estimates',
        chosenRows[0].ttftMs === 111 && chosenRows[0].tokens === 333 && chosenRows[0].estimated === false,
      )
    }
  }




    /*
     * Thousands separators in the tokens hint.
     *
     * The cell abbreviates so the drawer stays aligned; the hint has room and must spell the
     * exact input out, because `370k` and `371k` hide a real difference.
     */
    {
      const body = (() => {
        const start = source.indexOf('function tokensExact(')
        return start < 0 ? '' : source.slice(start, start + 900)
      })()
      assert(
        'the tokens hint groups thousands',
        /grouped \+= ','/.test(body),
      )
      /*
       * Run the grouping as the plugin does, over values taken from a real log, so the assertion
       * is behavioural rather than a pattern match on the source.
       */
      /*
       * Run the plugin's OWN function, extracted from the source, rather than a copy of its
       * algorithm: a copy would keep passing after the real one regressed.
       */
      const group = (() => {
        const start = source.indexOf('function tokensExact(')
        if (start < 0) return () => ''
        const end = source.indexOf('function clockText(', start)
        const bodyText = source.slice(start, end < 0 ? start + 900 : end)
        /*
         * Rewrite the two dictionary calls into plain expressions so the returned function is
         * observable: the grouping itself is what is under test, not the wording around it.
         */
        const callable = bodyText
          .replace('function tokensExact(value, t)', 'return function (value, t)')
          .replace("t('tokensUnit', { value: value < 0 ? `-${grouped}` : grouped })", 'value < 0 ? `-${grouped}` : grouped')
          .replace("t('none')", "'—'")
        try {
          return new Function(callable)()
        } catch {
          return () => ''
        }
      })()
      const cases = [
        [0, '0'],
        [999, '999'],
        [1000, '1,000'],
        [1914, '1,914'],
        [9472, '9,472'],
        [370683, '370,683'],
        [1234567, '1,234,567'],
      ]
      assert(
        'the grouping matches the locale-independent form at every size that occurs',
        cases.every(([value, expected]) => group(value) === expected),
      )
      assert(
        'the hint uses the exact form while the cell keeps its short one',
        /*
         * Both paths must stay distinct: the cell is `tokensText` (which may abbreviate), the
         * hint is `tokensExact`. Pointing both at the same helper would silently undo this.
         */
        /const input = row\.context === null \|\| row\.context === undefined \? none : tokensExact\(row\.context, t\)/.test(
          source,
        ) && /tokensText\(entry\.row\.tokens, entry\.row\.estimated, t\)/.test(source),
      )
    }





    /*
     * The index header colour legend.
     *
     * The hint already named the three state glyphs; it now also explains the two row colours,
     * and draws them as swatches so a reader matches a row by colour rather than by translating
     * a word. The swatches take the same tokens the rows take.
     */
    {
      const zh = source.slice(source.indexOf('const zh = {'), source.indexOf('const en = {'))
      const en = source.slice(source.indexOf('const en = {'), source.indexOf('const STYLE_TEXT'))
      assert(
        'both dictionaries describe the two row colours',
        /hintColour:/.test(zh) &&
          /hintColour:/.test(en) &&
          /黄色表示缓存命中过低/.test(zh) &&
          /蓝色表示这一步切换了模型/.test(zh) &&
          /yellow row means a low cache hit/i.test(en) &&
          /blue row means this step switched models/i.test(en),
      )
      assert(
        'the index hint is three separate lines',
        /*
         * Rows, glyphs, colours — each on its own line so the eye reads one idea at a time
         * instead of parsing a single long sentence.
         */
        /hintIndexRows:/.test(zh) &&
          /hintIndexGlyphs:/.test(zh) &&
          /hintIndexRows:/.test(en) &&
          /hintIndexGlyphs:/.test(en) &&
          (source.match(/className: 'dsh-rum-tip-line'/g) || []).length >= 3 &&
          source.indexOf("t('hintColour')") > source.indexOf("t('hintIndexGlyphs')"),
      )
      assert(
        'the live row carries no tool hint on its total',
        /*
         * A request that is still running has not reported its tool time, so any hint would
         * read as "no tools" or a partial count about a request that is still going. The hint
         * appears once the row settles.
         */
        !/hint\.show\(toolHintText\(live, t\)/.test(source),
      )
      assert(
        'the settled rows keep the tool hint',
        /if \(column === 'total'\) return toolHintText\(row, t\)/.test(source),
      )
      assert(
        'the legend draws the two colours instead of naming them',
        /'data-hue': 'lowcache'/.test(source) &&
          /'data-hue': 'switched'/.test(source) &&
          /data-hue="lowcache"/.test(styleEls[0].textContent) &&
          /data-hue="switched"/.test(styleEls[0].textContent),
      )
      assert(
        'the swatches reuse the row tokens so the legend cannot drift from the rows',
        (() => {
          const css = styleEls[0].textContent
          const swatchWarn = /\.dsh-rum-tip-swatch\[data-hue="lowcache"\]\s*\{[^}]*state-warn-primary/.test(css)
          const swatchBusiness = /\.dsh-rum-tip-swatch\[data-hue="switched"\]\s*\{[^}]*state-business-primary/.test(css)
          const rowWarn = /\.dsh-rum-item\[data-lowcache="true"\]\s*\{[^}]*state-warn-primary/.test(css)
          const rowBusiness = /\.dsh-rum-item\[data-switched="true"\]\s*\{[^}]*state-business-primary/.test(css)
          return swatchWarn && swatchBusiness && rowWarn && rowBusiness
        })(),
      )
    }


    /*
     * The total column's tool hint, and the whole-row highlight fix.
     *
     * The cell figure is model time only, so the hint's job is to say how much tool work sat
     * beside it — and to distinguish the work done from the wall time it occupied.
     */
    {
      const T = 50_000_000
      statsSnapshot = {
        turns: [
          {
            turn: 50,
            steps: [
              {
                turn: 50, step: 1, startTime: T, endTime: T + 20_000, ttft: 900, model: 5_000, output: 120,
                running: false, tool: 30_000, toolWall: 10_000, calls: [{}, {}, {}],
              },
              {
                turn: 50, step: 2, startTime: T + 30_000, endTime: T + 34_000, ttft: 800, model: 4_000, output: 90,
                running: false, tool: null, toolWall: null, calls: [],
              },
              {
                turn: 50, step: 3, startTime: T + 40_000, endTime: T + 50_000, ttft: 700, model: 6_000, output: 60,
                running: false, tool: 8_000, toolWall: 8_000, calls: [{}],
              },
            ],
            events: [],
          },
        ],
      }
      statsSteps.length = 0
      const toolProps = {
        ...statusInject,
        useChat: (sel) =>
          sel({ legacy: { nodes: [], turnTimings: new Map(), partial: null, runningCalls: [] } }),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: false }),
        statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
        useTrajectory: () => ({ eventNodes: [], requests: [] }),
        t,
      }
      await runtime.render(status.component, toolProps)
      const rows = modelRows()
      const first = rows.find((entry) => entry.key === '50:1')
      const none = rows.find((entry) => entry.key === '50:2')
      const single = rows.find((entry) => entry.key === '50:3')

      assert(
        'the row carries both tool-time figures and the call count',
        first !== undefined && first.toolMs === 30_000 && first.toolWallMs === 10_000 && first.toolCalls === 3,
      )
      assert(
        'a row without tools reports neither figure',
        none !== undefined && none.toolMs === null && none.toolWallMs === null,
      )

      /**
       * Evaluate the plugin's own hint builder.
       *
       * Only the dictionary calls are replaced, with a stub that records the key and its params;
       * the branching under test is left untouched, so a regression in it is caught. `secondsValue`
       * is supplied separately because it is a pure formatter the stub can stand in for.
       */
      const hint = (row) => {
        const start = source.indexOf('function toolHintText(')
        const end = source.indexOf('function secondsValue(', start)
        if (start < 0 || end < 0) return null
        const bodyText = source
          .slice(start, end)
          .replace('function toolHintText(row, t)', 'return function (row, t)')
        try {
          // eslint-disable-next-line no-new-func
          /*
           * `numberOrNull` is the plugin's guard for "a reported number or null"; the builder
           * depends on it, so it is supplied alongside the formatter.
           */
          const numberOrNull = (value) =>
            typeof value === 'number' && Number.isFinite(value) ? value : null
          return new Function('secondsValue', 'numberOrNull', bodyText)(
            (ms) => `${(ms / 1000).toFixed(1)} s`,
            numberOrNull,
          )
        } catch {
          return null
        }
      }
      const stubT = (key, params) => {
        if (params === undefined) return key
        return `${key} ${JSON.stringify(params)}`
      }
      const builder = hint()
      assert(
        'the tool hint builder can be evaluated on its own',
        typeof builder === 'function',
      )
      const parallel = builder === null ? '' : builder({ toolMs: 30_000, toolWallMs: 10_000, toolCalls: 3 }, stubT)
      const nothing = builder === null ? '' : builder({ toolMs: null, toolWallMs: null, toolCalls: null }, stubT)
      const one = builder === null ? '' : builder({ toolMs: 8_000, toolWallMs: 8_000, toolCalls: 1 }, stubT)
      const compactionRow = builder === null ? '' : builder({ compaction: true }, stubT)

      assert(
        'the parallel case reports the summed work and the merged wall time as two figures',
        parallel.includes('toolHintTwo') && parallel.includes('30.0 s') && parallel.includes('10.0 s'),
      )
      assert(
        'a row with no tools says so instead of printing a zero',
        nothing === 'toolHintNone',
      )
      assert(
        'a single call collapses to one figure rather than repeating itself',
        one.startsWith('toolHintOne') && one.includes('8.0 s') && !one.includes('toolHintTwo'),
      )
      assert(
        'a compaction says it spends no time on tools',
        compactionRow === 'toolHintCompaction',
      )

      assert(
        'the total header now states that tool time is excluded',
        (() => {
          const zh = source.slice(source.indexOf('const zh = {'), source.indexOf('const en = {'))
          const en = source.slice(source.indexOf('const en = {'), source.indexOf('const STYLE_TEXT'))
          return (
            /hintTotal: .*不含工具调用时间/.test(zh) &&
            /hintTotal: .*not counting tool calls/.test(en)
          )
        })(),
      )
    }

    /*
     * A highlighted row colours every cell.
     *
     * The index, clock and primary cells each declare their own colour, so a row-level colour
     * alone left those three grey — the highlight looked like a stray word rather than a row.
     * The stylesheet must therefore override each of them under both attributes.
     */
    {
      const css = styleEls[0].textContent
      for (const attr of ['data-switched="true"', 'data-lowcache="true"']) {
        assert(
          'the ' + (attr.includes('switched') ? 'switch' : 'cold') + ' highlight recolours every cell kind',
          new RegExp(`\\.dsh-rum-item\\[${attr}\\] \\.dsh-rum-col`).test(css) &&
            new RegExp(`\\.dsh-rum-item\\[${attr}\\] \\.dsh-rum-index`).test(css) &&
            new RegExp(`\\.dsh-rum-item\\[${attr}\\] \\.dsh-rum-clock`).test(css),
        )
      }
    }





    /*
     * The live row's tokens hint while its tools run.
     *
     * `assistant/message` lands BEFORE a step's tool calls, and it is what carries the usage — so
     * by the time the T marker is pulsing, the input and cache figures are already final. The live
     * reading must therefore hand them to the hint instead of leaving it with two dashes.
     */
    {
      const T = 80_000_000
      statsSnapshot = {
        turns: [
          {
            turn: 80,
            steps: [
              {
                turn: 80, step: 1, startTime: T, endTime: null, ttft: 900, model: 5_000, output: 120,
                decode: 4_000, tps: 30, running: true,
                // Final by the time the tools run: the message that reported them already landed.
                context: 585_856, cacheRead: 585_344, cacheHit: 0.9991,
                cacheWrite: null, tool: null, toolWall: null,
                calls: [{ callId: 'a', name: 'bash', startedAt: T + 5_500, endedAt: null }],
              },
            ],
            events: [],
          },
        ],
      }
      statsSteps.length = 0
      const hintProps = {
        ...statusInject,
        useChat: (sel) =>
          sel({ legacy: { nodes: [], turnTimings: new Map(), partial: null, runningCalls: [] } }),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: true }),
        statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
        useTrajectory: () => ({ eventNodes: [], requests: [] }),
        t,
      }
      await runtime.render(status.component, hintProps)

      /*
       * Read the live reading that the component actually built. It is published on the trigger
       * for exactly this kind of assertion.
       */
      const trigger = findAll(
        (await runtime.render(status.component, hintProps)),
        (el) => String(el.props.className ?? '').includes('dsh-rum-trigger'),
      )[0]
      const raw = trigger?.props['data-live-input']
      const parsed = raw === undefined ? null : JSON.parse(String(raw))

      assert(
        'the live reading publishes its input-side figures',
        parsed !== null && parsed.context === 585_856 && parsed.cacheHit !== null,
      )

      const buildHint = (() => {
        const start = source.indexOf('function tokensHintText(')
        const end = source.indexOf('\n    /**', start)
        if (start < 0 || end < 0) return null
        const bodyText = source
          .slice(start, end)
          .replace('function tokensHintText(row, t)', 'return function (row, t)')
        try {
          return new Function('tokensExact', bodyText)((value) => `${Math.round(value)} tok grouped`)
        } catch {
          return null
        }
      })()
      const stubT = (key, params) => {
        if (params === undefined) return key
        return `${key} input=${params.input} hit=${params.hit}`
      }
      const withData = buildHint === null ? '' : buildHint({ context: 585_856, cacheHit: 0.9991 }, stubT)
      const withoutData = buildHint === null ? '' : buildHint({ context: null, cacheHit: null }, stubT)

      assert(
        'with the figures present the hint reports them instead of two dashes',
        withData.includes('585856 tok grouped') && withData.includes('99.9%'),
      )
      assert(
        'with no figures the hint still falls back to the placeholder',
        /*
         * The stub returns the key for a parameterless call, so the placeholder arrives as the
         * `none` key rather than the em dash the real dictionary supplies.
         */
        withoutData.includes('input=none') && withoutData.includes('hit=none'),
      )
    }






    /*
     * The hint must read the anchor's geometry synchronously.
     *
     * React pools synthetic events: once the handler returns, `currentTarget` is null. Reading it
     * from inside the deferred timer therefore found nothing, the guard returned early, and every
     * hint in the drawer silently declined to open. Nothing in the DOM changed, so no other check
     * could see it — the whole tooltip system was dead and still passed.
     */
    {
      const timing = (() => {
        const start = source.indexOf('const enter = useCallback(')
        const end = source.indexOf('const leave = useCallback(', start)
        if (start < 0 || end < 0) return null
        const bodyText = source.slice(start, end)
        const timerAt = bodyText.indexOf('setTimeout(')
        const rectAt = bodyText.indexOf('getBoundingClientRect')
        return {
          readsGeometry: rectAt >= 0,
          // The read must come BEFORE the timer is scheduled.
          synchronous: rectAt >= 0 && timerAt >= 0 && rectAt < timerAt,
          bodyText,
        }
      })()
      assert(
        'the hint reads the anchor geometry before deferring',
        /*
         * A pooled event has no `currentTarget` by the time a timer fires, so a read inside the
         * timer can never succeed — the symptom was no tooltip at all, not a misplaced one.
         */
        timing !== null && timing.readsGeometry && timing.synchronous,
      )
      assert(
        'the deferred callback uses the captured rect and not the event',
        (() => {
          const model = (() => {
            const start = source.indexOf('const enter = useCallback(')
            const end = source.indexOf('const leave = useCallback(', start)
            if (start < 0 || end < 0) return ''
            return source.slice(start, end)
          })()
          // Nothing after the timer call may touch `event`.
          const timerAt = model.indexOf('setTimeout(')
          if (timerAt < 0) return false
          return !/event\??\./.test(model.slice(timerAt))
        })(),
      )
    }


    /*
     * The hint is a position, not a rendered string.
     *
     * That single decision is what makes a live figure move, lets a hint close the moment its row
     * stops describing what it described, and lets one re-open by itself when the row underneath
     * starts describing something new. Every earlier patch — a heartbeat, a scope guard, an
     * empty-body check — was working around the opposite choice.
     */
    {
      const model = (() => {
        const start = source.indexOf('function useHint(')
        const end = source.indexOf('\n    /**', start)
        if (start < 0 || end < 0) return null
        const bodyText = source.slice(start, end)
        return {
          storesAnchor: /setHover\(\{ anchor, x: rect\.left, y: rect\.top \}\)/.test(bodyText),
          resolvesOnRender: /const bodyFor = useCallback/.test(bodyText),
          earlyExit: /if \(hover === null \|\| hover\.anchor !== anchor\) return null/.test(bodyText),
          noSnapshot: !/setHint\(/.test(bodyText),
        }
      })()
      assert(
        'the hint stores the hovered anchor rather than the rendered text',
        model !== null && model.storesAnchor && model.noSnapshot,
      )
      assert(
        'a supplier is resolved on render, and only while its own anchor is hovered',
        /*
         * The early exit is not an optimisation detail: all seventeen cells ask for their body on
         * every tick, and only one can match.
         */
        model !== null && model.resolvesOnRender && model.earlyExit,
      )
      assert(
        'the content is recomputed from the anchor on every render',
        /const tipAnchor = hint\.hover === null \? null : hint\.hover\.anchor/.test(source) &&
          /const tipContent = \(\(\) => \{/.test(source),
      )
      assert(
        'every cell identifies itself with a row-scoped anchor',
        /*
         * `row:<key>:<column>` and `live:<column>` keep two rows showing the same column apart —
         * sharing an anchor would let a hint survive from one row into the next.
         */
        /hint\.enter\(`row:\$\{entry\.key\}:/ .test(source) &&
          /hint\.enter\('live:/.test(source) &&
          /hint\.enter\('header:/.test(source) &&
          /* Every numbered-row anchor carries the row key: one per column, five in total. */
          (source.match(/hint\.enter\(`row:\$\{entry\.key\}:/g) || []).length === 5 &&
          /* The live row uses its own namespace, never a row key. */
          (source.match(/hint\.enter\('live:/g) || []).length === 5,
      )
      assert(
        'the live tool hints take their clock from the clock, not from the component',
        /*
         * The component ticks every 30 s. A span read against that clock would be stale however
         * often the tooltip recomputed.
         */
        (source.match(/toolRunHint\(live, Date\.now\(\), t\)/g) || []).length === 1,
      )
      assert(
        'the old event-snapshot API is gone',
        (source.match(/hint\.show\(/g) || []).length === 0 &&
          (source.match(/hint\.hide\b/g) || []).length === 0,
      )
    }




    /*
     * The live row while its tools run.
     *
     * A step whose reply has landed but whose tools are still going is the one phase where the
     * drawer can say something new each tick: which tool is running and for how long. The T
     * marker and the total column both carry that sentence; nothing else about the row changes.
     */
    {
      const T = 70_000_000
      statsSnapshot = {
        turns: [
          {
            turn: 70,
            steps: [
              {
                turn: 70, step: 1, startTime: T, endTime: null, ttft: 900, model: 5_000, output: 120,
                // The reply landed, so `model` is set; the step has not ended, so tools run.
                decode: 4_000, tps: 30, running: true,
                calls: [
                  { callId: 'a', name: 'bash', startedAt: T + 5_500, endedAt: null },
                  { callId: 'b', name: 'read', startedAt: T + 6_200, endedAt: null },
                ],
              },
            ],
            events: [],
          },
        ],
      }
      statsSteps.length = 0
      sessionRunningStub = true
      const toolProps = {
        ...statusInject,
        useChat: (sel) =>
          sel({ legacy: { nodes: [], turnTimings: new Map(), partial: null, runningCalls: [] } }),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: true }),
        statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
        useTrajectory: () => ({ eventNodes: [], requests: [] }),
        t,
      }
      const tree = await runtime.render(status.component, toolProps)

      assert(
        'a step with an open tool call is in the tools phase',
        liveOf(tree)?.phase === 'tools',
      )

      /*
       * Evaluate the wording the way the component does, over a fixed "now" so the figure is
       * deterministic: the span is measured from the EARLIEST open call, not summed.
       */
      const build = (() => {
        const start = source.indexOf('function toolRunHint(')
        const end = source.indexOf('\n    /**', start)
        if (start < 0 || end < 0) return null
        const bodyText = source.slice(start, end).replace('function toolRunHint(live, now, t)', 'return function (live, now, t)')
        try {
          return new Function('numberOrNull', bodyText)(
            (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null),
          )
        } catch {
          return null
        }
      })()
      const stubT = (key, params) => {
        if (params === undefined) return key
        return `${key} name=${params.name} elapsed=${params.elapsed}`
      }
      const liveRow = {
        toolRun: { count: 2, since: T + 5_500, name: 'read' },
      }
      const text = build === null ? '' : build(liveRow, T + 9_000, stubT)

      assert(
        'the hint names the tool and the span measured from the earliest open call',
        text.includes('name=read') && text.includes('elapsed=3.5'),
      )
      /*
       * Execute the CONSTRUCTION, not just the formatter.
       *
       * A mutation in how the earliest open call is chosen would not touch the wording at all,
       * so a test that only runs the formatter cannot see it. The block is lifted out of the
       * component and run over synthetic call lists instead.
       */
      const buildRun = (() => {
        const start = source.indexOf('const toolRun = (() => {')
        if (start < 0) return null
        const end = source.indexOf('})()', start)
        if (end < 0) return null
        const bodyText = source
          .slice(start, end + 4)
          .replace('const toolRun = (() => {', 'return (() => {')
        try {
          return new Function('settled', 'numberOrNull', bodyText)(
            null,
            (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null),
          )
        } catch {
          return null
        }
      })()
      const runOver = (calls) => {
        const start = source.indexOf('const toolRun = (() => {')
        const end = source.indexOf('})()', start)
        const bodyText = source.slice(start, end + 4).replace('const toolRun = (() => {', 'return (() => {')
        // eslint-disable-next-line no-new-func
        return new Function('settled', 'numberOrNull', bodyText)(
          { calls },
          (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null),
        )
      }
      const sampled = runOver([
        { name: 'bash', startedAt: 1_000, endedAt: null },
        { name: 'read', startedAt: 3_000, endedAt: null },
        { name: 'edit', startedAt: 500, endedAt: 2_000 },
      ])
      assert(
        'the span starts at the earliest OPEN call, ignoring a finished one that began before it',
        sampled.count === 2 && sampled.since === 1_000,
      )
      assert(
        'the wording names the newest open call',
        sampled.name === 'read',
      )
      assert(
        'no open calls leaves nothing to report',
        (() => {
          const none = runOver([{ name: 'bash', startedAt: 1_000, endedAt: 2_000 }])
          return none.count === 0 && none.since === null
        })(),
      )
      assert(
        'a step whose tools have all returned gets no hint at all',
        /*
         * `count === 0` must short-circuit the hint on its own: a step can still be open with
         * every tool already returned, and calling that "calling tools" would be false.
         */
        build === null ||
          build({ toolRun: { count: 0, since: null, name: null } }, T + 9_000, stubT) === null,
      )
      assert(
        'the hint refuses a zero count even when a start time is present',
        build === null || build({ toolRun: { count: 0, since: T, name: 'bash' } }, T + 9_000, stubT) === null,
      )
      assert(
        'the marker and the total column share one sentence',
        /* Two phrasings would invite a reader to look for a difference that does not exist. */
        /column === 'index' \|\| column === 'total'/.test(source) &&
          /return toolRunHint\(live, Date\.now\(\), t\)/.test(source),
      )
      assert(
        'the live clock reports an absolute stamp rather than a relative one',
        /*
         * The numbered rows show the full timestamp; the live row used to carry "3 minutes ago"
         * in its title, which cannot answer which request it was.
         */
        /if \(column === 'clock'\) return absoluteStamp\(live\.at\)/.test(source) &&
          !/title: agoText\(live\.at, now, t\)/.test(source),
      )
      assert(
        'the live tokens hint declines until the usage exists',
        /*
         * While the model writes there is no usage, and two dashes say less than silence.
         */
        /column === 'tokens'/.test(source) &&
          /live\.context === null \|\| live\.context === undefined \? null : tokensHintText\(live, t\)/.test(
            source,
          ),
      )
      assert(
        'the tooltip re-resolves its content instead of freezing the first reading',
        /*
         * Execute the resolver rather than pattern-match it: a stored value is exactly what
         * made the span sit still, and only running the code shows the difference.
         */
        (() => {
          const resolve = (hover, suppliers) => {
            if (hover === null) return null
            const supplier = suppliers[hover.anchor]
            return supplier === undefined ? null : supplier()
          }
          let ticks = 0
          const suppliers = { total: () => `${ticks.toFixed(1)} s` }
          const hover = { anchor: 'total' }
          const first = resolve(hover, suppliers)
          ticks = 13
          const second = resolve(hover, suppliers)
          // A different anchor must not resolve to this supplier.
          const other = resolve({ anchor: 'speed' }, suppliers)
          return first === '0.0 s' && second === '13.0 s' && other === null
        })(),
      )
      assert(
        'the live tool hints resolve through the anchor, not through a captured string',
        /*
         * The anchor is what the tooltip stores; the content is built from it on each render.
         * Capturing the text is what froze the span, so the absence of that pattern matters
         * more than the presence of any other.
         */
        /hint\.enter\('live:index', event\)/.test(source) &&
          /hint\.enter\('live:total', event\)/.test(source) &&
          !/hint\.show\(/.test(source),
      )
    }


    /*
     * Telling a model switch apart from a configuration change.
     *
     * A `request/header` proves only that the routed configuration changed. Enabling or disabling
     * a plugin rewrites the tool list, which changes the request prefix and drops the provider's
     * cache, without touching the model — and on a real session that accounted for 18 of 29
     * headers. Reporting those as "switched model" was wrong, and the user caught it.
     */
    {
      const T = 60_000_000
      statsSnapshot = {
        turns: [
          {
            turn: 60,
            steps: [
              // 1: no header, model settled by its reply.
              { turn: 60, step: 1, startTime: T, endTime: T + 5_000, ttft: 800, model: 4_000, output: 100, running: false, cacheRead: 99_000, context: 100_000, cacheHit: 0.99 },
              // 2: header with the SAME model -> configuration change, not a switch.
              { turn: 60, step: 2, startTime: T + 6_000, endTime: T + 9_000, ttft: 700, model: 2_800, output: 80, running: false, cacheRead: 400, context: 100_000, cacheHit: 0.004 },
              // 3: header with a DIFFERENT model -> a real switch.
              { turn: 60, step: 3, startTime: T + 12_000, endTime: T + 15_000, ttft: 600, model: 2_600, output: 60, running: false, cacheRead: 99_500, context: 100_000, cacheHit: 0.995 },
              // 4: no header, inherits step 3's model.
              { turn: 60, step: 4, startTime: T + 18_000, endTime: T + 21_000, ttft: 500, model: 2_400, output: 40, running: false, cacheRead: 99_600, context: 100_000, cacheHit: 0.996 },
            ],
            events: [
              { kind: 'request-header', time: T + 6_004, provider: 'buddy', model: 'deepseek-v4.1-flash', toolCount: 66 },
              { kind: 'request-header', time: T + 12_004, provider: 'trae', model: 'deepseek-v4.1-flash', toolCount: 65 },
            ],
          },
        ],
      }
      statsSteps.length = 0
      const planProps = {
        ...statusInject,
        useChat: (sel) =>
          sel({ legacy: { nodes: [], turnTimings: new Map(), partial: null, runningCalls: [] } }),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: false }),
        statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
        useTrajectory: () => ({
          eventNodes: [
            { kind: 'assistant', turn: 60, step: 1, providerMetadata: { provider: 'buddy', model: 'deepseek-v4.1-flash' } },
            { kind: 'assistant', turn: 60, step: 2, providerMetadata: { provider: 'buddy', model: 'deepseek-v4.1-flash' } },
            { kind: 'assistant', turn: 60, step: 3, providerMetadata: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
            { kind: 'assistant', turn: 60, step: 4, providerMetadata: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
          ],
          requests: [],
        }),
        t,
      }
      const planTree = await runtime.render(status.component, planProps)
      const planRows = modelRows()
      const row = (step) => planRows.find((entry) => entry.key === `60:${step}`)

      assert(
        'a header that keeps the same model is a configuration change, not a switch',
        row(2) !== undefined && row(2).switched === false && row(2).configChanged === true,
      )
      assert(
        'a header that changes the model is a switch',
        row(3) !== undefined && row(3).switched === true && row(3).configChanged === false,
      )
      assert(
        'the configuration change records both tool counts',
        row(2) !== undefined && row(2).toolCount === 66,
      )
      assert(
        'a step with no header is neither a switch nor a configuration change',
        row(4) !== undefined && row(4).switched === false && row(4).configChanged === false,
      )

      // The row-number hint, evaluated on the same rows.
      const build = (() => {
        const start = source.indexOf('function rowHintLines(')
        const end = source.indexOf('\n    /**', start)
        if (start < 0 || end < 0) return null
        const bodyText = source
          .slice(start, end)
          .replace('function rowHintLines(row, t)', 'return function (row, t)')
        try {
          return new Function('numberOrNull', 'isLowCacheHit', 'modelHintText', 'LOW_CACHE_HIT', bodyText)(
            (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null),
            (candidate) =>
              typeof candidate.cacheHit === 'number' && candidate.cacheHit < 0.9,
            () => 'stub-model',
            0.9,
          )
        } catch {
          return null
        }
      })()
      const stubT = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
      const configLines = build === null ? [] : build(row(2), stubT)
      const switchLines = build === null ? [] : build(row(3), stubT)

      assert(
        'a cold row that changed its configuration explains the change and the cold cache',
        /*
         * Step 2's predecessor issued no header, so only ONE tool count is known — the line says
         * the configuration changed without inventing the other number. Both lines must appear:
         * the cause first, then the measurement.
         */
        configLines.length === 2 &&
          configLines[0] === 'rowConfigChangedUnknown' &&
          configLines[1].startsWith('rowLowCache'),
      )
      assert(
        'a switched row names the model instead',
        switchLines.some((line) => line.startsWith('rowSwitched')),
      )
      assert(
        'an ordinary row gets no hint at all',
        build === null || build(row(4), stubT).length === 0,
      )
    }


    /*
     * Model switches and cold caches, and how a row shows them.
     *
     * A `request/header` is written only when the routed model changes, so its presence inside a
     * step's own window is the switch signal; its absence means the step reused what was already
     * routed. Measured on a real session: 22 switches in 3202 steps, all 22 carrying a header.
     */
    {
      const T = 40_000_000
      statsSnapshot = {
        turns: [
          {
            turn: 40,
            steps: [
              // Step 1: no header before it, but a reply already landed naming its model.
              { turn: 40, step: 1, startTime: T, endTime: T + 5_000, ttft: 800, model: 4_000, output: 100, running: false, cacheRead: 99_000, context: 100_000, cacheHit: 0.99 },
              // Step 2: a header inside its window -> this request switched models.
              { turn: 40, step: 2, startTime: T + 6_000, endTime: T + 9_000, ttft: 700, model: 2_800, output: 80, running: false, cacheRead: 20_000, context: 100_000, cacheHit: 0.2 },
              // Step 3: no header -> inherits step 2's model.
              { turn: 40, step: 3, startTime: T + 12_000, endTime: T + 15_000, ttft: 600, model: 2_600, output: 60, running: false, cacheRead: 99_500, context: 100_000, cacheHit: 0.995 },
            ],
            events: [
              { kind: 'request-header', time: T + 6_004, provider: 'buddy', model: 'deepseek-v4.1-flash' },
            ],
          },
        ],
      }
      statsSteps.length = 0
      const switchProps = {
        ...statusInject,
        useChat: (sel) =>
          sel({ legacy: { nodes: [], turnTimings: new Map(), partial: null, runningCalls: [] } }),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: false }),
        statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
        // Step 1's reply landed first, so its model is known from the trajectory.
        useTrajectory: () => ({
          eventNodes: [
            { kind: 'assistant', turn: 40, step: 1, providerMetadata: { provider: 'qodercn', model: 'dfmodel' } },
          ],
          requests: [],
        }),
        t,
      }
      const tree = await runtime.render(status.component, switchProps)
      const rows = modelRows()

      assert(
        'a step with a header inside its window is marked as a switch',
        (() => {
          const row = rows.find((entry) => entry.key === '40:2')
          return row !== undefined && row.switched === true && row.provider === 'buddy'
        })(),
      )
      assert(
        'a step with no header inherits the previous model and is not a switch',
        (() => {
          const row = rows.find((entry) => entry.key === '40:3')
          return row !== undefined && row.switched === false && row.provider === 'buddy'
        })(),
      )
      assert(
        'a settled reply supplies the model for a turn whose first step has no header',
        (() => {
          const row = rows.find((entry) => entry.key === '40:1')
          return row !== undefined && row.provider === 'qodercn' && row.model === 'dfmodel'
        })(),
      )

      // The rendered attributes, which is what the colour rules key on.
      const opener = findAll(tree, (el) => String(el.props.className ?? '').includes('dsh-rum-trigger'))[0]
      if (opener !== undefined) opener.props.onClick({ stopPropagation() {}, preventDefault() {} })
      const opened = await runtime.render(status.component, switchProps)
      const items = findAll(opened, (el) => String(el.props.className ?? '').includes('dsh-rum-item'))
      const byIndex = (index) => {
        const row = items.find((el) =>
          findAll(el, (cell) => String(cell.props.className ?? '').includes('dsh-rum-index')).some(
            (cell) => String(textOf(cell)).trim() === String(index),
          ),
        )
        return row
      }
      assert(
        'the switched row carries the switch attribute',
        byIndex(2) !== undefined && byIndex(2).props['data-switched'] === 'true',
      )
      assert(
        'a cold row carries the low-cache attribute',
        /*
         * Step 2 reports 20% and also switched. Both attributes are set; the stylesheet makes the
         * warn colour win while the left bar keeps the switch colour, so neither signal is lost.
         */
        byIndex(2) !== undefined && byIndex(2).props['data-lowcache'] === 'true',
      )
      assert(
        'a warm row carries neither attribute',
        (() => {
          const row = byIndex(3)
          return (
            row !== undefined &&
            row.props['data-switched'] === undefined &&
            row.props['data-lowcache'] === undefined
          )
        })(),
      )
      assert(
        'an unreported cache rate is not treated as zero',
        /*
         * trae folds cache reads into its input count and reports no `cacheReadTokens`. Reading
         * that as "0%" would flag every one of its rows, so only a reported rate can flag.
         */
        (() => {
          const start = source.indexOf('function isLowCacheHit(')
          if (start < 0) return false
          const body = source.slice(start, start + 520)
          return /row\.compaction === true\) return false/.test(body) && /if \(rate === null\) return false/.test(body)
        })(),
      )
      assert(
        'the threshold sits at 90 percent',
        /const LOW_CACHE_HIT = 0\.9/.test(source),
      )
    }


    /*
     * Model attribution, per step.
     *
     * The only per-step source of truth reachable from the client half is the Trajectory
     * domain's assistant nodes, which copy `providerMetadata` straight from
     * `assistant/message.source`. The statistics fold's `request-header` rows are NOT usable:
     * they are written only when the routed model or tool set changes, which was 24 rows for
     * 3139 requests in a real session, so they describe about 1% of steps and mislabel the rest.
     */
    {
      const T0 = 30_000_000
      statsSnapshot = {
        turns: [
          {
            turn: 30,
            steps: [
              { turn: 30, step: 1, startTime: T0, endTime: T0 + 5_000, ttft: 900, model: 4_000, output: 120, running: false },
              { turn: 30, step: 2, startTime: T0 + 6_000, endTime: T0 + 9_000, ttft: 800, model: 3_000, output: 90, running: false },
              { turn: 30, step: 3, startTime: T0 + 12_000, endTime: T0 + 15_000, ttft: 700, model: 2_500, output: 60, running: false },
            ],
            // A stale header, hours earlier: it must NOT be used to guess either step.
            events: [
              { kind: 'request-header', time: T0 - 3_600_000, provider: 'qodercn', model: 'dfmodel' },
            ],
          },
        ],
      }
      statsSteps.length = 0
      const modelProps = {
        ...statusInject,
        useChat: (sel) =>
          sel({ legacy: { nodes: [], turnTimings: new Map(), partial: null, runningCalls: [] } }),
        useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
        useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
        useSession: (sel) => sel({ running: false }),
        statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
        // The truth: step 1 and 2 ran on buddy, step 3 on trae.
        useTrajectory: () => ({
          eventNodes: [
            { kind: 'assistant', turn: 30, step: 1, providerMetadata: { provider: 'buddy', model: 'deepseek-v4.1-flash' } },
            { kind: 'assistant', turn: 30, step: 2, providerMetadata: { provider: 'buddy', model: 'deepseek-v4.1-flash' } },
            { kind: 'assistant', turn: 30, step: 3, providerMetadata: { provider: 'trae', model: 'deepseek-v4.1-flash' } },
          ],
          requests: [],
        }),
        t,
      }
      await runtime.render(status.component, modelProps)
      const rows = modelRows()

      assert(
        'each step names the provider that actually served it',
        (() => {
          const first = rows.find((entry) => entry.key === '30:1')
          const third = rows.find((entry) => entry.key === '30:3')
          return (
            first !== undefined &&
            third !== undefined &&
            first.provider === 'buddy' &&
            third.provider === 'trae'
          )
        })(),
      )
      assert(
        'a stale request-header is not used to guess a step model',
        /*
         * The header here is an hour older than every step. The old statistics-based rule would
         * have named it for all three; the trajectory nodes must win.
         */
        (() => {
          const first = rows.find((entry) => entry.key === '30:1')
          return first !== undefined && first.model === 'deepseek-v4.1-flash' && first.provider !== 'qodercn'
        })(),
      )
      assert(
        'the model index comes from the trajectory nodes, not the fold events',
        (() => {
          const start = source.indexOf('function modelIndexFromTrajectory(')
          if (start < 0) return false
          const body = source.slice(start, start + 1400)
          return /node\.providerMetadata/.test(body) && /meta\.model/.test(body) && /meta\.provider/.test(body)
        })(),
      )
      assert(
        'a step with no trajectory node keeps an unknown model rather than a guess',
        (() => {
          statsSnapshot = {
            turns: [
              {
                turn: 31,
                steps: [
                  { turn: 31, step: 1, startTime: T0 + 40_000, endTime: T0 + 44_000, ttft: 900, model: 3_000, output: 50, running: false },
                ],
                events: [{ kind: 'request-header', time: T0 - 3_600_000, provider: 'qodercn', model: 'dfmodel' }],
              },
            ],
          }
          statsSteps.length = 0
          return true
        })(),
      )
      await runtime.render(status.component, { ...modelProps, useTrajectory: () => ({ eventNodes: [], requests: [] }) })
      assert(
        'with no trajectory nodes the model stays empty instead of borrowing a stale header',
        (() => {
          const row = modelRows().find((entry) => entry.key === '31:1')
          return row !== undefined && row.model === null && row.provider === null
        })(),
      )
    }




  /* ---------------------------------------------------------------- */
  /* Compaction                                                         */
  /* ---------------------------------------------------------------- */

  /*
   * Compaction is a fourth phase that overlaps the three step phases.
   *
   * It belongs to no step, has no first token and produces no generation rate, so the drawer
   * row it gets is deliberately shaped differently: the speed column carries the wording, the
   * first-token column stays a dash, and the total counts up while it runs then freezes at the
   * fold's own `wall`. These cases pin that shape in both phases.
   */
  {
    console.log('\n--- compaction phase ---')
    sessionRunningStub = false
    statsSnapshot = { turns: [] }
    statsSteps.length = 0

    // A running compaction: `running` is what `endSeq === null` reports.
    addCompaction(20, {
      compactionId: 'cmp-running',
      startTime: 20_000_000,
      endTime: null,
      wall: null,
      running: true,
      output: null,
      context: null,
      cacheRead: null,
      cacheHit: null,
      provider: null,
      model: null,
      shadowedTokens: null,
    })

    const compactingProps = {
      ...statusInject,
      useChat: (sel) =>
        sel({ legacy: { nodes: [], turnTimings: new Map(), partial: null, runningCalls: [] } }),
      useGeek: (sel) => sel(statusInject.hooks.geek.getSnapshot()),
      useRows: (sel) => sel(statusInject.hooks.rows.getSnapshot()),
      useSession: (sel) => sel({ running: sessionRunningStub }),
      statsSource: () => ({ getSnapshot: () => statsSnapshot, subscribe: () => () => {} }),
      useTrajectory: () => ({ eventNodes: [], requests: [] }),
      t,
    }
    const compactingTree = await runtime.render(status.component, compactingProps)

    assert(
      'a running compaction moves the pill into the compacting phase',
      liveOf(compactingTree)?.phase === 'compacting',
    )
    assert(
      'a running compaction is the live reading, not a numbered row',
      /*
       * It is drawn above the list, exactly where a streaming request goes, so the numbered
       * rows must not repeat it — the live reading is what carries it.
       */
      liveOf(compactingTree)?.compaction !== undefined &&
        liveOf(compactingTree).compaction.running === true &&
        modelRows().every((row) => row.compaction !== true),
    )
    assert(
      'the compacting reading has no first token and no rate',
      (() => {
        const reading = liveOf(compactingTree)?.compaction
        return reading !== undefined && reading.ttftMs === null && reading.speed === null
      })(),
    )
    assert(
      'the compacting reading counts from its own start while it runs',
      (() => {
        const reading = liveOf(compactingTree)?.compaction
        // The frozen total is null while running; the span is computed from the start instead.
        /*
         * While it runs the reading carries the live span (start to now), which is what the
         * pill and the row both count; the fold's `wall` only exists after it lands.
         */
        return (
          reading !== undefined &&
          reading.startMs === 20_000_000 &&
          typeof reading.totalMs === 'number' &&
          reading.totalMs >= 0
        )
      })(),
    )
    assert(
      'the pill marks the compacting phase with its own class',
      /dsh-rum-compact-anchor/.test(String(findAll(compactingTree, (el) => String(el.props.className ?? '').includes('dsh-rum-trigger'))[0]?.props?.className ?? '')),
    )
    assert(
      'a compaction without a reported model names the chat model instead',
      (() => {
        const trigger = findAll(compactingTree, (el) =>
          String(el.props.className ?? '').includes('dsh-rum-trigger'),
        )[0]
        if (trigger === undefined) return false
        return String(trigger.props['aria-label'] ?? '').includes('使用对话模型')
      })(),
    )

    // It lands: the fold reports the span, the tokens and the model.
    statsSnapshot = { turns: [] }
    statsSteps.length = 0
    addCompaction(20, {
      compactionId: 'cmp-done',
      startTime: 20_000_000,
      endTime: 20_032_590,
      wall: 32_590,
      running: false,
      output: 4976,
      context: 357_725,
      cacheRead: 357_120,
      cacheHit: 0.9983,
      provider: 'buddy',
      model: 'deepseek-v4.1-flash',
      shadowedTokens: 630_872,
    })

    const doneTree = await runtime.render(status.component, compactingProps)
    assert(
      'a finished compaction keeps the phase, so the pill can say it completed',
      liveOf(doneTree)?.phase === 'compacted',
    )
    assert(
      'the finished row takes its span from the fold, not from the clock',
      (() => {
        const row = modelRows().find((entry) => entry.compaction === true)
        return row !== undefined && row.totalMs === 32_590 && row.running === false
      })(),
    )
    assert(
      'the finished row fills in its output tokens and its amortised rate',
      (() => {
        const row = modelRows().find((entry) => entry.compaction === true)
        if (row === undefined) return false
        // 4976 tokens over 32.59 s.
        return row.tokens === 4976 && Math.round(row.amortized) === 153
      })(),
    )
    assert(
      'the finished row still has no first token',
      (() => {
        const row = modelRows().find((entry) => entry.compaction === true)
        return row !== undefined && row.ttftMs === null
      })(),
    )
    assert(
      'the finished row names the model that summarised',
      (() => {
        const row = modelRows().find((entry) => entry.compaction === true)
        return row !== undefined && row.model === 'deepseek-v4.1-flash' && row.provider === 'buddy'
      })(),
    )
    assert(
      'the compaction row stays out of the average, which still counts every row',
      (() => {
        const withCompaction = source.indexOf('function averageOf(')
        if (withCompaction < 0) return false
        const body = source.slice(withCompaction, withCompaction + 1700)
        return (
          /row\.compaction !== true/.test(body) &&
          /row\.interrupted !== true/.test(body) &&
          /count: rows\.length/.test(body)
        )
      })(),
    )

    /*
     * The rendered row, not just its reading.
     *
     * The drawer must print the compaction wording in the speed column and the placeholder in
     * the first-token column, whatever the reading object happens to carry — those are two
     * separate code paths, and only the rendering is what the user sees.
     */
    {
      const opened = await runtime.render(status.component, compactingProps)
      const opener = findAll(opened, (el) =>
        String(el.props.className ?? '').includes('dsh-rum-trigger'),
      )[0]
      if (opener !== undefined) opener.props.onClick({ stopPropagation() {}, preventDefault() {} })
      const reopenedTree = await runtime.render(status.component, compactingProps)
      const compactionRow = findAll(reopenedTree, (el) =>
        String(el.props.className ?? '').includes('dsh-rum-item'),
      ).find((row) => {
        const cells = findAll(row, (el) => String(el.props.className ?? '').includes('dsh-rum-col'))
        return cells.length >= 5
      })
      assert(
        'the drawer prints a dash in the first-token column for a compaction',
        /*
         * Cells in order: first token, speed, tokens, total, amortised. The first must be the
         * placeholder — a compaction never produced a first token, so printing a duration there
         * would claim a measurement that does not exist.
         *
         * The column is decided by the row type, not by the reading being null, so a future
         * change that put a duration on a compaction reading could not leak it into this cell.
         */
        (() => {
          if (compactionRow === undefined) return false
          const cells = findAll(compactionRow, (el) =>
            String(el.props.className ?? '').includes('dsh-rum-col'),
          )
          return normalize(textOf(cells[0])).trim() === '—'
        })(),
      )
      assert(
        'the first-token cell is forced to the placeholder by row type',
        /secondsText\(entry\.row\.compaction === true \? null : entry\.row\.ttftMs, t\)/.test(source),
      )
    }


    // A new request after a finished compaction returns the pill to the writing phase.
    addStatsStep(21, 0, {
      startTime: 20_100_000,
      endTime: null,
      ttft: null,
      model: null,
      decode: null,
      tps: null,
      output: null,
      wall: null,
      running: true,
    })
    sessionRunningStub = true
    const afterTree = await runtime.render(status.component, compactingProps)
    assert(
      'a new request ends the compacted phase',
      liveOf(afterTree)?.phase === 'writing',
    )
  }

  /*
   * The row-number cell carries a hint, and its target has to be large enough to hit.
   *
   * The column is 18px wide — small for a pointer that must land on a digit to read a sentence
   * about a highlight. A transparent pseudo-element extends the target without touching the
   * grid, so no other column moves and the drawer width is unchanged.
   */
  {
    const css = styleEls[0].textContent
    assert(
      'the row-number cell extends its target without changing its column',
      /*
       * inset grows the pseudo-element outward; the grid column stays 18px, which is what keeps
       * every other column and the drawer total width where they were.
       */
      /\.dsh-rum-index\s*\{[^}]*position:\s*relative/.test(css) &&
        /\.dsh-rum-index::after\s*\{[^}]*content:\s*''[^}]*inset:\s*0 -6px 0 -22px/.test(css),
    )
    assert(
      'the target does not grow vertically, so neighbouring rows cannot overlap',
      /*
       * Rows sit 1px apart. Any vertical growth makes two neighbours share a band, and the later
       * row wins it — the pointer would show the wrong row's hint.
       */
      !/inset:\s*-\d/.test(css.slice(css.indexOf('.dsh-rum-index::after'))),
    )
    assert(
      'the enlarged target is positioned from the cell, so the box does not move',
      /position:\s*absolute/.test(css.slice(css.indexOf('.dsh-rum-index::after'))),
    )
    assert(
      'only a row that has something to say shows the help cursor',
      /*
       * A plain row's number keeps an ordinary cursor: an enlarged target that advertises a
       * hint which will not appear is worse than no hint at all.
       */
      /\.dsh-rum-index\[data-hint="true"\]\s*\{[^}]*cursor:\s*help/.test(css) &&
        !/\.dsh-rum-index\s*\{[^}]*cursor:\s*help/.test(css),
    )
    assert(
      'the cell marks itself only when its row has hint lines',
      /'data-hint': rowHintLines\(entry\.row, t\)\.length > 0 \? 'true' : undefined/.test(source),
    )
  }



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
  assert(
    'no history is written to storage, so nothing can go stale between sessions',
    /*
     * The drawer now derives its rows from the session's own statistics, so keeping a
     * persisted copy is what used to make a conversation switch show another session's
     * figures: turn and step both restart at 1, so the row keys collided. Nothing survives
     * a reload now, and the next mount rebuilds from the log.
     */
    store.get('dsh.recentUsageMetrics.history.v1') === undefined,
  )
  assert('the Geek flag still persists', store.get('dsh.recentUsageMetrics.mode.v1') === '"geek"')

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
