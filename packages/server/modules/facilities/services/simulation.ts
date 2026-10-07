import cryptoRandomString from 'crypto-random-string'
import type { Knex } from 'knex'
import {
  getLatestSegmentFactory,
  insertDeviceCommandFactory,
  listAssetSegmentsFactory,
  listLatestProjectSegmentsFactory,
  listProjectSegmentsFactory,
  recordSegmentFactory
} from '@/modules/facilities/repositories/simulation'
import { getFacilityByProjectIdFactory } from '@/modules/facilities/repositories/facilities'
import type {
  DeviceCommandType,
  DevicePowerState,
  DeviceStateRecord
} from '@/modules/facilities/helpers/types'
import type {
  SimulatedReading,
  SimulationSegment
} from '@/modules/facilities/services/simulationModel'
import {
  nextSegment,
  readingAt,
  readingsUntil,
  windowStartMs
} from '@/modules/facilities/services/simulationModel'
import { BadRequestError } from '@/modules/shared/errors'

/**
 * The simulated devices: events write segments, everything else is
 * computed on read from them (services/simulationModel.ts). Nothing runs in
 * the background.
 */

// A real remote (IR) gives no direct acknowledgement - the UI only ever
// finds out a command took effect once telemetry reflects it. Delaying the
// command's application here (rather than applying it synchronously) keeps
// the frontend honest about that instead of assuming instant confirmation.
const COMMAND_APPLY_DELAY_MS = [2000, 5000] as const
const DEFAULT_TARIFF_PER_KWH = 0.75

/** Cap on readings per history/series request (A06: computed on demand). */
export const MAX_HISTORY_POINTS = 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const randomDelay = () =>
  COMMAND_APPLY_DELAY_MS[0] +
  Math.random() * (COMMAND_APPLY_DELAY_MS[1] - COMMAND_APPLY_DELAY_MS[0])

export const assertHistoryLimit = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_HISTORY_POINTS) {
    throw new BadRequestError(
      `limit must be an integer between 0 and ${MAX_HISTORY_POINTS}`
    )
  }
}

/** The DeviceState shape (GraphQL and the device_states mirror) at nowMs. */
export const deviceStateAt = (
  segment: SimulationSegment,
  nowMs: number
): DeviceStateRecord => {
  // A single segment is enough: it is the one active at nowMs
  const reading = readingAt([segment], Math.max(nowMs, segment.startsAt.getTime()))!
  return {
    assetId: segment.assetId,
    projectId: segment.projectId,
    powerState: segment.powerState,
    setpoint: segment.setpoint,
    currentTemperature: reading.temperature,
    ambientTemperature: segment.ambientTemperature,
    nominalPowerKw: segment.nominalPowerKw,
    cumulativeKwh: reading.cumulativeKwh,
    cumulativeCost: reading.cumulativeCost,
    compressorDuty: reading.compressorDuty,
    currentA: reading.currentA,
    degradationRate: segment.degradationRate,
    startupCurrentDecay: segment.startupCurrentDecay,
    noiseAmplification: segment.noiseAmplification,
    poweredOnAt: segment.poweredOnAt,
    updatedAt: reading.ts
  }
}

// ---- events -----------------------------------------------------------------------

type SegmentChanges = Parameters<typeof nextSegment>[0]['changes']

const applyEventFactory =
  (deps: { db: Knex }) =>
  async (params: {
    assetId: string
    projectId: string
    changes: SegmentChanges
  }): Promise<DeviceStateRecord> => {
    const facility = await getFacilityByProjectIdFactory(deps)({
      projectId: params.projectId
    })
    const { mirror } = await recordSegmentFactory(deps)({
      assetId: params.assetId,
      projectId: params.projectId,
      build: (previous) => {
        const nowMs = Date.now()
        const segment = nextSegment({
          previous,
          assetId: params.assetId,
          projectId: params.projectId,
          tMs: nowMs,
          defaultTariffPerKwh: facility?.energyTariffPerKwh ?? DEFAULT_TARIFF_PER_KWH,
          changes: params.changes
        })
        return { segment, mirror: deviceStateAt(segment, nowMs) }
      }
    })
    return mirror
  }

const logCommandFactory =
  (deps: { db: Knex }) =>
  (params: {
    assetId: string
    projectId: string
    commandType: DeviceCommandType
    value: number | null
    userId: string | null
  }) =>
    insertDeviceCommandFactory(deps)({
      id: cryptoRandomString({ length: 10 }),
      assetId: params.assetId,
      projectId: params.projectId,
      commandType: params.commandType,
      value: params.value,
      issuedBy: params.userId,
      issuedAt: new Date()
    })

export const setAssetPowerFactory =
  (deps: { db: Knex }) =>
  async (params: {
    assetId: string
    projectId: string
    powerState: DevicePowerState
    userId: string | null
  }) => {
    await logCommandFactory(deps)({
      assetId: params.assetId,
      projectId: params.projectId,
      commandType: params.powerState === 'on' ? 'power_on' : 'power_off',
      value: null,
      userId: params.userId
    })
    await sleep(randomDelay())
    // poweredOnAt marks the moment power was actually applied (post-latency):
    // the startup current spike counts from here.
    return await applyEventFactory(deps)({
      assetId: params.assetId,
      projectId: params.projectId,
      changes: { powerState: params.powerState }
    })
  }

export const setAssetTemperatureFactory =
  (deps: { db: Knex }) =>
  async (params: {
    assetId: string
    projectId: string
    setpoint: number
    userId: string | null
  }) => {
    await logCommandFactory(deps)({
      assetId: params.assetId,
      projectId: params.projectId,
      commandType: 'set_temperature',
      value: params.setpoint,
      userId: params.userId
    })
    await sleep(randomDelay())
    return await applyEventFactory(deps)({
      assetId: params.assetId,
      projectId: params.projectId,
      changes: { setpoint: params.setpoint }
    })
  }

/**
 * Sets a device's fault-injection knobs (see simulationModel.ts for how each
 * one distorts the physics) - immediate, no command latency, since this
 * represents a hardware condition rather than a user-issued control action.
 */
export const setDeviceFaultProfileFactory =
  (deps: { db: Knex }) =>
  async (params: {
    assetId: string
    projectId: string
    degradationRate?: number | null
    startupCurrentDecay?: number | null
    noiseAmplification?: number | null
  }) => {
    const changes: SegmentChanges = {}
    if (params.degradationRate !== undefined && params.degradationRate !== null)
      changes.degradationRate = params.degradationRate
    if (params.startupCurrentDecay !== undefined && params.startupCurrentDecay !== null)
      changes.startupCurrentDecay = params.startupCurrentDecay
    if (params.noiseAmplification !== undefined && params.noiseAmplification !== null)
      changes.noiseAmplification = params.noiseAmplification
    return await applyEventFactory(deps)({
      assetId: params.assetId,
      projectId: params.projectId,
      changes
    })
  }

/**
 * A facility tariff change bills from now on: every simulated asset of the
 * project gets a new segment with the new tariff (energy so far keeps the
 * old one).
 */
export const applyTariffChangeFactory =
  (deps: { db: Knex }) =>
  async (params: { projectId: string; tariffPerKwh: number }) => {
    const latest = await listLatestProjectSegmentsFactory(deps)({
      projectId: params.projectId
    })
    for (const segment of latest) {
      if (segment.tariffPerKwh === params.tariffPerKwh) continue
      await applyEventFactory(deps)({
        assetId: segment.assetId,
        projectId: params.projectId,
        changes: { tariffPerKwh: params.tariffPerKwh }
      })
    }
  }

// ---- reads --------------------------------------------------------------------------

/** Live state, or null until the asset has been turned on / set once. */
export const getDeviceStateFactory =
  (deps: { db: Knex }) =>
  async (params: { assetId: string }): Promise<DeviceStateRecord | null> => {
    const segment = await getLatestSegmentFactory(deps)({ assetId: params.assetId })
    return segment ? deviceStateAt(segment, Date.now()) : null
  }

/** The last `limit` grid readings of one asset, most recent first. */
export const listAssetReadingsFactory =
  (deps: { db: Knex }) =>
  async (params: { assetId: string; limit: number }): Promise<SimulatedReading[]> => {
    assertHistoryLimit(params.limit)
    if (!params.limit) return []
    const nowMs = Date.now()
    const segments = await listAssetSegmentsFactory(deps)({
      assetId: params.assetId,
      from: new Date(windowStartMs(nowMs, params.limit)),
      to: new Date(nowMs)
    })
    return readingsUntil(segments, nowMs, params.limit).reverse()
  }

/** Live state of every simulated asset of a project. */
export const listProjectDeviceStatesFactory =
  (deps: { db: Knex }) =>
  async (params: { projectId: string }): Promise<DeviceStateRecord[]> => {
    const nowMs = Date.now()
    const latest = await listLatestProjectSegmentsFactory(deps)({
      projectId: params.projectId
    })
    return latest.map((segment) => deviceStateAt(segment, nowMs))
  }

/**
 * Facility-wide power/energy/cost per grid tick (every asset shares the
 * ticks), oldest first, for the `limit` most recent ticks with any reading.
 */
export const getFacilityEnergySeriesFactory =
  (deps: { db: Knex }) =>
  async (params: {
    projectId: string
    limit: number
  }): Promise<
    { ts: Date; powerKw: number; energyKwhInterval: number; costInterval: number }[]
  > => {
    assertHistoryLimit(params.limit)
    if (!params.limit) return []
    const nowMs = Date.now()
    const byAsset = await listProjectSegmentsFactory(deps)({
      projectId: params.projectId,
      from: new Date(windowStartMs(nowMs, params.limit)),
      to: new Date(nowMs)
    })
    const byTs = new Map<
      number,
      { ts: Date; powerKw: number; energyKwhInterval: number; costInterval: number }
    >()
    for (const segments of byAsset.values()) {
      for (const r of readingsUntil(segments, nowMs, params.limit)) {
        const key = r.ts.getTime()
        const point = byTs.get(key) ?? {
          ts: r.ts,
          powerKw: 0,
          energyKwhInterval: 0,
          costInterval: 0
        }
        point.powerKw += r.powerKw
        point.energyKwhInterval += r.energyKwhInterval
        point.costInterval += r.costInterval
        byTs.set(key, point)
      }
    }
    return [...byTs.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime())
  }

/** Dashboard totals at the current grid tick. */
export const getFacilityEnergyTotalsFactory =
  (deps: { db: Knex }) =>
  async (params: {
    projectId: string
  }): Promise<{
    assetsOn: number
    currentPowerKw: number
    cumulativeKwh: number
    cumulativeCost: number
  }> => {
    const states = await listProjectDeviceStatesFactory(deps)(params)
    return states.reduce(
      (acc, s) => ({
        assetsOn: acc.assetsOn + (s.powerState === 'on' ? 1 : 0),
        currentPowerKw: acc.currentPowerKw + s.nominalPowerKw * s.compressorDuty,
        cumulativeKwh: acc.cumulativeKwh + s.cumulativeKwh,
        cumulativeCost: acc.cumulativeCost + s.cumulativeCost
      }),
      { assetsOn: 0, currentPowerKw: 0, cumulativeKwh: 0, cumulativeCost: 0 }
    )
  }
