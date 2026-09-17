import {
  Facilities,
  Floors,
  Spaces,
  AssetTypes,
  AssetSystems,
  Assets,
  AssetSystemMembers,
  DeviceStates
} from '@/modules/core/dbSchema'
import type {
  FacilityRecord,
  FloorRecord,
  SpaceRecord,
  AssetTypeRecord,
  AssetSystemRecord,
  AssetRecord
} from '@/modules/facilities/helpers/types'
import type { Knex } from 'knex'

const tables = {
  facilities: (db: Knex) => db<FacilityRecord>(Facilities.name),
  floors: (db: Knex) => db<FloorRecord>(Floors.name),
  spaces: (db: Knex) => db<SpaceRecord>(Spaces.name),
  assetTypes: (db: Knex) => db<AssetTypeRecord>(AssetTypes.name),
  assetSystems: (db: Knex) => db<AssetSystemRecord>(AssetSystems.name),
  assets: (db: Knex) => db<AssetRecord>(Assets.name),
  assetSystemMembers: (db: Knex) => db(AssetSystemMembers.name)
}

// ---- facilities ---------------------------------------------------------

export const getFacilityByProjectIdFactory =
  (deps: { db: Knex }) => (params: { projectId: string }) =>
    tables.facilities(deps.db).where({ projectId: params.projectId }).first()

export const getFacilityByIdFactory =
  (deps: { db: Knex }) => (params: { id: string }) =>
    tables.facilities(deps.db).where({ id: params.id }).first()

export const upsertFacilityFactory =
  (deps: { db: Knex }) =>
  async (facility: FacilityRecord): Promise<FacilityRecord> => {
    const [row] = await tables
      .facilities(deps.db)
      .insert(facility)
      .onConflict('projectId')
      .merge({ updatedAt: new Date() })
      .returning('*')
    return row
  }

export const updateFacilityFactory =
  (deps: { db: Knex }) =>
  async (params: { id: string; update: Partial<FacilityRecord> }) => {
    const [row] = await tables
      .facilities(deps.db)
      .where({ id: params.id })
      .update({ ...params.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

// ---- floors ---------------------------------------------------------------

export const listFloorsFactory =
  (deps: { db: Knex }) => (params: { facilityId: string }) =>
    tables
      .floors(deps.db)
      .where({ facilityId: params.facilityId })
      .orderBy('elevationZ', 'asc')

export const getFloorByIdFactory = (deps: { db: Knex }) => (params: { id: string }) =>
  tables.floors(deps.db).where({ id: params.id }).first()

export const insertFloorFactory =
  (deps: { db: Knex }) => async (floor: FloorRecord) => {
    const [row] = await tables.floors(deps.db).insert(floor).returning('*')
    return row
  }

export const updateFloorFactory =
  (deps: { db: Knex }) =>
  async (params: { id: string; update: Partial<FloorRecord> }) => {
    const [row] = await tables
      .floors(deps.db)
      .where({ id: params.id })
      .update({ ...params.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

export const deleteFloorFactory = (deps: { db: Knex }) => (params: { id: string }) =>
  tables.floors(deps.db).where({ id: params.id }).del()

// ---- spaces ---------------------------------------------------------------

export const listSpacesFactory =
  (deps: { db: Knex }) => (params: { facilityId: string; floorId?: string }) => {
    const q = tables.spaces(deps.db).where({ facilityId: params.facilityId })
    if (params.floorId) q.andWhere({ floorId: params.floorId })
    return q.orderBy('name', 'asc')
  }

export const getSpaceByIdFactory = (deps: { db: Knex }) => (params: { id: string }) =>
  tables.spaces(deps.db).where({ id: params.id }).first()

export const insertSpaceFactory =
  (deps: { db: Knex }) => async (space: SpaceRecord) => {
    const [row] = await tables.spaces(deps.db).insert(space).returning('*')
    return row
  }

export const updateSpaceFactory =
  (deps: { db: Knex }) =>
  async (params: { id: string; update: Partial<SpaceRecord> }) => {
    const [row] = await tables
      .spaces(deps.db)
      .where({ id: params.id })
      .update({ ...params.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

export const deleteSpaceFactory = (deps: { db: Knex }) => (params: { id: string }) =>
  tables.spaces(deps.db).where({ id: params.id }).del()

// ---- asset types (global catalog) ------------------------------------------

export const listAssetTypesFactory =
  (deps: { db: Knex }) =>
  (params: { limit: number; cursor?: string | null; search?: string | null }) => {
    const q = tables.assetTypes(deps.db).orderBy('name', 'asc').limit(params.limit)
    if (params.search) q.andWhereILike('name', `%${params.search}%`)
    if (params.cursor) q.andWhere('id', '>', params.cursor)
    return q
  }

export const countAssetTypesFactory =
  (deps: { db: Knex }) => async (params: { search?: string | null }) => {
    const q = tables.assetTypes(deps.db)
    if (params.search) q.andWhereILike('name', `%${params.search}%`)
    const [{ count }] = await q.count()
    return parseInt(count + '')
  }

export const getAssetTypeByIdFactory =
  (deps: { db: Knex }) => (params: { id: string }) =>
    tables.assetTypes(deps.db).where({ id: params.id }).first()

export const insertAssetTypeFactory =
  (deps: { db: Knex }) => async (assetType: AssetTypeRecord) => {
    const [row] = await tables.assetTypes(deps.db).insert(assetType).returning('*')
    return row
  }

export const updateAssetTypeFactory =
  (deps: { db: Knex }) =>
  async (params: { id: string; update: Partial<AssetTypeRecord> }) => {
    const [row] = await tables
      .assetTypes(deps.db)
      .where({ id: params.id })
      .update({ ...params.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

export const deleteAssetTypeFactory =
  (deps: { db: Knex }) => (params: { id: string }) =>
    tables.assetTypes(deps.db).where({ id: params.id }).del()

// ---- asset systems ----------------------------------------------------------

export const listAssetSystemsFactory =
  (deps: { db: Knex }) => (params: { facilityId: string }) =>
    tables
      .assetSystems(deps.db)
      .where({ facilityId: params.facilityId })
      .orderBy('name', 'asc')

export const getAssetSystemByIdFactory =
  (deps: { db: Knex }) => (params: { id: string }) =>
    tables.assetSystems(deps.db).where({ id: params.id }).first()

export const insertAssetSystemFactory =
  (deps: { db: Knex }) => async (system: AssetSystemRecord) => {
    const [row] = await tables.assetSystems(deps.db).insert(system).returning('*')
    return row
  }

export const updateAssetSystemFactory =
  (deps: { db: Knex }) =>
  async (params: { id: string; update: Partial<AssetSystemRecord> }) => {
    const [row] = await tables
      .assetSystems(deps.db)
      .where({ id: params.id })
      .update({ ...params.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

export const deleteAssetSystemFactory =
  (deps: { db: Knex }) => (params: { id: string }) =>
    tables.assetSystems(deps.db).where({ id: params.id }).del()

export const listSystemsForAssetFactory =
  (deps: { db: Knex }) =>
  (params: { assetId: string }): Promise<AssetSystemRecord[]> =>
    tables
      .assetSystems(deps.db)
      .join(
        AssetSystemMembers.name,
        `${AssetSystemMembers.name}.systemId`,
        `${AssetSystems.name}.id`
      )
      .where(`${AssetSystemMembers.name}.assetId`, params.assetId)
      .select<AssetSystemRecord[]>(`${AssetSystems.name}.*`)

// ---- assets (COBie Component) ----------------------------------------------

export const listAssetsFactory =
  (deps: { db: Knex }) =>
  (params: {
    facilityId: string
    limit: number
    cursor?: string | null
    spaceId?: string | null
    systemId?: string | null
    search?: string | null
  }) => {
    const q = tables.assets(deps.db).where({ facilityId: params.facilityId })
    if (params.spaceId) q.andWhere({ spaceId: params.spaceId })
    if (params.search) {
      q.andWhere((b) => {
        b.whereILike('tagNumber', `%${params.search}%`).orWhereILike(
          'name',
          `%${params.search}%`
        )
      })
    }
    if (params.systemId) {
      q.whereIn('id', (sub) =>
        sub
          .from(AssetSystemMembers.name)
          .select('assetId')
          .where('systemId', params.systemId)
      )
    }
    if (params.cursor) q.andWhere('id', '>', params.cursor)
    return q.orderBy('tagNumber', 'asc').limit(params.limit)
  }

export const countAssetsFactory =
  (deps: { db: Knex }) =>
  async (params: {
    facilityId: string
    spaceId?: string | null
    systemId?: string | null
    search?: string | null
  }) => {
    const q = tables.assets(deps.db).where({ facilityId: params.facilityId })
    if (params.spaceId) q.andWhere({ spaceId: params.spaceId })
    if (params.search) {
      q.andWhere((b) => {
        b.whereILike('tagNumber', `%${params.search}%`).orWhereILike(
          'name',
          `%${params.search}%`
        )
      })
    }
    if (params.systemId) {
      q.whereIn('id', (sub) =>
        sub
          .from(AssetSystemMembers.name)
          .select('assetId')
          .where('systemId', params.systemId)
      )
    }
    const [{ count }] = await q.count()
    return parseInt(count + '')
  }

export const getAssetByIdFactory = (deps: { db: Knex }) => (params: { id: string }) =>
  tables.assets(deps.db).where({ id: params.id }).first()

export const getAssetByTagFactory =
  (deps: { db: Knex }) => (params: { facilityId: string; tagNumber: string }) =>
    tables
      .assets(deps.db)
      .where({ facilityId: params.facilityId, tagNumber: params.tagNumber })
      .first()

export const insertAssetFactory =
  (deps: { db: Knex }) => async (asset: AssetRecord) => {
    const [row] = await tables.assets(deps.db).insert(asset).returning('*')
    return row
  }

export const updateAssetFactory =
  (deps: { db: Knex }) =>
  async (params: { id: string; update: Partial<AssetRecord> }) => {
    const [row] = await tables
      .assets(deps.db)
      .where({ id: params.id })
      .update({ ...params.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

export const deleteAssetFactory = (deps: { db: Knex }) => (params: { id: string }) =>
  tables.assets(deps.db).where({ id: params.id }).del()

/**
 * Per-system rollup of simulated energy for the dashboard - how much of a
 * facility's consumption/cost is attributable to each System sheet, plus
 * how many assets it currently has. Left-joins device_states since not
 * every asset has been turned on yet.
 */
export const getSystemEnergyBreakdownFactory =
  (deps: { db: Knex }) =>
  async (params: {
    facilityId: string
  }): Promise<
    {
      systemId: string
      systemName: string
      assetCount: number
      cumulativeKwh: number
      cumulativeCost: number
    }[]
  > => {
    const rows = await tables
      .assetSystems(deps.db)
      .where(`${AssetSystems.name}.facilityId`, params.facilityId)
      .join(
        AssetSystemMembers.name,
        `${AssetSystemMembers.name}.systemId`,
        `${AssetSystems.name}.id`
      )
      .leftJoin(
        DeviceStates.name,
        `${DeviceStates.name}.assetId`,
        `${AssetSystemMembers.name}.assetId`
      )
      .groupBy(`${AssetSystems.name}.id`, `${AssetSystems.name}.name`)
      .select<
        {
          systemId: string
          systemName: string
          assetCount: string
          cumulativeKwh: string
          cumulativeCost: string
        }[]
      >(
        `${AssetSystems.name}.id as systemId`,
        `${AssetSystems.name}.name as systemName`,
        deps.db.raw(
          `COUNT(DISTINCT "${AssetSystemMembers.name}"."assetId") as "assetCount"`
        ),
        deps.db.raw(
          `COALESCE(SUM("${DeviceStates.name}"."cumulativeKwh"), 0) as "cumulativeKwh"`
        ),
        deps.db.raw(
          `COALESCE(SUM("${DeviceStates.name}"."cumulativeCost"), 0) as "cumulativeCost"`
        )
      )
    return rows.map((r) => ({
      systemId: r.systemId,
      systemName: r.systemName,
      assetCount: parseInt(r.assetCount),
      cumulativeKwh: Number(r.cumulativeKwh),
      cumulativeCost: Number(r.cumulativeCost)
    }))
  }

// ---- asset <-> system membership -------------------------------------------

export const setAssetSystemsFactory =
  (deps: { db: Knex }) => async (params: { assetId: string; systemIds: string[] }) => {
    await deps.db.transaction(async (trx) => {
      await trx(AssetSystemMembers.name).where({ assetId: params.assetId }).del()
      if (params.systemIds.length) {
        await trx(AssetSystemMembers.name).insert(
          params.systemIds.map((systemId) => ({ assetId: params.assetId, systemId }))
        )
      }
    })
  }
