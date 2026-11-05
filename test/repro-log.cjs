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
 * Mirrors the shipped `assistantStreamFirstTokenTime` from dsh-llm exactly, because a
 * near-miss here produces false mismatches: a packed run must find its first NON-EMPTY
 * fragment and reconstruct that fragment's time from `time0` plus the cumulative `dt`
 * offsets, while a tool-call run that begins with a name is dated at `time0` directly.
 * Reading `time0` for every packed run instead lands on the run's first slot, which is often
 * an empty fragment, and the figure drifts by a few hundred milliseconds.
 *
 * Packed runs matter at all because a live-chunk event is client-only and never reaches the
 * log: without them a fold reports no first token for almost every step.
 */
function firstTokenOfStream(stream) {
  if (!Array.isArray(stream)) return null
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

  /** The shipped `firstRunMemberTime`: walk the fragments, accumulating `dt`. */
  const firstRunMember = (run, accept) => {
    // The shipped helper picks the field by TYPE, not by whichever is present: a tool-call
    // run stores its fragments in `args`, every other packed run in `texts`. Reading
    // `texts ?? args` picks the wrong array when both exist and shifts the result.
    const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts
    if (!Array.isArray(fragments)) return null
    let at = run.time0
    if (!isNumber(at)) return null
    for (let index = 0; index < fragments.length; index += 1) {
      if (index > 0) {
        const gap = run.dt?.[index - 1]
        if (!isNumber(gap)) return null
        at += gap
      }
      if (accept(fragments[index])) return at
    }
    return null
  }

  /** The shipped `runFirstTokenTime`. */
  const runFirstToken = (run) => {
    if (run.type === 'tool-call-chunks' && run.name !== undefined) {
      return isNumber(run.time0) ? run.time0 : null
    }
    return firstRunMember(run, (fragment) => fragment !== '')
  }

  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      if (isTokenDelta(record.chunk) && isNumber(record.time)) return record.time
      continue
    }
    /*
     * Every packed delta run, not just the two obvious ones. `text-chunks` is the MOST
     * common and the one that carries the first token of a normal turn: skipping it made the
     * fold fall through to the tool-call run further down the stream and report a latency
     * several hundred milliseconds too large.
     */
    if (record.type !== 'text-chunks' && record.type !== 'reasoning-chunks' && record.type !== 'tool-call-chunks') continue
    const time = runFirstToken(record)
    if (time !== null) return time
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

/** `HH:MM:SS`, the form the drawer's clock column prints. */
const clock = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/*
 * If a live report from the running page is present, compare it against this fold.
 *
 * The report is written by the plugin's temporary diagnostic beacon. Running this check is
 * how the drawer was confirmed to agree with the Statistics view step for step; it is
 * skipped when no report exists, so the suite stays runnable on a clean machine.
 */
const reportPath = path.join(__dirname, '..', '.rum-report.json')
if (fs.existsSync(reportPath)) {
  let report = null
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  } catch {
    report = null
  }
  if (report !== null && report.latest !== undefined && report.latest !== null) {
    const latest = report.latest
    const sameLog = typeof latest.sessionId === 'string' && log.path.includes(latest.sessionId)
    if (!sameLog) {
      console.log('\n(skipped the live comparison: the report is for another session)')
    } else {
      console.log('\nlive comparison against the report:')
      const byKey = new Map()
      for (const entry of metrics) byKey.set(`${entry.turn}:${entry.step}`, entry)
      let compared = 0
      let agreed = 0
      for (const row of latest.rows ?? []) {
        const fromLog = byKey.get(row.key)
        if (fromLog === undefined) continue
        compared += 1
        const same =
          row.atClock === clock(fromLog.start) &&
          row.ttftMs === fromLog.ttft &&
          row.tokens === fromLog.output &&
          row.totalMs === fromLog.wall
        if (same) agreed += 1
        else console.log(`  DIFF  ${row.key}: drawer ${row.atClock}/${row.ttftMs}/${row.tokens}/${row.totalMs} vs log ${clock(fromLog.start)}/${fromLog.ttft}/${fromLog.output}/${fromLog.wall}`)
      }
      assert('every reported row matches the log exactly', compared > 0 && agreed === compared)
      assert('the report carries a full page of ten rows', (latest.rows ?? []).length === 10)
    }
  }
}

console.log(`\n${checks} checks, ${failures} failed`)
console.log(`log summary: ${metrics.length} steps, ${metrics.filter((e) => e.ttft !== null).length} with a first token`)
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
