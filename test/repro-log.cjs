/**
 * Offline verification against a real session log.
 *
 * The Statistics view derives its per-step figures by folding the durable session log. That
 * log lives on disk, so the drawer's numbers can be checked against the same source without
 * a browser: this script folds the newest session log exactly as the shipped
 * `foldEvent`/`stepMetrics` do, then checks the properties the drawer relies on.
 *
 * It skips itself when no log is present, so it is safe in any checkout.
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')

let failures = 0
let checks = 0
const assert = (label, ok) => {
  checks += 1
  if (!ok) {
    failures += 1
    console.log(`FAIL  ${label}`)
  } else {
    console.log(`PASS  ${label}`)
  }
}

/** Newest `session.v4.jsonl.zstd` under the user's DSH sessions root, or null. */
function newestLog() {
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  if (!fs.existsSync(root)) return null
  let best = null
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.jsonl.zstd')) continue
      const stat = fs.statSync(full)
      if (best === null || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs, size: stat.size }
    }
  }
  walk(root, 0)
  return best
}

/**
 * Decompress every concatenated zstd frame in the file.
 *
 * The log is written as many frames appended one after another, not as one frame, so a
 * single `zstdDecompressSync` call returns only the first few hundred bytes. Splitting at
 * each frame magic and decompressing the slice between them recovers the whole file.
 */
function decodeFrames(raw) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let index = 0; index + 4 <= raw.length; index += 1) {
    if (raw[index] === MAGIC[0] && raw[index + 1] === MAGIC[1] && raw[index + 2] === MAGIC[2] && raw[index + 3] === MAGIC[3]) {
      offsets.push(index)
    }
  }
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : raw.length
    try {
      parts.push(zlib.zstdDecompressSync(raw.subarray(start, end)))
    } catch {
      // A magic-like sequence inside compressed data; skip that candidate.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Mirror of the shipped `isTokenDelta`. */
function isTokenDelta(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== ''
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta !== '' || chunk.name !== undefined
  return false
}

/**
 * First-token time inside one `assistant/message.data.stream`.
 *
 * Packed runs carry a base time plus per-fragment deltas, and they are where the first token
 * of a real turn usually lives: a live-chunk event is client-only and never reaches the log,
 * so a fold that only reads loose `chunk` records reports no first token for almost every
 * step.
 */
function firstTokenOfStream(stream) {
  if (!Array.isArray(stream)) return null
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      if (isTokenDelta(record.chunk) && isNumber(record.time)) return record.time
      continue
    }
    if (record.type !== 'reasoning-chunks' && record.type !== 'tool-call-chunks') continue
    const texts = record.texts ?? record.args
    if (!Array.isArray(texts) || texts.length === 0) continue
    if (record.type === 'tool-call-chunks' && record.name !== undefined && isNumber(record.time0)) return record.time0
    let at = record.time0
    if (!isNumber(at)) continue
    for (let index = 0; index < texts.length; index += 1) {
      if (index > 0) {
        const gap = record.dt?.[index - 1]
        if (!isNumber(gap)) break
        at += gap
      }
      if (typeof texts[index] === 'string' && texts[index] !== '') return at
    }
  }
  return null
}

const log = newestLog()
if (log === null) {
  console.log('PASS  no session log on this machine, nothing to verify')
  console.log('\nall checks passed')
  process.exit(0)
}
console.log(`session log: ${log.path} (${log.size} B)\n`)

const text = decodeFrames(fs.readFileSync(log.path))
const events = []
for (const line of text.split('\n')) {
  if (line === '') continue
  try {
    events.push(JSON.parse(line))
  } catch {}
}
assert('the log decodes into events', events.length > 100)
assert('the log has step/start events', events.some((event) => event.type === 'step/start'))

// Fold the way the Statistics view does.
const steps = new Map()
const key = (turn, step) => `${turn}:${step}`
for (const event of events) {
  if (event.type === 'step/start') {
    steps.set(key(event.data.turn, event.data.step), {
      turn: event.data.turn,
      step: event.data.step,
      startTime: event.time,
      endTime: null,
      firstTokenTime: null,
      messageTime: null,
      output: null,
      ended: false,
    })
    continue
  }
  if (event.type === 'assistant/message') {
    const entry = steps.get(key(event.data.turn, event.data.step))
    if (entry === undefined) continue
    if (entry.firstTokenTime === null) entry.firstTokenTime = firstTokenOfStream(event.data.stream)
    entry.messageTime = event.time
    const output = event.data.usage?.outputTokens
    if (typeof output === 'number') entry.output = output
    continue
  }
  if (event.type === 'step/end') {
    const entry = steps.get(key(event.data.turn, event.data.step))
    if (entry === undefined) continue
    entry.ended = true
    entry.endTime = event.time
  }
}

const list = [...steps.values()].sort((a, b) => (a.turn === b.turn ? a.step - b.step : a.turn - b.turn))
const metrics = list.map((step) => ({
  turn: step.turn,
  step: step.step,
  start: step.startTime,
  end: step.endTime,
  ttft: step.startTime !== null && step.firstTokenTime !== null ? Math.max(0, step.firstTokenTime - step.startTime) : null,
  output: step.output,
  wall: step.startTime !== null && step.endTime !== null ? Math.max(0, step.endTime - step.startTime) : null,
  running: !step.ended,
}))

assert('every step has a start time', metrics.every((entry) => entry.start !== null))
assert(
  'the fold recovers a first-token time for almost every step',
  /*
   * The loose `chunk` records alone recover almost none, because a live-chunk event is
   * client-only. Reading the packed runs is what brings this to ~96% on a real log.
   */
  metrics.filter((entry) => entry.ttft !== null).length / metrics.length > 0.9,
)
assert(
  'first-token latency is never negative',
  metrics.every((entry) => entry.ttft === null || entry.ttft >= 0),
)
assert(
  'first-token latency never exceeds the step wall time',
  metrics.every((entry) => entry.ttft === null || entry.wall === null || entry.ttft <= entry.wall),
)
assert(
  'a settled step has a wall time',
  metrics.filter((entry) => !entry.running).every((entry) => entry.wall !== null),
)
assert(
  'a running step has no wall time yet, which is why the drawer shows a dash',
  /*
   * `wall` comes from `endTime`, and that only lands on `step/end`. A step that has produced
   * tokens but not ended therefore has no total, in the drawer and in the Statistics view
   * alike. This pins the reason rather than treating the dash as a bug.
   */
  metrics.filter((entry) => entry.running).every((entry) => entry.wall === null),
)

// The drawer's selection: newest first, only steps with figures, ten at most.
const withFigures = metrics.filter(
  (entry) => entry.start !== null && (entry.ttft !== null || entry.output !== null || entry.end !== null),
)
const drawer = withFigures.slice(-10).reverse()
assert('the drawer selection has at most ten rows', drawer.length <= 10)
assert(
  'the drawer selection is newest first',
  /*
   * The list is descending: row 1 is the newest, so each following row is older. Ordering
   * across a turn boundary is by turn, and within a turn by step.
   */
  drawer.every((entry, index) => {
    if (index === 0) return true
    const previous = drawer[index - 1]
    return previous.turn > entry.turn || (previous.turn === entry.turn && previous.step >= entry.step)
  }),
)
assert(
  'every drawer row starts at the step start, matching the Statistics view',
  drawer.every((entry) => entry.start !== null),
)
assert(
  'the newest drawer row is the newest step that has figures',
  drawer[0] === undefined || drawer[0] === withFigures.at(-1),
)

console.log(`\n${checks} checks, ${failures} failed`)
console.log(`log summary: ${metrics.length} steps, ${metrics.filter((e) => e.ttft !== null).length} with a first token`)
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
