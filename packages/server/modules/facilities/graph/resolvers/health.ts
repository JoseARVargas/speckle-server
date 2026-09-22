import { db } from '@/db/knex'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { BadRequestError, NotFoundError } from '@/modules/shared/errors'
import { getAnthropicApiKey } from '@/modules/shared/helpers/envHelper'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { assertCanManageFacility } from '@/modules/facilities/graph/resolvers/facilities'
import { ensureFacilityFactory } from '@/modules/facilities/services/facilities'
import { setDeviceFaultProfileFactory } from '@/modules/facilities/services/simulation'
import { generateMaintenanceReportFactory } from '@/modules/facilities/services/maintenanceReport'
import {
  getAssetByIdFactory,
  listAssetsFactory
} from '@/modules/facilities/repositories/facilities'
import {
  listHealthSignalsByAssetFactory,
  listHealthSignalsByFacilityFactory,
  listMaintenanceReportsByAssetFactory,
  listMaintenanceReportsByFacilityFactory
} from '@/modules/facilities/repositories/health'

function assertUnitInterval(value: number | null | undefined, field: string) {
  if (value === null || value === undefined) return
  if (value < 0 || value > 1) {
    throw new BadRequestError(`${field} must be between 0 and 1`)
  }
}

const healthMutations = {
  async setDeviceFaultProfile(
    _parent: unknown,
    args: {
      input: {
        assetId: string
        degradationRate?: number | null
        startupCurrentDecay?: number | null
        noiseAmplification?: number | null
      }
    },
    ctx: GraphQLContext
  ) {
    const { assetId, degradationRate, startupCurrentDecay, noiseAmplification } =
      args.input
    assertUnitInterval(degradationRate, 'degradationRate')
    assertUnitInterval(startupCurrentDecay, 'startupCurrentDecay')
    if (
      noiseAmplification !== null &&
      noiseAmplification !== undefined &&
      noiseAmplification < 0
    ) {
      throw new BadRequestError('noiseAmplification must be >= 0')
    }
    const asset = await getAssetByIdFactory({ db })({ id: assetId })
    if (!asset) throw new NotFoundError('Asset not found')
    await assertCanManageFacility(ctx, asset.projectId)
    const projectDb = await getProjectDbClient({ projectId: asset.projectId })
    return await setDeviceFaultProfileFactory({ db: projectDb })({
      assetId,
      projectId: asset.projectId,
      degradationRate,
      startupCurrentDecay,
      noiseAmplification
    })
  },

  async generateMaintenanceReport(
    _parent: unknown,
    args: { projectId: string; assetId?: string | null },
    ctx: GraphQLContext
  ) {
    const { projectId, assetId } = args
    await assertCanManageFacility(ctx, projectId)
    const projectDb = await getProjectDbClient({ projectId })
    const facility = await ensureFacilityFactory({ db: projectDb })({ projectId })
    return await generateMaintenanceReportFactory({
      db: projectDb,
      anthropicApiKey: getAnthropicApiKey()
    })({
      projectId,
      facilityId: facility.id,
      assetId: assetId ?? null,
      userId: ctx.userId ?? null
    })
  }
}

export default {
  Asset: {
    async healthSignals(parent: { id: string; projectId: string }) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listHealthSignalsByAssetFactory({ db: projectDb })({
        assetId: parent.id
      })
    },
    async maintenanceReports(
      parent: { id: string; projectId: string },
      args: { limit?: number | null }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listMaintenanceReportsByAssetFactory({ db: projectDb })({
        assetId: parent.id,
        limit: args.limit ?? 10
      })
    }
  },

  Facility: {
    async healthSignals(parent: { id: string; projectId: string }) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      const assets = await listAssetsFactory({ db: projectDb })({
        facilityId: parent.id,
        limit: 500
      })
      return await listHealthSignalsByFacilityFactory({ db: projectDb })({
        assetIds: assets.map((a) => a.id)
      })
    },
    async maintenanceReports(
      parent: { id: string; projectId: string },
      args: { limit?: number | null }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listMaintenanceReportsByFacilityFactory({ db: projectDb })({
        facilityId: parent.id,
        limit: args.limit ?? 10,
        assetWide: true
      })
    }
  },

  MaintenanceReport: {
    async asset(parent: { assetId: string | null; projectId: string }) {
      if (!parent.assetId) return null
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await getAssetByIdFactory({ db: projectDb })({ id: parent.assetId })
    }
  },

  Mutation: {
    healthMutations: () => ({})
  },
  HealthMutations: {
    ...healthMutations
  }
}
