// Cold-start regression test: after a DSH restart the plugin must paint Chinese and stay
// switchable both ways.
//
// The reported failure in the reference plugin: it declared only `inject: ['slots']`, so
// on a cold page it could apply before the locale service existed. `ctx.get('locale')`
// then returned undefined, the dictionaries were never registered, and the UI came up in
// English (or raw keys) with no way to switch back to Chinese.
//
// The contract asserted here:
//   1. `locale` is a hard dependency in `inject`.
//   2. `apply` reads `ctx.locale` and never probes `ctx.get('locale')`.
//   3. With the service live, the first paint is Chinese, and both switches work.
//   4. The slot registrations declare the locale namespace so their labels follow it.
//   5. A late `configForms` is picked up rather than latched to the fallback.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8')

const failed = []
const check = (label, ok, detail) => {
  if (!ok) failed.push(label)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

/* --- 1 & 2. the static contract -------------------------------------------- */

const mods = []
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: {
    head: { append() {} },
    createElement: () => ({ id: '', textContent: '', remove() {} }),
  },
  __ModuleLoader__: { load: (m) => mods.push(m) },
}
sandbox.window = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const noop = () => {}
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (init) => [typeof init === 'function' ? init() : init, noop],
  useRef: (v) => ({ current: v }),
  useEffect: noop,
  useLayoutEffect: noop,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
const exported = mods[0].factory(() => React)

check('declares locale as a hard dependency', exported.inject.includes('locale'), JSON.stringify(exported.inject))
check('still declares slots', exported.inject.includes('slots'), JSON.stringify(exported.inject))

const applyBody = (() => {
  const at = source.indexOf('function apply(ctx)')
  return source.slice(at, source.indexOf('\n    }', at))
})()
const applyCode = applyBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
check(
  'apply reads ctx.locale instead of probing ctx.get',
  applyCode.includes('ctx.locale') && !applyCode.includes("ctx.get('locale')"),
  applyCode.includes("ctx.get('locale')") ? 'still probes ctx.get' : 'ok',
)
check(
  'the dictionaries are registered unconditionally',
  // The old code guarded registration with `if (locale !== undefined)`, so a missing
  // service silently skipped it — the root of "stuck in English".
  /ctx\.effect\(\(\) => \{\s*releaseDictionaries\(\)/.test(applyCode),
)

/* --- 3. a live service: Chinese first, switchable both ways ---------------- */

const dicts = new Map()
const listeners = new Set()
let snapshot = Object.freeze({ active: 'zh', locales: [], revision: 0 })
const publish = (active) => {
  snapshot = Object.freeze({ active, locales: [], revision: snapshot.revision + 1 })
  for (const fn of [...listeners]) fn()
}
const service = {
  getSnapshot: () => snapshot,
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  setLocale(id) {
    if (snapshot.active !== id) publish(id)
  },
  register(ns, d) {
    if (dicts.has(ns)) throw new Error(`locale namespace "${ns}" already has a claim`)
    dicts.set(ns, new Map(Object.entries(d)))
    publish(snapshot.active)
    return () => {
      dicts.delete(ns)
      publish(snapshot.active)
    }
  },
  bind(ns) {
    return (key, params) => {
      const per = dicts.get(ns)
      const chain = snapshot.active === 'zh' ? ['zh', 'en'] : ['en']
      let template
      for (const l of chain) {
        const v = per?.get(l)?.[key]
        if (v !== undefined) {
          template = v
          break
        }
      }
      if (template === undefined) template = key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m))
    }
  },
}

let formValue = { performanceUsage: 'detailed' }
const formListeners = new Set()
const formStub = {
  getSnapshot: () => ({ value: formValue }),
  subscribe(fn) {
    formListeners.add(fn)
    return () => formListeners.delete(fn)
  },
  set(key, value) {
    formValue = { ...formValue, [key]: value }
    for (const fn of [...formListeners]) fn()
  },
}

const effects = []
const injected = []
const injectedServices = []
const registrations = new Map()

const ctx = {
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return dispose
  },
  get locale() {
    return service
  },
  get: () => undefined,
  inject(names, callback) {
    injectedServices.push(names.join(','))
    const scope = {}
    if (names.includes('configForms')) scope.configForms = { get: () => formStub }
    return callback(scope)
  },
  slots: {
    inject(key, cb) {
      injected.push(key)
      return cb()
    },
    register(options, component) {
      registrations.set(options.name, { options, component })
      return () => registrations.delete(options.name)
    },
  },
}

exported.apply(ctx)

check('namespace registered at apply time', dicts.has('dsh-recent-usage-metrics'), [...dicts.keys()].join(','))

const row = registrations.get('settings.general.item')
const dock = registrations.get('conversation.composer.dock')
check('both slots registered', row !== undefined && dock !== undefined)

const rowTitle = () => row.options.label()
check('first paint is Chinese', rowTitle() === '性能与用量', rowTitle())
check('the dock label is Chinese too', dock.options.label() === '最近请求指标', dock.options.label())

service.setLocale('en')
check('switches to English', rowTitle() === 'Performance & usage', rowTitle())
service.setLocale('zh')
check('switches back to Chinese', rowTitle() === '性能与用量', rowTitle())

check(
  'the registrations declare the locale namespace',
  row.options.locale === 'dsh-recent-usage-metrics' && dock.options.locale === row.options.locale,
  `${row.options.locale} / ${dock.options.locale}`,
)

/* --- 4. the t() binding resolves through the live dictionary --------------- */

const t = service.bind('dsh-recent-usage-metrics')
check('t() resolves a known key', t('colSpeed') === '速度', t('colSpeed'))
service.setLocale('en')
check('t() follows the switch', t('colSpeed') === 'Speed', t('colSpeed'))
service.setLocale('zh')

/* --- 5. a late configForms is adopted, not latched ------------------------ */

check('waits for configForms', injectedServices.includes('configForms'), injectedServices.join(' | '))

/*
 * The row's preference must come from the shipped Chat form. Assert the mirror reads it
 * rather than staying on the fallback: flipping the form's stored value has to surface
 * through the hook the row is given.
 */
const preferenceSource = row.options.inject().hooks.performanceUsage
check('the preference mirror reads the shipped form', preferenceSource.getSnapshot() === 'detailed', preferenceSource.getSnapshot())
formValue = { performanceUsage: 'compact' }
for (const fn of [...formListeners]) fn()
check('a change in the shipped form reaches the row', preferenceSource.getSnapshot() === 'compact', preferenceSource.getSnapshot())

service.setLocale('zh')
check('still Chinese at the end', rowTitle() === '性能与用量', rowTitle())

console.log(failed.length === 0 ? '\nALL COLD-START CHECKS PASSED' : `\n${failed.length} CHECK(S) FAILED`)
if (failed.length) process.exitCode = 1
