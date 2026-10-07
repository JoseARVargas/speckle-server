import type {
  DevicePowerState,
  HealthMetric,
  HealthSeverity,
  HealthTrend
} from '@/modules/facilities/helpers/types'
import type { Nullable } from '@speckle/shared'

/**
 * The simulated split AC as a pure function of time - no I/O, no timers.
 *
 * Only events (power, setpoint, fault profile, tariff) are persisted, each as
 * a segment holding the parameters valid from `startsAt` on plus the state at
 * that instant. Any reading is computed on demand from the segment active at
 * that moment, so nothing ticks while nobody is looking (see
 * speckle-digitaltwin-console/.ai/plans/2026-10-07-simulacao-sob-demanda.md).
 *
 * Readings live on a global grid (`ts = k * 15s` since the Unix epoch), so
 * every asset shares the same timestamps and facility series sum per tick.
 */

export const TICK_SECONDS = 15
const TICK_MS = TICK_SECONDS * 1000
// How fast the temperature converges toward its target - lower is faster.
// Tuned for a demo (minutes, not the ~15-20min a real split AC takes) rather
// than physical accuracy.
export const ON_TIME_CONSTANT_SECONDS = 5 * 60
export const OFF_TIME_CONSTANT_SECONDS = 12 * 60
const NOISE_DEGREES = 0.15
// Below this distance from the setpoint, the compressor is treated as
// cycling (low duty) rather than running flat out.
export const CYCLING_BAND_DEGREES = 1
const CYCLING_DUTY_MIN = 0.2
const CYCLING_DUTY_SPREAD = 0.15
// Energy accounting needs a closed form (a segment can last months), so the
// cycling phase is billed at the mean duty; only the displayed duty is noisy.
export const EXPECTED_CYCLING_DUTY = CYCLING_DUTY_MIN + CYCLING_DUTY_SPREAD / 2
// Single-phase line voltage assumed for deriving simulated amperage from
// simulated power draw - matches what a real PZEM-004T would be wired at.
const VOLTAGE_V = 220
// How long after power-on the compressor's inrush current spike decays back
// to its steady-state value.
const STARTUP_WINDOW_SECONDS = 45
// A healthy unit's starting current is roughly this multiple of its
// steady-state draw.
const STARTUP_PEAK_MULTIPLIER = 3
// A degraded unit (low refrigerant, dirty filter, ...) removes heat less
// effectively: convergence while running slows by up to this share.
const DEGRADATION_CONVERGENCE_LOSS = 0.85

export const DEFAULT_DEVICE_PARAMS = {
  powerState: 'off' as DevicePowerState,
  setpoint: 22,
  temperature: 28,
  ambientTemperature: 28,
  nominalPowerKw: 1.2,
  degradationRate: 0,
  startupCurrentDecay: 0,
  noiseAmplification: 1
}

export type SimulationSegment = {
  assetId: string
  projectId: string
  startsAt: Date
  powerState: DevicePowerState
  setpoint: number
  ambientTemperature: number
  nominalPowerKw: number
  /** Fault-injection knobs (0 = healthy) */
  degradationRate: number
  startupCurrentDecay: number
  noiseAmplification: number
  tariffPerKwh: number
  /** Noise-free temperature at startsAt */
  temperatureAtStart: number
  cumulativeKwhAtStart: number
  cumulativeCostAtStart: number
  /** When the unit was last turned on; null while off */
  poweredOnAt: Nullable<Date>
}

export type SimulatedReading = {
  ts: Date
  powerState: DevicePowerState
  temperature: number
  compressorDuty: number
  currentA: number
  powerKw: number
  energyKwhInterval: number
  cumulativeKwh: number
  costInterval: number
  cumulativeCost: number
}

// ---- deterministic noise ------------------------------------------------------

/** FNV-1a + a mulberry32 round: a stable value in [0, 1) per key. */
export const hash01 = (key: string): number => {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let t = (h + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Same reading for every viewer and every request: noise keyed by tick. */
const noise = (assetId: string, tick: number, channel: string) =>
  hash01(`${assetId}:${tick}:${channel}`) * 2 - 1

export const tickOf = (tMs: number) => Math.floor(tMs / TICK_MS)
export const tickTime = (tick: number) => tick * TICK_MS

// ---- one segment ------------------------------------------------------------------

const isOn = (seg: SimulationSegment) => seg.powerState === 'on'
const targetOf = (seg: SimulationSegment) =>
  isOn(seg) ? seg.setpoint : seg.ambientTemperature

/**
 * Share of the remaining distance to the target the temperature keeps after
 * one tick: the old discrete step `T += (target - T) * c` has the closed form
 * `T(n) = target + (T0 - target) * (1 - c)^n`.
 */
export const perTickRetention = (seg: SimulationSegment) => {
  const timeConstant = isOn(seg) ? ON_TIME_CONSTANT_SECONDS : OFF_TIME_CONSTANT_SECONDS
  const convergence =
    (1 - Math.exp(-TICK_SECONDS / timeConstant)) *
    (isOn(seg) ? 1 - seg.degradationRate * DEGRADATION_CONVERGENCE_LOSS : 1)
  return 1 - convergence
}

const elapsedSeconds = (seg: SimulationSegment, tMs: number) =>
  Math.max(0, (tMs - seg.startsAt.getTime()) / 1000)

/** Noise-free temperature at tMs (tMs >= startsAt). */
export const cleanTemperatureAt = (seg: SimulationSegment, tMs: number) => {
  const target = targetOf(seg)
  const ticks = elapsedSeconds(seg, tMs) / TICK_SECONDS
  return target + (seg.temperatureAtStart - target) * perTickRetention(seg) ** ticks
}

/**
 * Seconds after startsAt at which a running unit reaches the cycling band
 * (0 when it starts inside it).
 */
export const bandEntrySeconds = (seg: SimulationSegment) => {
  const distance = Math.abs(seg.temperatureAtStart - seg.setpoint)
  if (distance <= CYCLING_BAND_DEGREES) return 0
  const retention = perTickRetention(seg)
  if (retention <= 0) return 0
  return (
    (Math.log(CYCLING_BAND_DEGREES / distance) / Math.log(retention)) * TICK_SECONDS
  )
}

/** Accumulated kWh / cost at tMs, from the segment's starting totals. */
export const cumulativeAt = (seg: SimulationSegment, tMs: number) => {
  if (!isOn(seg)) {
    return { kwh: seg.cumulativeKwhAtStart, cost: seg.cumulativeCostAtStart }
  }
  const elapsed = elapsedSeconds(seg, tMs)
  const fullPower = Math.min(elapsed, bandEntrySeconds(seg))
  const cycling = elapsed - fullPower
  const kwh =
    (seg.nominalPowerKw * (fullPower + EXPECTED_CYCLING_DUTY * cycling)) / 3600
  return {
    kwh: seg.cumulativeKwhAtStart + kwh,
    cost: seg.cumulativeCostAtStart + kwh * seg.tariffPerKwh
  }
}

/** Displayed duty (noisy while cycling) at tMs. */
const compressorDutyAt = (seg: SimulationSegment, tMs: number) => {
  if (!isOn(seg)) return 0
  if (elapsedSeconds(seg, tMs) < bandEntrySeconds(seg)) return 1
  return (
    CYCLING_DUTY_MIN +
    CYCLING_DUTY_SPREAD * hash01(`${seg.assetId}:${tickOf(tMs)}:duty`)
  )
}

const currentAt = (seg: SimulationSegment, tMs: number, powerKw: number) => {
  if (!isOn(seg)) return 0
  const baseCurrentA = (powerKw * 1000) / VOLTAGE_V
  // Inrush current spike right after power-on, decaying linearly back to the
  // steady-state value - a worn starting capacitor (startupCurrentDecay)
  // shrinks how high that peak reaches.
  const secondsSincePowerOn = seg.poweredOnAt
    ? (tMs - seg.poweredOnAt.getTime()) / 1000
    : Infinity
  let startupMultiplier = 1
  if (secondsSincePowerOn >= 0 && secondsSincePowerOn < STARTUP_WINDOW_SECONDS) {
    const peak = 1 + (STARTUP_PEAK_MULTIPLIER - 1) * (1 - seg.startupCurrentDecay)
    startupMultiplier =
      peak - (peak - 1) * (secondsSincePowerOn / STARTUP_WINDOW_SECONDS)
  }
  // A degraded electrical contact shows up as noisier readings, not a shifted
  // mean - only the noise spread scales with noiseAmplification.
  return (
    baseCurrentA *
    startupMultiplier *
    (1 + 0.02 * seg.noiseAmplification * noise(seg.assetId, tickOf(tMs), 'current'))
  )
}

// ---- segment chains ----------------------------------------------------------------

/**
 * The segment active at tMs: the last one starting at or before it. Expects
 * `segments` sorted by startsAt (ties: insertion order). Null before the
 * first one - the asset had no simulated state yet.
 */
export const segmentAt = (
  segments: SimulationSegment[],
  tMs: number
): SimulationSegment | null => {
  let found: SimulationSegment | null = null
  for (const seg of segments) {
    if (seg.startsAt.getTime() <= tMs) found = seg
    else break
  }
  return found
}

const cumulativeOnChain = (segments: SimulationSegment[], tMs: number) => {
  const seg = segmentAt(segments, tMs)
  if (seg) return cumulativeAt(seg, tMs)
  const first = segments[0]
  return first
    ? { kwh: first.cumulativeKwhAtStart, cost: first.cumulativeCostAtStart }
    : { kwh: 0, cost: 0 }
}

/** One reading at tMs, or null before the asset's first segment. */
export const readingAt = (
  segments: SimulationSegment[],
  tMs: number
): SimulatedReading | null => {
  const seg = segmentAt(segments, tMs)
  if (!seg) return null
  const tick = tickOf(tMs)
  const compressorDuty = compressorDutyAt(seg, tMs)
  const powerKw = seg.nominalPowerKw * compressorDuty
  const now = cumulativeAt(seg, tMs)
  const before = cumulativeOnChain(segments, tMs - TICK_MS)
  return {
    ts: new Date(tMs),
    powerState: seg.powerState,
    temperature:
      cleanTemperatureAt(seg, tMs) + NOISE_DEGREES * noise(seg.assetId, tick, 'temp'),
    compressorDuty,
    currentA: currentAt(seg, tMs, powerKw),
    powerKw,
    energyKwhInterval: now.kwh - before.kwh,
    cumulativeKwh: now.kwh,
    costInterval: now.cost - before.cost,
    cumulativeCost: now.cost
  }
}

/**
 * Readings on the grid for the `count` ticks ending at the one containing
 * nowMs, oldest first; ticks before the first segment are skipped.
 */
export const readingsUntil = (
  segments: SimulationSegment[],
  nowMs: number,
  count: number
): SimulatedReading[] => {
  const readings: SimulatedReading[] = []
  const last = tickOf(nowMs)
  for (let tick = last - count + 1; tick <= last; tick++) {
    const reading = readingAt(segments, tickTime(tick))
    if (reading) readings.push(reading)
  }
  return readings
}

/** Earliest instant a window of `count` readings ending at nowMs reaches. */
export const windowStartMs = (nowMs: number, count: number) =>
  tickTime(tickOf(nowMs) - count) // one extra tick for the first interval

/**
 * The segment an event opens at tMs: the previous parameters with `changes`
 * applied, starting from the state reached at that instant (so the
 * trajectory stays continuous).
 */
export const nextSegment = (params: {
  previous: SimulationSegment | null
  assetId: string
  projectId: string
  tMs: number
  defaultTariffPerKwh: number
  changes: Partial<
    Pick<
      SimulationSegment,
      | 'powerState'
      | 'setpoint'
      | 'degradationRate'
      | 'startupCurrentDecay'
      | 'noiseAmplification'
      | 'tariffPerKwh'
    >
  >
}): SimulationSegment => {
  const { previous, changes } = params
  // Never before the segment it follows (two events in the same ms)
  const tMs = previous ? Math.max(params.tMs, previous.startsAt.getTime()) : params.tMs
  const base: SimulationSegment = previous
    ? {
        ...previous,
        temperatureAtStart: cleanTemperatureAt(previous, tMs),
        cumulativeKwhAtStart: cumulativeAt(previous, tMs).kwh,
        cumulativeCostAtStart: cumulativeAt(previous, tMs).cost
      }
    : {
        assetId: params.assetId,
        projectId: params.projectId,
        startsAt: new Date(tMs),
        powerState: DEFAULT_DEVICE_PARAMS.powerState,
        setpoint: DEFAULT_DEVICE_PARAMS.setpoint,
        ambientTemperature: DEFAULT_DEVICE_PARAMS.ambientTemperature,
        nominalPowerKw: DEFAULT_DEVICE_PARAMS.nominalPowerKw,
        degradationRate: DEFAULT_DEVICE_PARAMS.degradationRate,
        startupCurrentDecay: DEFAULT_DEVICE_PARAMS.startupCurrentDecay,
        noiseAmplification: DEFAULT_DEVICE_PARAMS.noiseAmplification,
        tariffPerKwh: params.defaultTariffPerKwh,
        temperatureAtStart: DEFAULT_DEVICE_PARAMS.temperature,
        cumulativeKwhAtStart: 0,
        cumulativeCostAtStart: 0,
        poweredOnAt: null
      }
  const powerState = changes.powerState ?? base.powerState
  let poweredOnAt = base.poweredOnAt
  if (powerState === 'off') poweredOnAt = null
  else if (base.powerState === 'off') poweredOnAt = new Date(tMs)
  return { ...base, ...changes, powerState, poweredOnAt, startsAt: new Date(tMs) }
}

// ---- health detection (moving baseline z-score + trend) ---------------------------

// ~7.5 minutes of readings at the 15s tick cadence - enough to see a trend
// without reacting to a single noisy sample.
export const HEALTH_WINDOW_SIZE = 30
const MIN_SAMPLES = 10
const WARNING_Z = 2
const CRITICAL_Z = 3.5
// A trend counts as significant once the metric moves by more than this
// fraction of its own mean per reading.
const TREND_SLOPE_RATIO = 0.02
// How far back "since" is searched (2h of ticks); past it, since = now - 2h.
export const HEALTH_SINCE_MAX_TICKS = 480

function baseline(values: number[]): { mean: number; stddev: number } {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  return { mean, stddev: Math.sqrt(variance) }
}

function zScore(value: number, mean: number, stddev: number): number {
  if (stddev < 1e-6) return 0
  return (value - mean) / stddev
}

/** Ordinary least squares slope of `values` against their index (0..n-1). */
function trendSlope(values: number[]): number {
  const n = values.length
  const xMean = (n - 1) / 2
  const yMean = values.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean)
    den += (i - xMean) ** 2
  }
  return den ? num / den : 0
}

export type HealthClassification = {
  trend: HealthTrend
  severity: HealthSeverity
  zScore: number
}

/**
 * Baselines every point except the newest against a moving mean/stddev,
 * z-scores the newest point against that baseline, and separately checks
 * whether the whole window has a significant trend - either signal alone
 * can indicate degradation (a sudden jump, or a slow drift that hasn't yet
 * produced an outlier point).
 */
export function classify(values: number[]): HealthClassification {
  const window = values.slice(0, -1)
  if (window.length < MIN_SAMPLES) {
    return { trend: 'stable', severity: 'info', zScore: 0 }
  }
  const latest = values[values.length - 1]
  const { mean, stddev } = baseline(window)
  const z = zScore(latest, mean, stddev)

  const slope = trendSlope(values)
  const slopeRatio = mean !== 0 ? Math.abs(slope) / Math.abs(mean) : 0
  const trend: HealthTrend =
    slopeRatio > TREND_SLOPE_RATIO ? (slope > 0 ? 'rising' : 'falling') : 'stable'

  const absZ = Math.abs(z)
  let severity: HealthSeverity = 'info'
  if (
    absZ >= CRITICAL_Z ||
    (trend !== 'stable' && slopeRatio > TREND_SLOPE_RATIO * 2)
  ) {
    severity = 'critical'
  } else if (absZ >= WARNING_Z || trend !== 'stable') {
    severity = 'warning'
  }

  return { trend, severity, zScore: z }
}

// Readings while the unit was off are a flat, uninteresting line that would
// just dilute the baseline, so they're excluded rather than treated as "no
// anomaly" (same for zero power).
const METRIC_VALUES: Record<HealthMetric, (window: SimulatedReading[]) => number[]> = {
  currentA: (w) => w.filter((r) => r.powerState === 'on').map((r) => r.currentA),
  compressorDuty: (w) =>
    w.filter((r) => r.powerState === 'on').map((r) => r.compressorDuty),
  powerKw: (w) => w.map((r) => r.powerKw).filter((v) => v > 0)
}

export const HEALTH_METRICS: HealthMetric[] = ['compressorDuty', 'currentA', 'powerKw']

export type HealthSignal = HealthClassification & {
  assetId: string
  projectId: string
  metric: HealthMetric
  /** When the current severity started (at least; capped at 2h back) */
  since: Date
  updatedAt: Date
}

/**
 * Current health signals of one asset at nowMs, one per metric with enough
 * samples in the last HEALTH_WINDOW_SIZE readings (none for a unit that has
 * been off for the whole window).
 */
export const healthSignalsAt = (params: {
  assetId: string
  projectId: string
  segments: SimulationSegment[]
  nowMs: number
}): HealthSignal[] => {
  const { segments, nowMs } = params
  // Off for the whole window: every metric filters down to nothing
  if (segments.every((s) => s.powerState === 'off')) return []
  // Oldest first; index i is the tick (last - HEALTH_SINCE_MAX_TICKS - W + 1 + i)
  const span = HEALTH_SINCE_MAX_TICKS + HEALTH_WINDOW_SIZE
  const last = tickOf(nowMs)
  const all: (SimulatedReading | null)[] = []
  for (let tick = last - span + 1; tick <= last; tick++) {
    all.push(readingAt(segments, tickTime(tick)))
  }
  const windowEndingAt = (end: number) =>
    all
      .slice(end - HEALTH_WINDOW_SIZE + 1, end + 1)
      .filter((r): r is SimulatedReading => r !== null)

  const signals: HealthSignal[] = []
  const lastIndex = all.length - 1
  for (const metric of HEALTH_METRICS) {
    const values = METRIC_VALUES[metric](windowEndingAt(lastIndex))
    if (values.length < MIN_SAMPLES) continue
    const current = classify(values)

    let sinceIndex = lastIndex
    for (let end = lastIndex - 1; end >= HEALTH_WINDOW_SIZE - 1; end--) {
      const earlier = METRIC_VALUES[metric](windowEndingAt(end))
      if (earlier.length < MIN_SAMPLES) break
      if (classify(earlier).severity !== current.severity) break
      sinceIndex = end
    }
    signals.push({
      ...current,
      assetId: params.assetId,
      projectId: params.projectId,
      metric,
      since: new Date(tickTime(last - (lastIndex - sinceIndex))),
      updatedAt: new Date(tickTime(last))
    })
  }
  return signals
}

const SEVERITY_RANK: Record<HealthSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2
}

/** Most severe first (stable for equal severities). */
export const sortBySeverity = (signals: HealthSignal[]) =>
  [...signals].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
