import { db } from '@/db/knex'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { NotFoundError } from '@/modules/shared/errors'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { assertCanManageFacility } from '@/modules/facilities/graph/resolvers/facilities'
import { ensureFacilityFactory, newId } from '@/modules/facilities/services/facilities'
import { getAssetByIdFactory } from '@/modules/facilities/repositories/facilities'
import {
  listMaintenanceOrdersFactory,
  countMaintenanceOrdersFactory,
  getMaintenanceOrderByIdFactory,
  insertMaintenanceOrderFactory,
  updateMaintenanceOrderFactory,
  deleteMaintenanceOrderFactory
} from '@/modules/facilities/repositories/maintenance'
import type {
  MaintenanceOrderPriority,
  MaintenanceOrderStatus,
  MaintenanceOrderType
} from '@/modules/facilities/helpers/types'

const maintenanceMutations = {
  async create(
    _parent: unknown,
    args: {
      input: {
        projectId: string
        assetId?: string | null
        title: string
        description?: string | null
        type: MaintenanceOrderType
        priority?: MaintenanceOrderPriority | null
        assignedTo?: string | null
        dueDate?: Date | null
      }
    },
    ctx: GraphQLContext
  ) {
    const {
      projectId,
      assetId,
      title,
      description,
      type,
      priority,
      assignedTo,
      dueDate
    } = args.input
    await assertCanManageFacility(ctx, projectId)
    const projectDb = await getProjectDbClient({ projectId })
    const facility = await ensureFacilityFactory({ db: projectDb })({ projectId })
    return await insertMaintenanceOrderFactory({ db: projectDb })({
      id: newId(),
      projectId,
      facilityId: facility.id,
      assetId: assetId ?? null,
      title,
      description: description ?? null,
      type,
      status: 'open',
      priority: priority ?? null,
      reportedBy: ctx.userId ?? null,
      assignedTo: assignedTo ?? null,
      dueDate: dueDate ?? null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  },

  async update(
    _parent: unknown,
    args: {
      input: {
        id: string
        title?: string | null
        description?: string | null
        type?: MaintenanceOrderType | null
        status?: MaintenanceOrderStatus | null
        priority?: MaintenanceOrderPriority | null
        assetId?: string | null
        assignedTo?: string | null
        dueDate?: Date | null
      }
    },
    ctx: GraphQLContext
  ) {
    const {
      id,
      title,
      description,
      type,
      status,
      priority,
      assetId,
      assignedTo,
      dueDate
    } = args.input
    const order = await getMaintenanceOrderByIdFactory({ db })({ id })
    if (!order) throw new NotFoundError('Maintenance order not found')
    await assertCanManageFacility(ctx, order.projectId)
    const projectDb = await getProjectDbClient({ projectId: order.projectId })
    return await updateMaintenanceOrderFactory({ db: projectDb })({
      id,
      update: {
        ...(title !== undefined && title !== null ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(type !== undefined && type !== null ? { type } : {}),
        ...(status !== undefined && status !== null
          ? {
              status,
              // Stamp/clear completedAt to match the status transition,
              // instead of leaving it stale from a previous "done".
              completedAt: status === 'done' ? new Date() : null
            }
          : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(assetId !== undefined ? { assetId } : {}),
        ...(assignedTo !== undefined ? { assignedTo } : {}),
        ...(dueDate !== undefined ? { dueDate } : {})
      }
    })
  },

  async delete(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const order = await getMaintenanceOrderByIdFactory({ db })({ id: args.id })
    if (!order) throw new NotFoundError('Maintenance order not found')
    await assertCanManageFacility(ctx, order.projectId)
    const projectDb = await getProjectDbClient({ projectId: order.projectId })
    await deleteMaintenanceOrderFactory({ db: projectDb })({ id: args.id })
    return true
  }
}

export default {
  Facility: {
    async maintenanceOrders(
      parent: { id: string; projectId: string },
      args: {
        input?: {
          limit?: number | null
          cursor?: string | null
          status?: MaintenanceOrderStatus | null
          type?: MaintenanceOrderType | null
          assetId?: string | null
        } | null
      }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      const params = {
        facilityId: parent.id,
        limit: args.input?.limit ?? 25,
        cursor: args.input?.cursor,
        status: args.input?.status,
        type: args.input?.type,
        assetId: args.input?.assetId
      }
      const [items, totalCount] = await Promise.all([
        listMaintenanceOrdersFactory({ db: projectDb })(params),
        countMaintenanceOrdersFactory({ db: projectDb })(params)
      ])
      return {
        items,
        totalCount,
        cursor: items.length ? items[items.length - 1].id : null
      }
    }
  },

  MaintenanceOrder: {
    async asset(parent: { assetId: string | null; projectId: string }) {
      if (!parent.assetId) return null
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return await getAssetByIdFactory({ db: projectDb })({ id: parent.assetId })
    }
  },

  Mutation: {
    maintenanceMutations: () => ({})
  },
  MaintenanceMutations: {
    ...maintenanceMutations
  }
}
