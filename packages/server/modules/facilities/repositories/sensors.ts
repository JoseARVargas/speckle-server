import { Sensors, SensorReadings } from '@/modules/core/dbSchema'
import type {
  SensorRecord,
  SensorReadingRecord,
  SensorStatus,
  SensorType
} from '@/modules/facilities/helpers/types'
import type { Knex } from 'knex'

const tables = {
  sensors: (db: Knex) => db<SensorRecord>(Sensors.name),
  sensorReadings: (db: Knex) => db<SensorReadingRecord>(SensorReadings.name)
}

// ---- sensors ----------------------------------------------------------

export const listSensorsFactory =
  (deps: { db: Knex }) =>
  (params: {
    facilityId: string
    limit: number
    cursor?: string | null
    type?: SensorType | null
    status?: SensorStatus | null
    assetId?: string | null
    spaceId?: string | null
  }) => {
    const q = tables.sensors(deps.db).where({ facilityId: params.facilityId })
    if (params.type) q.andWhere({ type: params.type })
    if (params.status) q.andWhere({ status: params.status })
    if (params.assetId) q.andWhere({ assetId: params.assetId })
    if (params.spaceId) q.andWhere({ spaceId: params.spaceId })
    if (params.cursor) q.andWhere('id', '>', params.cursor)
    return q.orderBy('name', 'asc').limit(params.limit)
  }

export const countSensorsFactory =
  (deps: { db: Knex }) =>
  async (params: {
    facilityId: string
    type?: SensorType | null
    status?: SensorStatus | null
    assetId?: string | null
    spaceId?: string | null
  }) => {
    const q = tables.sensors(deps.db).where({ facilityId: params.facilityId })
    if (params.type) q.andWhere({ type: params.type })
    if (params.status) q.andWhere({ status: params.status })
    if (params.assetId) q.andWhere({ assetId: params.assetId })
    if (params.spaceId) q.andWhere({ spaceId: params.spaceId })
    const [{ count }] = await q.count()
    return parseInt(count + '')
  }

export const getSensorByIdFactory = (deps: { db: Knex }) => (params: { id: string }) =>
  tables.sensors(deps.db).where({ id: params.id }).first()

export const insertSensorFactory =
  (deps: { db: Knex }) => async (sensor: SensorRecord) => {
    const [row] = await tables.sensors(deps.db).insert(sensor).returning('*')
    return row
  }

export const updateSensorFactory =
  (deps: { db: Knex }) =>
  async (params: { id: string; update: Partial<SensorRecord> }) => {
    const [row] = await tables
      .sensors(deps.db)
      .where({ id: params.id })
      .update({ ...params.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

export const deleteSensorFactory = (deps: { db: Knex }) => (params: { id: string }) =>
  tables.sensors(deps.db).where({ id: params.id }).del()

// ---- readings -----------------------------------------------------------

export const insertSensorReadingFactory =
  (deps: { db: Knex }) => (reading: Omit<SensorReadingRecord, 'id'>) =>
    tables.sensorReadings(deps.db).insert(reading)

export const listSensorReadingsFactory =
  (deps: { db: Knex }) => (params: { sensorId: string; limit: number }) =>
    tables
      .sensorReadings(deps.db)
      .where({ sensorId: params.sensorId })
      .orderBy('ts', 'desc')
      .limit(params.limit)
