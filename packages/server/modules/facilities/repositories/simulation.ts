import {
  DeviceStates,
  DeviceCommands,
  TelemetryReadings,
  EnergyReadings
} from '@/modules/core/dbSchema'
import type {
  DeviceStateRecord,
  DeviceCommandRecord,
  TelemetryReadingRecord,
  EnergyReadingRecord
} from '@/modules/facilities/helpers/types'
import type { Knex } from 'knex'

const tables = {
  deviceStates: (db: Knex) => db<DeviceStateRecord>(DeviceStates.name),
  deviceCommands: (db: Knex) => db<DeviceCommandRecord>(DeviceCommands.name),
  telemetryReadings: (db: Knex) => db<TelemetryReadingRecord>(TelemetryReadings.name),
  energyReadings: (db: Knex) => db<EnergyReadingRecord>(EnergyReadings.name)
}

// ---- device state -----------------------------------------------------

export const getDeviceStateFactory =
  (deps: { db: Knex }) => (params: { assetId: string }) =>
    tables.deviceStates(deps.db).where({ assetId: params.assetId }).first()

/**
 * A device_states row only exists once someone turns an asset "on" for the
 * first time (or sets a temperature) - before that, an asset simply has no
 * simulated state. Sensible fixed defaults for now (no per-AssetType
 * nominal power catalog yet).
 */
export const ensureDeviceStateFactory =
  (deps: { db: Knex }) =>
  async (params: {
    assetId: string
    projectId: string
  }): Promise<DeviceStateRecord> => {
    const existing = await getDeviceStateFactory(deps)({ assetId: params.assetId })
    if (existing) return existing

    const defaults: DeviceStateRecord = {
      assetId: params.assetId,
      projectId: params.projectId,
      powerState: 'off',
      setpoint: 22,
      currentTemperature: 28,
      ambientTemperature: 28,
      nominalPowerKw: 1.2,
      cumulativeKwh: 0,
      cumulativeCost: 0,
      updatedAt: new Date()
    }
    const [row] = await tables.deviceStates(deps.db).insert(defaults).returning('*')
    return row
  }

export const updateDeviceStateFactory =
  (deps: { db: Knex }) =>
  async (params: { assetId: string; update: Partial<DeviceStateRecord> }) => {
    const [row] = await tables
      .deviceStates(deps.db)
      .where({ assetId: params.assetId })
      .update({ ...params.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

/**
 * Every device_states row, regardless of project - the simulation tick
 * walks all of them each cycle. Single-database deployments only for now
 * (see simulation.ts); a multi-region setup would need this per-region.
 */
export const listAllDeviceStatesFactory = (deps: { db: Knex }) => () =>
  tables.deviceStates(deps.db).select('*')

// ---- device commands (audit log) -------------------------------------------

export const insertDeviceCommandFactory =
  (deps: { db: Knex }) => async (command: DeviceCommandRecord) => {
    const [row] = await tables.deviceCommands(deps.db).insert(command).returning('*')
    return row
  }

// ---- telemetry & energy readings -------------------------------------------

export const insertTelemetryReadingFactory =
  (deps: { db: Knex }) => (reading: Omit<TelemetryReadingRecord, 'id'>) =>
    tables.telemetryReadings(deps.db).insert(reading)

export const listTelemetryReadingsFactory =
  (deps: { db: Knex }) => (params: { assetId: string; limit: number }) =>
    tables
      .telemetryReadings(deps.db)
      .where({ assetId: params.assetId })
      .orderBy('ts', 'desc')
      .limit(params.limit)

export const insertEnergyReadingFactory =
  (deps: { db: Knex }) => (reading: Omit<EnergyReadingRecord, 'id'>) =>
    tables.energyReadings(deps.db).insert(reading)

export const listEnergyReadingsFactory =
  (deps: { db: Knex }) => (params: { assetId: string; limit: number }) =>
    tables
      .energyReadings(deps.db)
      .where({ assetId: params.assetId })
      .orderBy('ts', 'desc')
      .limit(params.limit)
