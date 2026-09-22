import { DeviceHealthSignals, MaintenanceReports } from '@/modules/core/dbSchema'
import type {
  DeviceHealthSignalRecord,
  HealthMetric,
  MaintenanceReportRecord
} from '@/modules/facilities/helpers/types'
import type { Knex } from 'knex'

const tables = {
  healthSignals: (db: Knex) => db<DeviceHealthSignalRecord>(DeviceHealthSignals.name),
  maintenanceReports: (db: Knex) => db<MaintenanceReportRecord>(MaintenanceReports.name)
}

// ---- health signals -----------------------------------------------------

export const listHealthSignalsByAssetFactory =
  (deps: { db: Knex }) => (params: { assetId: string }) =>
    tables
      .healthSignals(deps.db)
      .where({ assetId: params.assetId })
      .orderBy('metric', 'asc')

/**
 * Every signal for every asset in a facility, most-severe first - used for
 * the facility-wide health overview (and as the AI report's input when
 * generating a facility-level aggregate).
 */
export const listHealthSignalsByFacilityFactory =
  (deps: { db: Knex }) => (params: { assetIds: string[] }) => {
    if (!params.assetIds.length) return Promise.resolve([])
    const severityRank = `CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`
    return tables
      .healthSignals(deps.db)
      .whereIn('assetId', params.assetIds)
      .orderByRaw(severityRank)
  }

export const getHealthSignalFactory =
  (deps: { db: Knex }) => (params: { assetId: string; metric: HealthMetric }) =>
    tables
      .healthSignals(deps.db)
      .where({ assetId: params.assetId, metric: params.metric })
      .first()

/**
 * Keeps one row per (assetId, metric): `since` carries over from the
 * existing row when the severity hasn't changed (it's still the same
 * ongoing trend), and resets to now when it has (a fresh trend started).
 */
export const upsertHealthSignalFactory =
  (deps: { db: Knex }) =>
  async (
    signal: Omit<DeviceHealthSignalRecord, 'id' | 'since' | 'updatedAt'> & {
      id: string
    }
  ) => {
    const existing = await getHealthSignalFactory(deps)({
      assetId: signal.assetId,
      metric: signal.metric
    })
    const since =
      existing && existing.severity === signal.severity ? existing.since : new Date()
    if (existing) {
      const [row] = await tables
        .healthSignals(deps.db)
        .where({ assetId: signal.assetId, metric: signal.metric })
        .update({
          trend: signal.trend,
          severity: signal.severity,
          zScore: signal.zScore,
          since,
          updatedAt: new Date()
        })
        .returning('*')
      return row
    }
    const [row] = await tables
      .healthSignals(deps.db)
      .insert({ ...signal, since, updatedAt: new Date() })
      .returning('*')
    return row
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
