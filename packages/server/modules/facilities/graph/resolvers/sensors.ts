import { db } from '@/db/knex'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { NotFoundError } from '@/modules/shared/errors'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { assertCanManageFacility } from '@/modules/facilities/graph/resolvers/facilities'
import { ensureFacilityFactory, newId } from '@/modules/facilities/services/facilities'
import { generateSensorApiKey } from '@/modules/facilities/services/sensors'
import {
  getAssetByIdFactory,
  getSpaceByIdFactory
} from '@/modules/facilities/repositories/facilities'
import {
  listSensorsFactory,
  countSensorsFactory,
  getSensorByIdFactory,
  insertSensorFactory,
  updateSensorFactory,
  deleteSensorFactory,
  listSensorReadingsFactory
} from '@/modules/facilities/repositories/sensors'
import type { SensorStatus, SensorType } from '@/modules/facilities/helpers/types'

const sensorMutations = {
  async create(
    _parent: unknown,
    args: {
      input: {
        projectId: string
        name: string
        type: SensorType
        unit?: string | null
        manufacturer?: string | null
        model?: string | null
        serialNumber?: string | null
        assetId?: string | null
        spaceId?: string | null
      }
    },
    ctx: GraphQLContext
  ) {
    const {
      projectId,
      name,
      type,
      unit,
      manufacturer,
      model,
      serialNumber,
      assetId,
      spaceId
    } = args.input
    await assertCanManageFacility(ctx, projectId)
    const projectDb = await getProjectDbClient({ projectId })
    const facility = await ensureFacilityFactory({ db: projectDb })({ projectId })
    const { apiKey, apiKeyHash } = await generateSensorApiKey()
    const sensor = await insertSensorFactory({ db: projectDb })({
      id: newId(),
      projectId,
      facilityId: facility.id,
      assetId: assetId ?? null,
      spaceId: spaceId ?? null,
      name,
      type,
      unit: unit ?? null,
      manufacturer: manufacturer ?? null,
      model: model ?? null,
      serialNumber: serialNumber ?? null,
      status: 'active',
      apiKeyHash,
      lastReadingValue: null,
      lastReadingAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    return { sensor, apiKey }
  },

  async update(
    _parent: unknown,
    args: {
      input: {
        id: string
        name?: string | null
        type?: SensorType | null
        unit?: string | null
        manufacturer?: string | null
        model?: string | null
        serialNumber?: string | null
        status?: SensorStatus | null
        assetId?: string | null
        spaceId?: string | null
      }
    },
    ctx: GraphQLContext
  ) {
    const {
      id,
      name,
      type,
      unit,
      manufacturer,
      model,
      serialNumber,
      status,
      assetId,
      spaceId
    } = args.input
    const sensor = await getSensorByIdFactory({ db })({ id })
    if (!sensor) throw new NotFoundError('Sensor not found')
    await assertCanManageFacility(ctx, sensor.projectId)
    const projectDb = await getProjectDbClient({ projectId: sensor.projectId })
    return await updateSensorFactory({ db: projectDb })({
      id,
      update: {
        ...(name !== undefined && name !== null ? { name } : {}),
        ...(type !== undefined && type !== null ? { type } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(manufacturer !== undefined ? { manufacturer } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(serialNumber !== undefined ? { serialNumber } : {}),
        ...(status !== undefined && status !== null ? { status } : {}),
        ...(assetId !== undefined ? { assetId } : {}),
        ...(spaceId !== undefined ? { spaceId } : {})
      }
    })
  },

  async regenerateApiKey(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const sensor = await getSensorByIdFactory({ db })({ id: args.id })
    if (!sensor) throw new NotFoundError('Sensor not found')
    await assertCanManageFacility(ctx, sensor.projectId)
    const projectDb = await getProjectDbClient({ projectId: sensor.projectId })
    const { apiKey, apiKeyHash } = await generateSensorApiKey()
    const updated = await updateSensorFactory({ db: projectDb })({
      id: args.id,
      update: { apiKeyHash }
    })
    return { sensor: updated, apiKey }
  },

  async delete(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const sensor = await getSensorByIdFactory({ db })({ id: args.id })
    if (!sensor) throw new NotFoundError('Sensor not found')
    await assertCanManageFacility(ctx, sensor.projectId)
    const projectDb = await getProjectDbClient({ projectId: sensor.projectId })
    await deleteSensorFactory({ db: projectDb })({ id: args.id })
    return true
  }
}

export default {
  Facility: {
    async sensors(
      parent: { id: string; projectId: string },
      args: {
        input?: {
          limit?: number | null
          cursor?: string | null
          type?: SensorType | null
          status?: SensorStatus | null
          assetId?: string | null
          spaceId?: string | null
        } | null
      }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      const params = {
        facilityId: parent.id,
        limit: args.input?.limit ?? 50,
        cursor: args.input?.cursor,
        type: args.input?.type,
        status: args.input?.status,
        assetId: args.input?.assetId,
        spaceId: args.input?.spaceId
      }
      const [items, totalCount] = await Promise.all([
        listSensorsFactory({ db: projectDb })(params),
        countSensorsFactory({ db: projectDb })(params)
      ])
      return {
        items,
        totalCount,
        cursor: items.length ? items[items.length - 1].id : null
      }
    }
  },

  Sensor: {
    async asset(parent: { assetId: string | null; projectId: string }) {
      if (!parent.assetId) return null
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await getAssetByIdFactory({ db: projectDb })({ id: parent.assetId })
    },
    async space(parent: { spaceId: string | null; projectId: string }) {
      if (!parent.spaceId) return null
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await getSpaceByIdFactory({ db: projectDb })({ id: parent.spaceId })
    },
    async readings(
      parent: { id: string; projectId: string },
      args: { limit?: number | null }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await listSensorReadingsFactory({ db: projectDb })({
        sensorId: parent.id,
        limit: args.limit ?? 100
      })
    }
  },

  Mutation: {
    sensorMutations: () => ({})
  },
  SensorMutations: {
    ...sensorMutations
  }
}
