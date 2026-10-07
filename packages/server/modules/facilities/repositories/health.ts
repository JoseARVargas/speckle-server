import { MaintenanceReports } from '@/modules/core/dbSchema'
import type { MaintenanceReportRecord } from '@/modules/facilities/helpers/types'
import type { Knex } from 'knex'

const tables = {
  maintenanceReports: (db: Knex) => db<MaintenanceReportRecord>(MaintenanceReports.name)
}

// ---- maintenance reports --------------------------------------------------

export const insertMaintenanceReportFactory =
  (deps: { db: Knex }) => async (report: MaintenanceReportRecord) => {
    const [row] = await tables.maintenanceReports(deps.db).insert(report).returning('*')
    return row
  }

export const listMaintenanceReportsByAssetFactory =
  (deps: { db: Knex }) => (params: { assetId: string; limit: number }) =>
    tables
      .maintenanceReports(deps.db)
      .where({ assetId: params.assetId })
      .orderBy('generatedAt', 'desc')
      .limit(params.limit)

export const listMaintenanceReportsByFacilityFactory =
  (deps: { db: Knex }) =>
  (params: { facilityId: string; limit: number; assetWide?: boolean }) => {
    const q = tables
      .maintenanceReports(deps.db)
      .where({ facilityId: params.facilityId })
    if (params.assetWide) q.whereNull('assetId')
    return q.orderBy('generatedAt', 'desc').limit(params.limit)
  }
