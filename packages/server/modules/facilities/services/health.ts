import type { Knex } from 'knex'
import {
  listAssetSegmentsFactory,
  listProjectSegmentsFactory
} from '@/modules/facilities/repositories/simulation'
import type { HealthSignal } from '@/modules/facilities/services/simulationModel'
import {
  HEALTH_SINCE_MAX_TICKS,
  HEALTH_WINDOW_SIZE,
  healthSignalsAt,
  sortBySeverity,
  windowStartMs
} from '@/modules/facilities/services/simulationModel'

/**
 * Health signals computed on read from the simulated readings (moving
 * baseline z-score + trend, see simulationModel.classify): nothing is
 * stored, so they are always current. The window reaches back far enough
 * to find when the current severity started (capped at 2h).
 */
const lookbackTicks = HEALTH_SINCE_MAX_TICKS + HEALTH_WINDOW_SIZE

export const getAssetHealthSignalsFactory =
  (deps: { db: Knex }) =>
  async (params: { assetId: string; projectId: string }): Promise<HealthSignal[]> => {
    const nowMs = Date.now()
    const segments = await listAssetSegmentsFactory(deps)({
      assetId: params.assetId,
      from: new Date(windowStartMs(nowMs, lookbackTicks)),
      to: new Date(nowMs)
    })
    return healthSignalsAt({ ...params, segments, nowMs }).sort((a, b) =>
      a.metric.localeCompare(b.metric)
    )
  }

/** Every signal of the given assets of a project, most severe first. */
export const getFacilityHealthSignalsFactory =
  (deps: { db: Knex }) =>
  async (params: {
    projectId: string
    assetIds: string[]
  }): Promise<HealthSignal[]> => {
    if (!params.assetIds.length) return []
    const nowMs = Date.now()
    const byAsset = await listProjectSegmentsFactory(deps)({
      projectId: params.projectId,
      from: new Date(windowStartMs(nowMs, lookbackTicks)),
      to: new Date(nowMs)
    })
    const signals: HealthSignal[] = []
    for (const assetId of params.assetIds) {
      const segments = byAsset.get(assetId)
      if (!segments) continue
      signals.push(
        ...healthSignalsAt({ assetId, projectId: params.projectId, segments, nowMs })
      )
    }
    return sortBySeverity(signals)
  }
