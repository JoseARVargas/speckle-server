import cryptoRandomString from 'crypto-random-string'
import { moduleLogger } from '@/observability/logging'
import type { Knex } from 'knex'
import {
  ensureDeviceStateFactory,
  insertDeviceCommandFactory,
  insertEnergyReadingFactory,
  insertTelemetryReadingFactory,
  listAllDeviceStatesFactory,
  updateDeviceStateFactory
} from '@/modules/facilities/repositories/simulation'
import { getFacilityByProjectIdFactory } from '@/modules/facilities/repositories/facilities'
import type {
  DeviceCommandType,
  DevicePowerState
} from '@/modules/facilities/helpers/types'

const TICK_SECONDS = 15
// How fast the temperature converges toward its target - lower is faster.
// Tuned for a demo (minutes, not the ~15-20min a real split AC takes) rather
// than physical accuracy.
const ON_TIME_CONSTANT_SECONDS = 5 * 60
const OFF_TIME_CONSTANT_SECONDS = 12 * 60
const NOISE_DEGREES = 0.15
// Below this distance from the setpoint, the compressor is treated as
// cycling (low duty) rather than running flat out.
const CYCLING_BAND_DEGREES = 1

const jitter = (spread: number) => (Math.random() * 2 - 1) * spread

/**
 * One simulation step for every asset that has ever been turned on or had
 * its temperature set, across the whole database - see listAllDeviceStatesFactory
 * for why this isn't scoped per-project.
 */
export const runSimulationTickFactory =
  (deps: { db: Knex }) => async (): Promise<void> => {
    const states = await listAllDeviceStatesFactory(deps)()
    if (!states.length) return

    const tariffCache = new Map<string, number>()
    const getTariff = async (projectId: string) => {
      const cached = tariffCache.get(projectId)
      if (cached !== undefined) return cached
      const facility = await getFacilityByProjectIdFactory(deps)({ projectId })
      const tariff = facility?.energyTariffPerKwh ?? 0.75
      tariffCache.set(projectId, tariff)
      return tariff
    }

    const now = new Date()
    for (const state of states) {
      const isOn = state.powerState === 'on'
      const target = isOn ? state.setpoint : state.ambientTemperature
      const timeConstant = isOn ? ON_TIME_CONSTANT_SECONDS : OFF_TIME_CONSTANT_SECONDS
      const convergence = 1 - Math.exp(-TICK_SECONDS / timeConstant)
      const nextTemperature =
        state.currentTemperature +
        (target - state.currentTemperature) * convergence +
        jitter(NOISE_DEGREES)

      let powerKw = 0
      if (isOn) {
        const distance = Math.abs(state.currentTemperature - state.setpoint)
        powerKw =
          distance > CYCLING_BAND_DEGREES
            ? state.nominalPowerKw
            : state.nominalPowerKw * (0.2 + Math.random() * 0.15)
      }

      const energyKwhInterval = powerKw * (TICK_SECONDS / 3600)
      const cumulativeKwh = state.cumulativeKwh + energyKwhInterval
      const tariff = await getTariff(state.projectId)
      const costInterval = energyKwhInterval * tariff
      const cumulativeCost = state.cumulativeCost + costInterval

      await updateDeviceStateFactory(deps)({
        assetId: state.assetId,
        update: { currentTemperature: nextTemperature, cumulativeKwh, cumulativeCost }
      })
      await insertTelemetryReadingFactory(deps)({
        assetId: state.assetId,
        projectId: state.projectId,
        ts: now,
        temperature: nextTemperature,
        powerState: state.powerState
      })
      await insertEnergyReadingFactory(deps)({
        assetId: state.assetId,
        projectId: state.projectId,
        ts: now,
        powerKw,
        energyKwhInterval,
        cumulativeKwh,
        costInterval,
        cumulativeCost
      })
    }
  }

let tickInFlight = false

export const startSimulationWorker = (deps: { db: Knex }) => {
  const runTick = runSimulationTickFactory(deps)
  const interval = setInterval(() => {
    if (tickInFlight) return
    tickInFlight = true
    runTick()
      .catch((err) => moduleLogger.error({ err }, 'Simulation tick failed'))
      .finally(() => {
        tickInFlight = false
      })
  }, TICK_SECONDS * 1000)
  interval.unref?.()
  return interval
}

// ---- commands ---------------------------------------------------------

export const setAssetPowerFactory =
  (deps: { db: Knex }) =>
  async (params: {
    assetId: string
    projectId: string
    powerState: DevicePowerState
    userId: string | null
  }) => {
    await ensureDeviceStateFactory(deps)({
      assetId: params.assetId,
      projectId: params.projectId
    })
    const commandType: DeviceCommandType =
      params.powerState === 'on' ? 'power_on' : 'power_off'
    await insertDeviceCommandFactory(deps)({
      id: cryptoRandomString({ length: 10 }),
      assetId: params.assetId,
      projectId: params.projectId,
      commandType,
      value: null,
      issuedBy: params.userId,
      issuedAt: new Date()
    })
    return await updateDeviceStateFactory(deps)({
      assetId: params.assetId,
      update: { powerState: params.powerState }
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
    await ensureDeviceStateFactory(deps)({
      assetId: params.assetId,
      projectId: params.projectId
    })
    await insertDeviceCommandFactory(deps)({
      id: cryptoRandomString({ length: 10 }),
      assetId: params.assetId,
      projectId: params.projectId,
      commandType: 'set_temperature',
      value: params.setpoint,
      issuedBy: params.userId,
      issuedAt: new Date()
    })
    return await updateDeviceStateFactory(deps)({
      assetId: params.assetId,
      update: { setpoint: params.setpoint }
    })
  }
