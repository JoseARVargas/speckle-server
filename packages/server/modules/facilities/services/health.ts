import cryptoRandomString from 'crypto-random-string'
import type { Knex } from 'knex'
import {
  listTelemetryReadingsFactory,
  listEnergyReadingsFactory
} from '@/modules/facilities/repositories/simulation'
import { upsertHealthSignalFactory } from '@/modules/facilities/repositories/health'
import type {
  HealthMetric,
  HealthSeverity,
  HealthTrend
} from '@/modules/facilities/helpers/types'

// ~7.5 minutes of readings at the 15s tick cadence - enough to see a trend
// without reacting to a single noisy sample.
const WINDOW_SIZE = 30
const MIN_SAMPLES = 10
const WARNING_Z = 2
const CRITICAL_Z = 3.5
// A trend counts as significant once the metric moves by more than this
// fraction of its own mean per reading.
const TREND_SLOPE_RATIO = 0.02

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

/**
 * Baselines every point except the newest against a moving mean/stddev,
 * z-scores the newest point against that baseline, and separately checks
 * whether the whole window has a significant trend - either signal alone
 * can indicate degradation (a sudden jump, or a slow drift that hasn't yet
 * produced an outlier point).
 */
function classify(values: number[]): {
  trend: HealthTrend
  severity: HealthSeverity
  zScore: number
} {
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

/**
 * One detection pass for a single asset - pulls its recent telemetry/energy
 * history, classifies each of the three metrics from the spec
 * (current_a, power_w, compressor_duty), and upserts a signal row per
 * metric. Called from the simulation tick right after that asset's new
 * reading is written, so the freshly-inserted point is included.
 */
export const runHealthDetectionFactory =
  (deps: { db: Knex }) =>
  async (params: { assetId: string; projectId: string }): Promise<void> => {
    const [telemetry, energy] = await Promise.all([
      listTelemetryReadingsFactory(deps)({
        assetId: params.assetId,
        limit: WINDOW_SIZE
      }),
      listEnergyReadingsFactory(deps)({ assetId: params.assetId, limit: WINDOW_SIZE })
    ])

    // Both come back most-recent-first; reverse to chronological order for
    // the regression. Readings from while the unit was off are a flat,
    // uninteresting line that would just dilute the baseline, so they're
    // excluded rather than treated as "no anomaly".
    const currentAValues = telemetry
      .filter((r) => r.powerState === 'on')
      .map((r) => r.currentA)
      .reverse()
    const dutyValues = telemetry
      .filter((r) => r.powerState === 'on')
      .map((r) => r.compressorDuty)
      .reverse()
    const powerValues = energy
      .map((r) => r.powerKw)
      .filter((v) => v > 0)
      .reverse()

    const metrics: [HealthMetric, number[]][] = [
      ['currentA', currentAValues],
      ['compressorDuty', dutyValues],
      ['powerKw', powerValues]
    ]

    for (const [metric, values] of metrics) {
      if (values.length < MIN_SAMPLES) continue
      const { trend, severity, zScore: z } = classify(values)
      await upsertHealthSignalFactory(deps)({
        id: cryptoRandomString({ length: 10 }),
        assetId: params.assetId,
        projectId: params.projectId,
        metric,
        trend,
        severity,
        zScore: z
      })
    }
  }
