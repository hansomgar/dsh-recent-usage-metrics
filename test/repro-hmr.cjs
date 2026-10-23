// Does the dictionary claim survive an HMR reload without throwing or orphaning?
//
// On a hot reload the module scope resets while the OLD claim can still be live in the
// locale service. A second `register` for the same namespace throws ("already has a
// claim"), which would leave the UI dictionary-less — the same visible symptom as the
// cold-start bug. The plugin parks the disposer on globalThis so a new generation can
// release the previous claim first.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'client.js'), 'utf8')
const failed = []
const check = (label, ok, detail) => {
  if (!ok) failed.push(label)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

const claims = new Map()
const localeService = {
  register(ns) {
    if (claims.has(ns)) throw new Error(`namespace "${ns}" already has a claim`)
    claims.set(ns, {})
    return () => claims.delete(ns)
  },
  bind: () => (key) => key,
  getSnapshot: () => ({ active: 'zh' }),
  subscribe: () => () => {},
}

// One shared globalThis across both generations, like a real HMR reload.
const host = {}
function loadGeneration() {
  const mods = []
  const sandbox = {
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { head: { append() {} }, createElement: () => ({ textContent: '', remove() {} }) },
    __ModuleLoader__: { load: (m) => mods.push(m) },
  }
  sandbox.window = sandbox
  sandbox.globalThis = host
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const noop = () => {}
  const React = {
    createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat() }),
    useState: (i) => [typeof i === 'function' ? i() : i, noop],
    useRef: (v) => ({ current: v }),
    useEffect: noop,
    useLayoutEffect: noop,
    useMemo: (f) => f(),
    useCallback: (f) => f,
  }
  return mods[0].factory(() => React)
}

function makeCtx() {
  let stale = null
  return {
    effect(fn) {
      return fn()
    },
    get locale() {
      return localeService
    },
    get: () => undefined,
    inject: (names, cb) => cb({ configForms: { get: () => null } }),
    slots: { inject: (k, cb) => cb(), register: () => () => {} },
  }
}

const first = loadGeneration()
first.apply(makeCtx())
check('the first generation claims the namespace', claims.has('dsh-recent-usage-metrics'))

// A second generation applies while the first claim is still live.
let threw = null
try {
  const second = loadGeneration()
  second.apply(makeCtx())
} catch (error) {
  threw = error
}
check('a reload does not throw on the existing claim', threw === null, threw === null ? 'ok' : String(threw))
check('exactly one live claim remains', claims.size === 1, String(claims.size))

// And the claim is released when the live generation is disposed.
const disposer = host['__dshRecentUsageMetricsLocale']
check('the live disposer is parked on globalThis', typeof disposer === 'function')
if (typeof disposer === 'function') disposer()
check('disposing releases the claim', !claims.has('dsh-recent-usage-metrics'))

console.log(failed.length === 0 ? '\nALL HMR CHECKS PASSED' : `\n${failed.length} CHECK(S) FAILED`)
if (failed.length) process.exitCode = 1
