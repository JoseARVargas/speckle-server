import { db } from '@/db/knex'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { ForbiddenError, NotFoundError } from '@/modules/shared/errors'
import { throwIfAuthNotOk } from '@/modules/shared/helpers/errorHelper'
import { throwIfResourceAccessNotAllowed } from '@/modules/core/helpers/token'
import { TokenResourceIdentifierType } from '@/modules/core/domain/tokens/types'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { ensureFacilityFactory, newId } from '@/modules/facilities/services/facilities'
import {
  getFacilityByProjectIdFactory,
  updateFacilityFactory,
  listFloorsFactory,
  getFloorByIdFactory,
  insertFloorFactory,
  updateFloorFactory,
  deleteFloorFactory,
  listSpacesFactory,
  getSpaceByIdFactory,
  insertSpaceFactory,
  updateSpaceFactory,
  deleteSpaceFactory,
  listAssetTypesFactory,
  countAssetTypesFactory,
  getAssetTypeByIdFactory,
  insertAssetTypeFactory,
  updateAssetTypeFactory,
  deleteAssetTypeFactory,
  listAssetSystemsFactory,
  getAssetSystemByIdFactory,
  insertAssetSystemFactory,
  updateAssetSystemFactory,
  deleteAssetSystemFactory,
  listSystemsForAssetFactory,
  listAssetsFactory,
  countAssetsFactory,
  getAssetByIdFactory,
  insertAssetFactory,
  updateAssetFactory,
  deleteAssetFactory,
  setAssetSystemsFactory
} from '@/modules/facilities/repositories/facilities'
import {
  getDeviceStateFactory,
  listTelemetryReadingsFactory,
  listEnergyReadingsFactory
} from '@/modules/facilities/repositories/simulation'
import {
  setAssetPowerFactory,
  setAssetTemperatureFactory
} from '@/modules/facilities/services/simulation'
import type { DevicePowerState } from '@/modules/facilities/helpers/types'

/**
 * All facility-registry mutations take a projectId and are gated the same
 * way file import mutations are: needs a user, needs token access to this
 * specific project, needs publish rights on it.
 */
async function assertCanManageFacility(ctx: GraphQLContext, projectId: string) {
  if (!ctx.userId) {
    throw new ForbiddenError('No userId provided')
  }
  throwIfResourceAccessNotAllowed({
    resourceId: projectId,
    resourceType: TokenResourceIdentifierType.Project,
    resourceAccessRules: ctx.resourceAccessRules
  })
  const canPublish = await ctx.authPolicies.project.canPublish({
    userId: ctx.userId,
    projectId
  })
  throwIfAuthNotOk(canPublish)
}

const facilityMutations = {
  async update(
    _parent: unknown,
    args: {
      input: {
        projectId: string
        name?: string | null
        tagSourceProperty?: string | null
        energyTariffPerKwh?: number | null
      }
    },
    ctx: GraphQLContext
  ) {
    const { projectId, name, tagSourceProperty, energyTariffPerKwh } = args.input
    await assertCanManageFacility(ctx, projectId)
    const projectDb = await getProjectDbClient({ projectId })
    await ensureFacilityFactory({ db: projectDb })({ projectId })
    const facility = await getFacilityByProjectIdFactory({ db: projectDb })({
      projectId
    })
    if (!facility) throw new NotFoundError('Facility not found')
    return await updateFacilityFactory({ db: projectDb })({
      id: facility.id,
      update: {
        ...(name !== undefined && name !== null ? { name } : {}),
        ...(tagSourceProperty !== undefined && tagSourceProperty !== null
          ? { tagSourceProperty }
          : {}),
        ...(energyTariffPerKwh !== undefined && energyTariffPerKwh !== null
          ? { energyTariffPerKwh }
          : {})
      }
    })
  },

  async createFloor(
    _parent: unknown,
    args: { input: { projectId: string; name: string; elevationZ?: number | null } },
    ctx: GraphQLContext
  ) {
    const { projectId, name, elevationZ } = args.input
    await assertCanManageFacility(ctx, projectId)
    const projectDb = await getProjectDbClient({ projectId })
    const facility = await ensureFacilityFactory({ db: projectDb })({ projectId })
    return await insertFloorFactory({ db: projectDb })({
      id: newId(),
      projectId,
      facilityId: facility.id,
      name,
      elevationZ: elevationZ ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  },

  async updateFloor(
    _parent: unknown,
    args: { input: { id: string; name?: string | null; elevationZ?: number | null } },
    ctx: GraphQLContext
  ) {
    const { id, name, elevationZ } = args.input
    const floor = await getFloorByIdFactory({ db })({ id })
    if (!floor) throw new NotFoundError('Floor not found')
    await assertCanManageFacility(ctx, floor.projectId)
    const projectDb = await getProjectDbClient({ projectId: floor.projectId })
    return await updateFloorFactory({ db: projectDb })({
      id,
      update: {
        ...(name !== undefined && name !== null ? { name } : {}),
        ...(elevationZ !== undefined ? { elevationZ } : {})
      }
    })
  },

  async deleteFloor(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const floor = await getFloorByIdFactory({ db })({ id: args.id })
    if (!floor) throw new NotFoundError('Floor not found')
    await assertCanManageFacility(ctx, floor.projectId)
    const projectDb = await getProjectDbClient({ projectId: floor.projectId })
    await deleteFloorFactory({ db: projectDb })({ id: args.id })
    return true
  },

  async createSpace(
    _parent: unknown,
    args: {
      input: {
        projectId: string
        name: string
        floorId?: string | null
        elevationZ?: number | null
        speckleObjectId?: string | null
      }
    },
    ctx: GraphQLContext
  ) {
    const { projectId, name, floorId, elevationZ, speckleObjectId } = args.input
    await assertCanManageFacility(ctx, projectId)
    const projectDb = await getProjectDbClient({ projectId })
    const facility = await ensureFacilityFactory({ db: projectDb })({ projectId })
    return await insertSpaceFactory({ db: projectDb })({
      id: newId(),
      projectId,
      facilityId: facility.id,
      floorId: floorId ?? null,
      name,
      elevationZ: elevationZ ?? null,
      speckleObjectId: speckleObjectId ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  },

  async updateSpace(
    _parent: unknown,
    args: {
      input: {
        id: string
        name?: string | null
        floorId?: string | null
        elevationZ?: number | null
        speckleObjectId?: string | null
      }
    },
    ctx: GraphQLContext
  ) {
    const { id, name, floorId, elevationZ, speckleObjectId } = args.input
    const space = await getSpaceByIdFactory({ db })({ id })
    if (!space) throw new NotFoundError('Space not found')
    await assertCanManageFacility(ctx, space.projectId)
    const projectDb = await getProjectDbClient({ projectId: space.projectId })
    return await updateSpaceFactory({ db: projectDb })({
      id,
      update: {
        ...(name !== undefined && name !== null ? { name } : {}),
        ...(floorId !== undefined ? { floorId } : {}),
        ...(elevationZ !== undefined ? { elevationZ } : {}),
        ...(speckleObjectId !== undefined ? { speckleObjectId } : {})
      }
    })
  },

  async deleteSpace(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const space = await getSpaceByIdFactory({ db })({ id: args.id })
    if (!space) throw new NotFoundError('Space not found')
    await assertCanManageFacility(ctx, space.projectId)
    const projectDb = await getProjectDbClient({ projectId: space.projectId })
    await deleteSpaceFactory({ db: projectDb })({ id: args.id })
    return true
  },

  async createSystem(
    _parent: unknown,
    args: { input: { projectId: string; name: string; description?: string | null } },
    ctx: GraphQLContext
  ) {
    const { projectId, name, description } = args.input
    await assertCanManageFacility(ctx, projectId)
    const projectDb = await getProjectDbClient({ projectId })
    const facility = await ensureFacilityFactory({ db: projectDb })({ projectId })
    return await insertAssetSystemFactory({ db: projectDb })({
      id: newId(),
      projectId,
      facilityId: facility.id,
      name,
      description: description ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  },

  async updateSystem(
    _parent: unknown,
    args: { input: { id: string; name?: string | null; description?: string | null } },
    ctx: GraphQLContext
  ) {
    const { id, name, description } = args.input
    const system = await getAssetSystemByIdFactory({ db })({ id })
    if (!system) throw new NotFoundError('System not found')
    await assertCanManageFacility(ctx, system.projectId)
    const projectDb = await getProjectDbClient({ projectId: system.projectId })
    return await updateAssetSystemFactory({ db: projectDb })({
      id,
      update: {
        ...(name !== undefined && name !== null ? { name } : {}),
        ...(description !== undefined ? { description } : {})
      }
    })
  },

  async deleteSystem(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const system = await getAssetSystemByIdFactory({ db })({ id: args.id })
    if (!system) throw new NotFoundError('System not found')
    await assertCanManageFacility(ctx, system.projectId)
    const projectDb = await getProjectDbClient({ projectId: system.projectId })
    await deleteAssetSystemFactory({ db: projectDb })({ id: args.id })
    return true
  },

  async createAsset(
    _parent: unknown,
    args: {
      input: {
        projectId: string
        tagNumber: string
        name?: string | null
        assetTypeId?: string | null
        spaceId?: string | null
        systemIds?: string[] | null
      }
    },
    ctx: GraphQLContext
  ) {
    const { projectId, tagNumber, name, assetTypeId, spaceId, systemIds } = args.input
    await assertCanManageFacility(ctx, projectId)
    const projectDb = await getProjectDbClient({ projectId })
    const facility = await ensureFacilityFactory({ db: projectDb })({ projectId })
    const asset = await insertAssetFactory({ db: projectDb })({
      id: newId(),
      projectId,
      facilityId: facility.id,
      tagNumber,
      name: name ?? null,
      assetTypeId: assetTypeId ?? null,
      spaceId: spaceId ?? null,
      currentObjectId: null,
      currentVersionId: null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    if (systemIds?.length) {
      await setAssetSystemsFactory({ db: projectDb })({ assetId: asset.id, systemIds })
    }
    return asset
  },

  async updateAsset(
    _parent: unknown,
    args: {
      input: {
        id: string
        tagNumber?: string | null
        name?: string | null
        assetTypeId?: string | null
        spaceId?: string | null
        systemIds?: string[] | null
      }
    },
    ctx: GraphQLContext
  ) {
    const { id, tagNumber, name, assetTypeId, spaceId, systemIds } = args.input
    const asset = await getAssetByIdFactory({ db })({ id })
    if (!asset) throw new NotFoundError('Asset not found')
    await assertCanManageFacility(ctx, asset.projectId)
    const projectDb = await getProjectDbClient({ projectId: asset.projectId })
    const updated = await updateAssetFactory({ db: projectDb })({
      id,
      update: {
        ...(tagNumber !== undefined && tagNumber !== null ? { tagNumber } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(assetTypeId !== undefined ? { assetTypeId } : {}),
        ...(spaceId !== undefined ? { spaceId } : {})
      }
    })
    if (systemIds !== undefined) {
      await setAssetSystemsFactory({ db: projectDb })({
        assetId: id,
        systemIds: systemIds ?? []
      })
    }
    return updated
  },

  async deleteAsset(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const asset = await getAssetByIdFactory({ db })({ id: args.id })
    if (!asset) throw new NotFoundError('Asset not found')
    await assertCanManageFacility(ctx, asset.projectId)
    const projectDb = await getProjectDbClient({ projectId: asset.projectId })
    await deleteAssetFactory({ db: projectDb })({ id: args.id })
    return true
  },

  async setAssetPower(
    _parent: unknown,
    args: { input: { assetId: string; powerState: DevicePowerState } },
    ctx: GraphQLContext
  ) {
    const { assetId, powerState } = args.input
    const asset = await getAssetByIdFactory({ db })({ id: assetId })
    if (!asset) throw new NotFoundError('Asset not found')
    await assertCanManageFacility(ctx, asset.projectId)
    const projectDb = await getProjectDbClient({ projectId: asset.projectId })
    return await setAssetPowerFactory({ db: projectDb })({
      assetId,
      projectId: asset.projectId,
      powerState,
      userId: ctx.userId ?? null
    })
  },

  async setAssetTemperature(
    _parent: unknown,
    args: { input: { assetId: string; setpoint: number } },
    ctx: GraphQLContext
  ) {
    const { assetId, setpoint } = args.input
    const asset = await getAssetByIdFactory({ db })({ id: assetId })
    if (!asset) throw new NotFoundError('Asset not found')
    await assertCanManageFacility(ctx, asset.projectId)
    const projectDb = await getProjectDbClient({ projectId: asset.projectId })
    return await setAssetTemperatureFactory({ db: projectDb })({
      assetId,
      projectId: asset.projectId,
      setpoint,
      userId: ctx.userId ?? null
    })
  }
}

const assetTypeMutations = {
  async create(
    _parent: unknown,
    args: {
      input: {
        name: string
        category?: string | null
        manufacturer?: string | null
        modelNumber?: string | null
        nature?: 'fixed' | 'movable' | null
        description?: string | null
        expectedLifeYears?: number | null
        extendedAttributes?: Record<string, unknown> | null
      }
    },
    ctx: GraphQLContext
  ) {
    const input = args.input
    return await insertAssetTypeFactory({ db })({
      id: newId(),
      name: input.name,
      category: input.category ?? null,
      manufacturer: input.manufacturer ?? null,
      modelNumber: input.modelNumber ?? null,
      nature: input.nature ?? null,
      description: input.description ?? null,
      expectedLifeYears: input.expectedLifeYears ?? null,
      extendedAttributes: input.extendedAttributes ?? {},
      createdBy: ctx.userId ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  },

  async update(
    _parent: unknown,
    args: {
      input: {
        id: string
        name?: string | null
        category?: string | null
        manufacturer?: string | null
        modelNumber?: string | null
        nature?: 'fixed' | 'movable' | null
        description?: string | null
        expectedLifeYears?: number | null
        extendedAttributes?: Record<string, unknown> | null
      }
    }
  ) {
    const { id, ...rest } = args.input
    const existing = await getAssetTypeByIdFactory({ db })({ id })
    if (!existing) throw new NotFoundError('AssetType not found')
    const update: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) update[key] = value
    }
    return await updateAssetTypeFactory({ db })({ id, update })
  },

  async delete(_parent: unknown, args: { id: string }) {
    await deleteAssetTypeFactory({ db })({ id: args.id })
    return true
  }
}

export default {
  Project: {
    async facility(parent: { id: string }) {
      const projectDb = await getProjectDbClient({ projectId: parent.id })
      const facility = await getFacilityByProjectIdFactory({ db: projectDb })({
        projectId: parent.id
      })
      return facility ?? null
    }
  },

  Facility: {
    async floors(parent: { id: string; projectId: string }) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listFloorsFactory({ db: projectDb })({ facilityId: parent.id })
    },
    async spaces(
      parent: { id: string; projectId: string },
      args: { input?: { floorId?: string | null } | null }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listSpacesFactory({ db: projectDb })({
        facilityId: parent.id,
        floorId: args.input?.floorId ?? undefined
      })
    },
    async systems(parent: { id: string; projectId: string }) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listAssetSystemsFactory({ db: projectDb })({ facilityId: parent.id })
    },
    async assets(
      parent: { id: string; projectId: string },
      args: {
        input?: {
          limit?: number | null
          cursor?: string | null
          spaceId?: string | null
          systemId?: string | null
          search?: string | null
        } | null
      }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      const params = {
        facilityId: parent.id,
        limit: args.input?.limit ?? 25,
        cursor: args.input?.cursor,
        spaceId: args.input?.spaceId,
        systemId: args.input?.systemId,
        search: args.input?.search
      }
      const [items, totalCount] = await Promise.all([
        listAssetsFactory({ db: projectDb })(params),
        countAssetsFactory({ db: projectDb })(params)
      ])
      return {
        items,
        totalCount,
        cursor: items.length ? items[items.length - 1].id : null
      }
    }
  },

  Floor: {
    async spaces(parent: { id: string; facilityId: string; projectId: string }) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listSpacesFactory({ db: projectDb })({
        facilityId: parent.facilityId,
        floorId: parent.id
      })
    }
  },

  Space: {
    async floor(parent: { floorId: string | null; projectId: string }) {
      if (!parent.floorId) return null
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await getFloorByIdFactory({ db: projectDb })({ id: parent.floorId })
    },
    async assets(
      parent: { id: string; projectId: string; facilityId: string },
      args: {
        input?: {
          limit?: number | null
          cursor?: string | null
          systemId?: string | null
          search?: string | null
        } | null
      }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      const params = {
        facilityId: parent.facilityId,
        spaceId: parent.id,
        limit: args.input?.limit ?? 25,
        cursor: args.input?.cursor,
        systemId: args.input?.systemId,
        search: args.input?.search
      }
      const [items, totalCount] = await Promise.all([
        listAssetsFactory({ db: projectDb })(params),
        countAssetsFactory({ db: projectDb })(params)
      ])
      return {
        items,
        totalCount,
        cursor: items.length ? items[items.length - 1].id : null
      }
    }
  },

  AssetSystem: {
    async assets(
      parent: { id: string; projectId: string; facilityId: string },
      args: {
        input?: {
          limit?: number | null
          cursor?: string | null
          spaceId?: string | null
          search?: string | null
        } | null
      }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      const params = {
        facilityId: parent.facilityId,
        systemId: parent.id,
        limit: args.input?.limit ?? 25,
        cursor: args.input?.cursor,
        spaceId: args.input?.spaceId,
        search: args.input?.search
      }
      const [items, totalCount] = await Promise.all([
        listAssetsFactory({ db: projectDb })(params),
        countAssetsFactory({ db: projectDb })(params)
      ])
      return {
        items,
        totalCount,
        cursor: items.length ? items[items.length - 1].id : null
      }
    }
  },

  Asset: {
    async assetType(parent: { assetTypeId: string | null }) {
      if (!parent.assetTypeId) return null
      return await getAssetTypeByIdFactory({ db })({ id: parent.assetTypeId })
    },
    async space(parent: { spaceId: string | null; projectId: string }) {
      if (!parent.spaceId) return null
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await getSpaceByIdFactory({ db: projectDb })({ id: parent.spaceId })
    },
    async systems(parent: { id: string; projectId: string }) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listSystemsForAssetFactory({ db: projectDb })({ assetId: parent.id })
    },
    async deviceState(parent: { id: string; projectId: string }) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      const state = await getDeviceStateFactory({ db: projectDb })({
        assetId: parent.id
      })
      return state ?? null
    },
    async telemetryHistory(
      parent: { id: string; projectId: string },
      args: { limit?: number | null }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listTelemetryReadingsFactory({ db: projectDb })({
        assetId: parent.id,
        limit: args.limit ?? 50
      })
    },
    async energyHistory(
      parent: { id: string; projectId: string },
      args: { limit?: number | null }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listEnergyReadingsFactory({ db: projectDb })({
        assetId: parent.id,
        limit: args.limit ?? 50
      })
    }
  },

  Query: {
    async assetTypes(
      _parent: unknown,
      args: { limit?: number | null; cursor?: string | null; search?: string | null }
    ) {
      const params = {
        limit: args.limit ?? 25,
        cursor: args.cursor,
        search: args.search
      }
      const [items, totalCount] = await Promise.all([
        listAssetTypesFactory({ db })(params),
        countAssetTypesFactory({ db })(params)
      ])
      return {
        items,
        totalCount,
        cursor: items.length ? items[items.length - 1].id : null
      }
    },
    async assetType(_parent: unknown, args: { id: string }) {
      const type = await getAssetTypeByIdFactory({ db })({ id: args.id })
      return type ?? null
    }
  },

  Mutation: {
    facilityMutations: () => ({}),
    assetTypeMutations: () => ({})
  },
  FacilityMutations: {
    ...facilityMutations
  },
  AssetTypeMutations: {
    ...assetTypeMutations
  }
}
