import { MaintenanceOrders } from '@/modules/core/dbSchema'
import type {
  MaintenanceOrderRecord,
  MaintenanceOrderStatus,
  MaintenanceOrderType
} from '@/modules/facilities/helpers/types'
import type { Knex } from 'knex'

const tables = {
  maintenanceOrders: (db: Knex) => db<MaintenanceOrderRecord>(MaintenanceOrders.name)
}

export const listMaintenanceOrdersFactory =
  (deps: { db: Knex }) =>
  (params: {
    facilityId: string
    limit: number
    cursor?: string | null
    status?: MaintenanceOrderStatus | null
    type?: MaintenanceOrderType | null
    assetId?: string | null
  }) => {
    const q = tables.maintenanceOrders(deps.db).where({ facilityId: params.facilityId })
    if (params.status) q.andWhere({ status: params.status })
    if (params.type) q.andWhere({ type: params.type })
    if (params.assetId) q.andWhere({ assetId: params.assetId })
    if (params.cursor) q.andWhere('id', '>', params.cursor)
    return q.orderBy('createdAt', 'desc').limit(params.limit)
  }

export const countMaintenanceOrdersFactory =
  (deps: { db: Knex }) =>
  async (params: {
    facilityId: string
    status?: MaintenanceOrderStatus | null
    type?: MaintenanceOrderType | null
    assetId?: string | null
  }) => {
    const q = tables.maintenanceOrders(deps.db).where({ facilityId: params.facilityId })
    if (params.status) q.andWhere({ status: params.status })
    if (params.type) q.andWhere({ type: params.type })
    if (params.assetId) q.andWhere({ assetId: params.assetId })
    const [{ count }] = await q.count()
    return parseInt(count + '')
  }

export const getMaintenanceOrderByIdFactory =
  (deps: { db: Knex }) => (params: { id: string }) =>
    tables.maintenanceOrders(deps.db).where({ id: params.id }).first()

export const insertMaintenanceOrderFactory =
  (deps: { db: Knex }) => async (order: MaintenanceOrderRecord) => {
    const [row] = await tables.maintenanceOrders(deps.db).insert(order).returning('*')
    return row
  }

export const updateMaintenanceOrderFactory =
  (deps: { db: Knex }) =>
  async (params: { id: string; update: Partial<MaintenanceOrderRecord> }) => {
    const [row] = await tables
      .maintenanceOrders(deps.db)
      .where({ id: params.id })
      .update({ ...params.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

export const deleteMaintenanceOrderFactory =
  (deps: { db: Knex }) => (params: { id: string }) =>
    tables.maintenanceOrders(deps.db).where({ id: params.id }).del()
