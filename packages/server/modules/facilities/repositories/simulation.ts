import {
  DeviceStates,
  DeviceCommands,
  DeviceStateSegments
} from '@/modules/core/dbSchema'
import type {
  DeviceStateRecord,
  DeviceCommandRecord,
  DeviceStateSegmentRecord
} from '@/modules/facilities/helpers/types'
import type { SimulationSegment } from '@/modules/facilities/services/simulationModel'
import type { Knex } from 'knex'

const tables = {
  deviceStates: (db: Knex) => db<DeviceStateRecord>(DeviceStates.name),
  deviceCommands: (db: Knex) => db<DeviceCommandRecord>(DeviceCommands.name),
  segments: (db: Knex) => db<DeviceStateSegmentRecord>(DeviceStateSegments.name)
}

const toSegment = (row: DeviceStateSegmentRecord): SimulationSegment => ({
  assetId: row.assetId,
  projectId: row.projectId,
  startsAt: row.startsAt,
  powerState: row.powerState,
  setpoint: row.setpoint,
  ambientTemperature: row.ambientTemperature,
  nominalPowerKw: row.nominalPowerKw,
  degradationRate: row.degradationRate,
  startupCurrentDecay: row.startupCurrentDecay,
  noiseAmplification: row.noiseAmplification,
  tariffPerKwh: row.tariffPerKwh,
  temperatureAtStart: row.temperatureAtStart,
  cumulativeKwhAtStart: row.cumulativeKwhAtStart,
  cumulativeCostAtStart: row.cumulativeCostAtStart,
  poweredOnAt: row.poweredOnAt
})

// ---- segments (one per event, the simulation's only writes) -----------------

/** Ties on startsAt (two events in the same ms) resolve by insertion order. */
const chronological = (
  q: Knex.QueryBuilder<DeviceStateSegmentRecord>
): Promise<DeviceStateSegmentRecord[]> =>
  q
    .orderBy(DeviceStateSegments.col.startsAt, 'asc')
    .orderBy(DeviceStateSegments.col.id, 'asc')

export const getLatestSegmentFactory =
  (deps: { db: Knex }) =>
  async (params: { assetId: string }): Promise<SimulationSegment | null> => {
    const row = await tables
      .segments(deps.db)
      .where(DeviceStateSegments.col.assetId, params.assetId)
      .orderBy(DeviceStateSegments.col.startsAt, 'desc')
      .orderBy(DeviceStateSegments.col.id, 'desc')
      .first()
    return row ? toSegment(row) : null
  }

/**
 * The segments of one asset needed to compute readings in [fromMs, toMs]:
 * the one active at fromMs plus every later one up to toMs, oldest first.
 */
export const listAssetSegmentsFactory =
  (deps: { db: Knex }) =>
  async (params: {
    assetId: string
    from: Date
    to: Date
  }): Promise<SimulationSegment[]> => {
    const rows = await chronological(
      tables
        .segments(deps.db)
        .where(DeviceStateSegments.col.assetId, params.assetId)
        .andWhere(DeviceStateSegments.col.startsAt, '<=', params.to)
        .andWhere(
          DeviceStateSegments.col.startsAt,
          '>=',
          deps.db.raw(
            `COALESCE((SELECT MAX("startsAt") FROM "${DeviceStateSegments.name}"
              WHERE "assetId" = ? AND "startsAt" <= ?), '-infinity'::timestamptz)`,
            [params.assetId, params.from]
          )
        )
    )
    return rows.map(toSegment)
  }

/** Same as listAssetSegmentsFactory for every asset of a project, by asset. */
export const listProjectSegmentsFactory =
  (deps: { db: Knex }) =>
  async (params: {
    projectId: string
    from: Date
    to: Date
  }): Promise<Map<string, SimulationSegment[]>> => {
    const name = DeviceStateSegments.name
    const rows = await chronological(
      tables
        .segments(deps.db)
        .where(DeviceStateSegments.col.projectId, params.projectId)
        .andWhere(DeviceStateSegments.col.startsAt, '<=', params.to)
        .andWhere(
          DeviceStateSegments.col.startsAt,
          '>=',
          deps.db.raw(
            `COALESCE((SELECT MAX(s2."startsAt") FROM "${name}" s2
              WHERE s2."assetId" = "${name}"."assetId" AND s2."startsAt" <= ?),
              '-infinity'::timestamptz)`,
            [params.from]
          )
        )
    )
    const byAsset = new Map<string, SimulationSegment[]>()
    for (const row of rows) {
      const list = byAsset.get(row.assetId) ?? []
      list.push(toSegment(row))
      byAsset.set(row.assetId, list)
    }
    return byAsset
  }

/** Latest segment of every asset of a project that has a simulated state. */
export const listLatestProjectSegmentsFactory =
  (deps: { db: Knex }) =>
  async (params: { projectId: string }): Promise<SimulationSegment[]> => {
    const rows = await tables
      .segments(deps.db)
      .distinctOn(DeviceStateSegments.col.assetId)
      .where(DeviceStateSegments.col.projectId, params.projectId)
      .orderBy([
        { column: DeviceStateSegments.col.assetId, order: 'asc' },
        { column: DeviceStateSegments.col.startsAt, order: 'desc' },
        { column: DeviceStateSegments.col.id, order: 'desc' }
      ])
    return rows.map(toSegment)
  }

/**
 * Records an event: locks the asset's device_states row (serializing
 * concurrent events on the same asset, so none of them is lost), lets
 * `build` derive the new segment from the latest one, inserts it and
 * mirrors the materialized state into device_states. The mirror keeps the
 * previous server image (which still ticks from device_states) usable for
 * a rollback.
 */
export const recordSegmentFactory =
  (deps: { db: Knex }) =>
  async (params: {
    assetId: string
    projectId: string
    build: (previous: SimulationSegment | null) => {
      segment: SimulationSegment
      mirror: DeviceStateRecord
    }
  }): Promise<{ segment: SimulationSegment; mirror: DeviceStateRecord }> =>
    await deps.db.transaction(async (trx) => {
      const existing = await tables
        .deviceStates(trx)
        .where({ assetId: params.assetId })
        .forUpdate()
        .first()
      const previous = await getLatestSegmentFactory({ db: trx })({
        assetId: params.assetId
      })
      const built = params.build(previous)
      const { segment } = built
      await tables.segments(trx).insert({
        assetId: segment.assetId,
        projectId: segment.projectId,
        startsAt: segment.startsAt,
        powerState: segment.powerState,
        setpoint: segment.setpoint,
        ambientTemperature: segment.ambientTemperature,
        nominalPowerKw: segment.nominalPowerKw,
        degradationRate: segment.degradationRate,
        startupCurrentDecay: segment.startupCurrentDecay,
        noiseAmplification: segment.noiseAmplification,
        tariffPerKwh: segment.tariffPerKwh,
        temperatureAtStart: segment.temperatureAtStart,
        cumulativeKwhAtStart: segment.cumulativeKwhAtStart,
        cumulativeCostAtStart: segment.cumulativeCostAtStart,
        poweredOnAt: segment.poweredOnAt
      })
      if (existing) {
        await tables
          .deviceStates(trx)
          .where({ assetId: params.assetId })
          .update(built.mirror)
      } else {
        // Two first events racing on a brand new asset: the loser simply
        // overwrites the mirror, its segment is recorded either way.
        await tables
          .deviceStates(trx)
          .insert(built.mirror)
          .onConflict('assetId')
          .merge()
      }
      return built
    })

// ---- device commands (audit log) -------------------------------------------

export const insertDeviceCommandFactory =
  (deps: { db: Knex }) => async (command: DeviceCommandRecord) => {
    const [row] = await tables.deviceCommands(deps.db).insert(command).returning('*')
    return row
  }
