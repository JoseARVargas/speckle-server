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
import { runHealthDetectionFactory } from '@/modules/facilities/services/health'
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
// Single-phase line voltage assumed for deriving simulated amperage from
// simulated power draw - matches what a real PZEM-004T would be wired at.
const VOLTAGE_V = 220
// How long after power-on the compressor's inrush current spike decays back
// to its steady-state value.
const STARTUP_WINDOW_SECONDS = 45
// A healthy unit's starting current is roughly this multiple of its
// steady-state draw.
const STARTUP_PEAK_MULTIPLIER = 3
// A real remote (IR) gives no direct acknowledgement - the UI only ever
// finds out a command took effect once telemetry reflects it. Delaying the
// command's application here (rather than applying it synchronously) keeps
// the frontend honest about that instead of assuming instant confirmation.
const COMMAND_APPLY_DELAY_MS = [2000, 5000] as const

const jitter = (spread: number) => (Math.random() * 2 - 1) * spread
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const randomDelay = () =>
  COMMAND_APPLY_DELAY_MS[0] +
  Math.random() * (COMMAND_APPLY_DELAY_MS[1] - COMMAND_APPLY_DELAY_MS[0])

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
      // A degraded unit (low refrigerant, dirty filter, ...) removes heat
      // less effectively per tick - modeled as a slower convergence toward
      // setpoint while running. That alone also keeps compressorDuty pinned
      // at 1 for longer below, since the room stays "far from setpoint"
      // longer - no separate duty adjustment needed.
      const convergence =
        (1 - Math.exp(-TICK_SECONDS / timeConstant)) *
        (isOn ? 1 - state.degradationRate * 0.85 : 1)
      const nextTemperature =
        state.currentTemperature +
        (target - state.currentTemperature) * convergence +
        jitter(NOISE_DEGREES)

      // The compressor doesn't run flat out the whole time the unit is "on" -
      // it cycles down to a low duty once the room is near setpoint, same as
      // a real split AC.
      let compressorDuty = 0
      if (isOn) {
        const distance = Math.abs(state.currentTemperature - state.setpoint)
        compressorDuty =
          distance > CYCLING_BAND_DEGREES ? 1 : 0.2 + Math.random() * 0.15
      }
      const powerKw = state.nominalPowerKw * compressorDuty

      // Reported amperage gets its own noise/spike on top of the
      // (noise-free) power used for energy accounting, so the accumulated
      // kWh stays clean while the live reading still looks like a real
      // sensor.
      let currentA = 0
      if (isOn) {
        const baseCurrentA = (powerKw * 1000) / VOLTAGE_V
        // Inrush current spike right after power-on, decaying linearly back
        // to the steady-state value - a worn starting capacitor
        // (startupCurrentDecay) shrinks how high that peak reaches.
        const secondsSincePowerOn = state.poweredOnAt
          ? (now.getTime() - state.poweredOnAt.getTime()) / 1000
          : Infinity
        let startupMultiplier = 1
        if (secondsSincePowerOn < STARTUP_WINDOW_SECONDS) {
          const peak =
            1 + (STARTUP_PEAK_MULTIPLIER - 1) * (1 - state.startupCurrentDecay)
          const progress = secondsSincePowerOn / STARTUP_WINDOW_SECONDS
          startupMultiplier = peak - (peak - 1) * progress
        }
        // A degraded electrical contact shows up as noisier readings, not a
        // shifted mean - only the noise spread scales with
        // noiseAmplification, never the underlying value.
        currentA =
          baseCurrentA *
          startupMultiplier *
          (1 + jitter(0.02 * state.noiseAmplification))
      }

      const energyKwhInterval = powerKw * (TICK_SECONDS / 3600)
      const cumulativeKwh = state.cumulativeKwh + energyKwhInterval
      const tariff = await getTariff(state.projectId)
      const costInterval = energyKwhInterval * tariff
      const cumulativeCost = state.cumulativeCost + costInterval

      await updateDeviceStateFactory(deps)({
        assetId: state.assetId,
        update: {
          currentTemperature: nextTemperature,
          cumulativeKwh,
          cumulativeCost,
          compressorDuty,
          currentA
        }
      })
      await insertTelemetryReadingFactory(deps)({
        assetId: state.assetId,
        projectId: state.projectId,
        ts: now,
        temperature: nextTemperature,
        powerState: state.powerState,
        compressorDuty,
        currentA
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
      await runHealthDetectionFactory(deps)({
        assetId: state.assetId,
        projectId: state.projectId
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
    await sleep(randomDelay())
    return await updateDeviceStateFactory(deps)({
      assetId: params.assetId,
      update: {
        powerState: params.powerState,
        // Marks the moment power was actually applied (post-latency) - the
        // startup current spike in the tick counts from here.
        poweredOnAt: params.powerState === 'on' ? new Date() : null
      }
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
    await sleep(randomDelay())
    return await updateDeviceStateFactory(deps)({
      assetId: params.assetId,
      update: { setpoint: params.setpoint }
    })
  }

// ---- fault injection (predictive maintenance testing) ---------------------

/**
 * Sets a device's fault-injection knobs (see runSimulationTickFactory for
 * how each one distorts the physics) - takes effect on the next tick, no
 * command latency, since this represents a hardware condition rather than a
 * user-issued control action.
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
    await ensureDeviceStateFactory(deps)({
      assetId: params.assetId,
      projectId: params.projectId
    })
    return await updateDeviceStateFactory(deps)({
      assetId: params.assetId,
      update: {
        ...(params.degradationRate !== undefined && params.degradationRate !== null
          ? { degradationRate: params.degradationRate }
          : {}),
        ...(params.startupCurrentDecay !== undefined &&
        params.startupCurrentDecay !== null
          ? { startupCurrentDecay: params.startupCurrentDecay }
          : {}),
        ...(params.noiseAmplification !== undefined &&
        params.noiseAmplification !== null
          ? { noiseAmplification: params.noiseAmplification }
          : {})
      }
    })
  }
