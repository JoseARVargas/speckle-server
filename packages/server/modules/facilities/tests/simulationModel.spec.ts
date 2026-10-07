import { expect } from 'chai'
import type { SimulationSegment } from '@/modules/facilities/services/simulationModel'
import {
  CYCLING_BAND_DEGREES,
  HEALTH_SINCE_MAX_TICKS,
  OFF_TIME_CONSTANT_SECONDS,
  ON_TIME_CONSTANT_SECONDS,
  TICK_SECONDS,
  bandEntrySeconds,
  classify,
  cleanTemperatureAt,
  cumulativeAt,
  healthSignalsAt,
  nextSegment,
  readingAt,
  readingsUntil,
  segmentAt,
  tickTime
} from '@/modules/facilities/services/simulationModel'

/**
 * Pure simulation model behind the on-demand device simulation - see
 * speckle-digitaltwin-console/.ai/plans/2026-10-07-simulacao-sob-demanda.md.
 */

const TICK_MS = TICK_SECONDS * 1000
// A grid-aligned instant, so segment starts and readings line up
const T0 = tickTime(120_000_000)

const segment = (overrides: Partial<SimulationSegment> = {}): SimulationSegment => ({
  assetId: 'asset00001',
  projectId: 'project001',
  startsAt: new Date(T0),
  powerState: 'on',
  setpoint: 22,
  ambientTemperature: 28,
  nominalPowerKw: 1.2,
  degradationRate: 0,
  startupCurrentDecay: 0,
  noiseAmplification: 1,
  tariffPerKwh: 0.75,
  temperatureAtStart: 28,
  cumulativeKwhAtStart: 0,
  cumulativeCostAtStart: 0,
  poweredOnAt: new Date(T0),
  ...overrides
})

/** The removed 15s tick's temperature step, noise-free - the oracle. */
const oracleTemperatures = (seg: SimulationSegment, ticks: number) => {
  const on = seg.powerState === 'on'
  const target = on ? seg.setpoint : seg.ambientTemperature
  const timeConstant = on ? ON_TIME_CONSTANT_SECONDS : OFF_TIME_CONSTANT_SECONDS
  const convergence =
    (1 - Math.exp(-TICK_SECONDS / timeConstant)) *
    (on ? 1 - seg.degradationRate * 0.85 : 1)
  const out: number[] = []
  let t = seg.temperatureAtStart
  for (let i = 0; i < ticks; i++) {
    t = t + (target - t) * convergence
    out.push(t)
  }
  return out
}

describe('Facilities simulation model @facilities', () => {
  describe('temperature', () => {
    for (const [label, seg] of [
      ['running', segment()],
      ['running degraded', segment({ degradationRate: 0.6 })],
      ['off', segment({ powerState: 'off', temperatureAtStart: 21, poweredOnAt: null })]
    ] as const) {
      it(`matches the old discrete tick on the grid (${label})`, () => {
        const expected = oracleTemperatures(seg, 240)
        expected.forEach((temperature, i) => {
          const actual = cleanTemperatureAt(seg, T0 + (i + 1) * TICK_MS)
          expect(Math.abs(actual - temperature)).to.be.lessThan(1e-9)
        })
      })
    }

    it('enters the cycling band at the computed instant', () => {
      const seg = segment()
      const entry = bandEntrySeconds(seg)
      expect(entry).to.be.greaterThan(0)
      const before = cleanTemperatureAt(seg, T0 + (entry - 1) * 1000)
      const after = cleanTemperatureAt(seg, T0 + (entry + 1) * 1000)
      expect(before - seg.setpoint).to.be.greaterThan(CYCLING_BAND_DEGREES)
      expect(after - seg.setpoint).to.be.lessThan(CYCLING_BAND_DEGREES)
    })

    it('starts cycling right away when already inside the band', () => {
      expect(bandEntrySeconds(segment({ temperatureAtStart: 22.5 }))).to.equal(0)
    })
  })

  describe('events', () => {
    it('keeps the trajectory and totals continuous across a new segment', () => {
      const first = segment()
      const tMs = T0 + 7 * 60 * 1000 + 3210 // mid-tick on purpose
      const second = nextSegment({
        previous: first,
        assetId: first.assetId,
        projectId: first.projectId,
        tMs,
        defaultTariffPerKwh: 0.75,
        changes: { setpoint: 18 }
      })
      expect(second.startsAt.getTime()).to.equal(tMs)
      expect(second.setpoint).to.equal(18)
      expect(second.temperatureAtStart).to.equal(cleanTemperatureAt(first, tMs))
      expect(cleanTemperatureAt(second, tMs)).to.be.closeTo(
        cleanTemperatureAt(first, tMs),
        1e-12
      )
      expect(cumulativeAt(second, tMs).kwh).to.be.closeTo(
        cumulativeAt(first, tMs).kwh,
        1e-12
      )
      expect(cumulativeAt(second, tMs).cost).to.be.closeTo(
        cumulativeAt(first, tMs).cost,
        1e-12
      )
    })

    it('tracks poweredOnAt only on an off -> on transition', () => {
      const off = segment({ powerState: 'off', poweredOnAt: null })
      const tOn = T0 + 60_000
      const on = nextSegment({
        previous: off,
        assetId: off.assetId,
        projectId: off.projectId,
        tMs: tOn,
        defaultTariffPerKwh: 0.75,
        changes: { powerState: 'on' }
      })
      expect(on.poweredOnAt?.getTime()).to.equal(tOn)
      const stillOn = nextSegment({
        previous: on,
        assetId: on.assetId,
        projectId: on.projectId,
        tMs: tOn + 60_000,
        defaultTariffPerKwh: 0.75,
        changes: { setpoint: 20 }
      })
      expect(stillOn.poweredOnAt?.getTime()).to.equal(tOn)
      const offAgain = nextSegment({
        previous: stillOn,
        assetId: on.assetId,
        projectId: on.projectId,
        tMs: tOn + 120_000,
        defaultTariffPerKwh: 0.75,
        changes: { powerState: 'off' }
      })
      expect(offAgain.poweredOnAt).to.equal(null)
    })

    it('starts a brand new device from the defaults and the facility tariff', () => {
      const seg = nextSegment({
        previous: null,
        assetId: 'asset00002',
        projectId: 'project001',
        tMs: T0,
        defaultTariffPerKwh: 0.9,
        changes: { powerState: 'on' }
      })
      expect(seg.temperatureAtStart).to.equal(28)
      expect(seg.setpoint).to.equal(22)
      expect(seg.tariffPerKwh).to.equal(0.9)
      expect(seg.poweredOnAt?.getTime()).to.equal(T0)
    })

    it('never starts a segment before the one it follows', () => {
      const first = segment()
      const second = nextSegment({
        previous: first,
        assetId: first.assetId,
        projectId: first.projectId,
        tMs: T0 - 5000,
        defaultTariffPerKwh: 0.75,
        changes: { setpoint: 20 }
      })
      expect(second.startsAt.getTime()).to.equal(T0)
    })

    it('resolves the active segment, later insertions winning ties', () => {
      const a = segment()
      const b = segment({ setpoint: 20 })
      const c = segment({ startsAt: new Date(T0 + 60_000), setpoint: 18 })
      expect(segmentAt([a, b, c], T0 - 1)).to.equal(null)
      expect(segmentAt([a, b, c], T0)).to.equal(b)
      expect(segmentAt([a, b, c], T0 + 60_000)).to.equal(c)
    })
  })

  describe('energy', () => {
    it('makes the series intervals add up to the totals, across events and a tariff change', () => {
      const s1 = segment()
      const s2 = nextSegment({
        previous: s1,
        assetId: s1.assetId,
        projectId: s1.projectId,
        tMs: T0 + 10 * 60 * 1000 + 4321,
        defaultTariffPerKwh: 0.75,
        changes: { tariffPerKwh: 1.1 }
      })
      const s3 = nextSegment({
        previous: s2,
        assetId: s1.assetId,
        projectId: s1.projectId,
        tMs: T0 + 20 * 60 * 1000 + 999,
        defaultTariffPerKwh: 0.75,
        changes: { powerState: 'off' }
      })
      const s4 = nextSegment({
        previous: s3,
        assetId: s1.assetId,
        projectId: s1.projectId,
        tMs: T0 + 25 * 60 * 1000,
        defaultTariffPerKwh: 0.75,
        changes: { powerState: 'on', setpoint: 20 }
      })
      const chain = [s1, s2, s3, s4]
      const nowMs = T0 + 40 * 60 * 1000
      const readings = readingsUntil(chain, nowMs, 1000)
      expect(readings[0].ts.getTime()).to.equal(T0) // nothing before the first segment

      const last = readings[readings.length - 1]
      const kwh = readings.reduce((sum, r) => sum + r.energyKwhInterval, 0)
      const cost = readings.reduce((sum, r) => sum + r.costInterval, 0)
      expect(kwh).to.be.closeTo(last.cumulativeKwh, 1e-9)
      expect(cost).to.be.closeTo(last.cumulativeCost, 1e-9)
      expect(last.cumulativeKwh).to.be.greaterThan(0)

      // Monotonic totals, nothing accrued while off
      for (let i = 1; i < readings.length; i++) {
        expect(readings[i].cumulativeKwh).to.be.at.least(readings[i - 1].cumulativeKwh)
        if (readings[i].powerState === 'off' && readings[i - 1].powerState === 'off') {
          expect(readings[i].energyKwhInterval).to.equal(0)
        }
      }
    })

    it('bills full power until the band, then the mean cycling duty', () => {
      const seg = segment()
      const entry = bandEntrySeconds(seg)
      const at = (seconds: number) => cumulativeAt(seg, T0 + seconds * 1000).kwh
      expect(at(entry)).to.be.closeTo((1.2 * entry) / 3600, 1e-9)
      expect(at(entry + 3600) - at(entry)).to.be.closeTo(1.2 * 0.275, 1e-9)
    })
  })

  describe('readings', () => {
    it('is deterministic, and the noise differs between assets', () => {
      const a = segment()
      const b = segment({ assetId: 'asset00009' })
      const t = T0 + 30 * 60 * 1000
      expect(readingAt([a], t)).to.deep.equal(readingAt([a], t))
      expect(readingAt([a], t)!.temperature).to.not.equal(
        readingAt([b], t)!.temperature
      )
    })

    it('reads zero duty, power and current while off', () => {
      const r = readingAt(
        [segment({ powerState: 'off', poweredOnAt: null })],
        T0 + 5 * TICK_MS
      )!
      expect(r.compressorDuty).to.equal(0)
      expect(r.powerKw).to.equal(0)
      expect(r.currentA).to.equal(0)
    })

    it('shows the startup current spike, shrunk by a worn capacitor', () => {
      const t = T0 + 1000 // 1s after power on, at full duty
      const steady = (1.2 * 1000) / 220
      const healthy = readingAt([segment()], t)!.currentA
      const worn = readingAt([segment({ startupCurrentDecay: 1 })], t)!.currentA
      expect(healthy / steady).to.be.closeTo(3 - 2 / 45, 0.1)
      expect(worn / steady).to.be.closeTo(1, 0.05)
      const later = readingAt([segment()], T0 + 60_000)!.currentA
      expect(later / steady).to.be.closeTo(1, 0.05)
    })

    it('returns nothing before the first segment', () => {
      expect(readingAt([segment()], T0 - 1)).to.equal(null)
      expect(readingsUntil([segment()], T0 - TICK_MS, 10)).to.deep.equal([])
    })
  })

  describe('health', () => {
    it('classifies flat, jumping and drifting series as before', () => {
      const flat = Array.from({ length: 30 }, () => 5)
      expect(classify(flat)).to.deep.equal({
        trend: 'stable',
        severity: 'info',
        zScore: 0
      })

      const noisy = Array.from({ length: 29 }, (_, i) => 5 + (i % 2 ? 0.1 : -0.1))
      expect(classify([...noisy, 9]).severity).to.equal('critical')

      // slope/mean ~3%: a trend (warning); ~4.4%: twice the threshold (critical)
      const drifting = Array.from({ length: 30 }, (_, i) => 5 + i * 0.3)
      expect(classify(drifting).trend).to.equal('rising')
      expect(classify(drifting).severity).to.equal('warning')
      const steep = Array.from({ length: 30 }, (_, i) => 5 + i * 0.6)
      expect(classify(steep).severity).to.equal('critical')

      expect(classify([1, 2, 3]).severity).to.equal('info') // too few samples
    })

    it('has no signals for a unit off during the whole window', () => {
      const off = segment({ powerState: 'off', poweredOnAt: null })
      expect(
        healthSignalsAt({
          assetId: off.assetId,
          projectId: off.projectId,
          segments: [off],
          nowMs: T0 + 3600_000
        })
      ).to.deep.equal([])
    })

    it('reports one signal per metric with a bounded "since"', () => {
      const seg = segment({ degradationRate: 0.5 })
      const nowMs = T0 + 5 * 3600_000
      const signals = healthSignalsAt({
        assetId: seg.assetId,
        projectId: seg.projectId,
        segments: [seg],
        nowMs
      })
      expect(signals.map((s) => s.metric).sort()).to.deep.equal([
        'compressorDuty',
        'currentA',
        'powerKw'
      ])
      for (const s of signals) {
        expect(s.updatedAt.getTime()).to.be.at.most(nowMs)
        expect(s.since.getTime()).to.be.at.most(s.updatedAt.getTime())
        expect(s.since.getTime()).to.be.at.least(
          s.updatedAt.getTime() - HEALTH_SINCE_MAX_TICKS * TICK_MS
        )
      }
    })
  })
})
