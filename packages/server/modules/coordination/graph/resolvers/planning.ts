import { z } from 'zod'
import { db } from '@/db/knex'
import { Users } from '@/modules/core/dbSchema'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/modules/shared/errors'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { assertCanManageCoordination } from '@/modules/coordination/helpers/access'
import type { CoordRequirementRecord } from '@/modules/coordination/helpers/coordinationTypes'
import type {
  CoordDeliverableRecord,
  DeliverableFilter
} from '@/modules/coordination/helpers/planningTypes'
import {
  DeliverableStatuses,
  PLANNING_LIMITS
} from '@/modules/coordination/helpers/planningTypes'
import {
  getMilestoneFactory,
  getRequirementsByIdsFactory
} from '@/modules/coordination/repositories/coordination'
import {
  countDeliverablesFactory,
  deleteDeliverableFactory,
  getDeliverableByIdFactory,
  getDeliverableFactory,
  listDeliverablesFactory,
  listDeliverablesOfRequirementFactory,
  listDependencyIdsOfDeliverableFactory,
  listNamingCodesFactory,
  listRequirementIdsOfDeliverableFactory,
  updateDeliverableFactory
} from '@/modules/coordination/repositories/planning'
import {
  createDeliverableFactory,
  importDeliverablesFactory,
  setNamingCodesFactory,
  updateDeliverableServiceFactory
} from '@/modules/coordination/services/coordinationPlanning'
import {
  assertModelInProjectFactory,
  auditFactory
} from '@/modules/coordination/services/coordination'
import {
  listDocumentRevisionsFactory,
  listDocumentStatesFactory
} from '@/modules/coordination/repositories/documents'
import { deleteDocumentFilesFactory } from '@/modules/coordination/services/coordinationDocuments'
import {
  findModelDeliverableFactory,
  getModelCdeFactory,
  syncDeliverableStatusFactory
} from '@/modules/coordination/services/coordinationCde'

/**
 * Information delivery planning API (ISO 19650 MIDP/TIDP). Reads are nested
 * under Project.coordination (core already checked read access); every write
 * resolves the projectId from the stored record and goes through
 * assertCanManageCoordination (A01).
 */

type CoordParent = { projectId: string }

const audit = auditFactory({ db })

const requireUser = (ctx: GraphQLContext) => {
  if (!ctx.userId) throw new ForbiddenError('No userId provided')
  return ctx.userId
}

const statusSchema = z.enum(DeliverableStatuses)

/** Unknown filter values match nothing instead of being ignored. */
const toFilter = (args: {
  originator?: string | null
  role?: string | null
  milestoneId?: string | null
  status?: string | null
}): DeliverableFilter | null => {
  const status = args.status ? statusSchema.safeParse(args.status) : null
  if (status && !status.success) return null
  return {
    originator: args.originator?.trim().toUpperCase() || null,
    role: args.role?.trim().toUpperCase() || null,
    milestoneId: args.milestoneId || null,
    status: status?.data ?? null
  }
}

async function loadManagedDeliverable(ctx: GraphQLContext, id: string) {
  const deliverable = await getDeliverableByIdFactory({ db })({ id })
  if (!deliverable) throw new NotFoundError('Entregável não encontrado')
  await assertCanManageCoordination(ctx, deliverable.projectId)
  return deliverable
}

export default {
  ProjectCoordination: {
    namingCodes(parent: CoordParent) {
      return listNamingCodesFactory({ db })({ projectId: parent.projectId })
    },
    deliverables(
      parent: CoordParent,
      args: Parameters<typeof toFilter>[0] & {
        limit?: number | null
        offset?: number | null
      }
    ) {
      const filter = toFilter(args)
      if (!filter) return []
      return listDeliverablesFactory({ db })({
        projectId: parent.projectId,
        filter,
        limit: Math.min(
          Math.max(args.limit ?? 500, 1),
          PLANNING_LIMITS.maxDeliverablesPage
        ),
        offset: Math.max(args.offset ?? 0, 0)
      })
    },
    deliverableCount(parent: CoordParent, args: Parameters<typeof toFilter>[0]) {
      const filter = toFilter(args)
      if (!filter) return 0
      return countDeliverablesFactory({ db })({ projectId: parent.projectId, filter })
    },
    async deliverable(parent: CoordParent, args: { id: string }) {
      return (
        (await getDeliverableFactory({ db })({
          projectId: parent.projectId,
          id: args.id
        })) ?? null
      )
    }
  },

  CoordDeliverable: {
    async milestone(parent: CoordDeliverableRecord) {
      if (!parent.milestoneId) return null
      return (
        (await getMilestoneFactory({ db })({
          projectId: parent.projectId,
          id: parent.milestoneId
        })) ?? null
      )
    },
    async effectiveDueDate(parent: CoordDeliverableRecord) {
      if (parent.dueDate) return parent.dueDate
      if (!parent.milestoneId) return null
      const milestone = await getMilestoneFactory({ db })({
        projectId: parent.projectId,
        id: parent.milestoneId
      })
      return milestone?.dueDate ?? null
    },
    async responsibleName(parent: CoordDeliverableRecord) {
      if (!parent.responsibleUserId) return null
      const user = await db(Users.name)
        .where(Users.col.id, parent.responsibleUserId)
        .first<{ name: string } | undefined>(Users.col.name)
      return user?.name ?? null
    },
    dependsOnIds(parent: CoordDeliverableRecord) {
      return listDependencyIdsOfDeliverableFactory({ db })({ deliverableId: parent.id })
    },
    requirementIds(parent: CoordDeliverableRecord) {
      return listRequirementIdsOfDeliverableFactory({ db })({
        deliverableId: parent.id
      })
    },
    async requirements(parent: CoordDeliverableRecord) {
      const ids = await listRequirementIdsOfDeliverableFactory({ db })({
        deliverableId: parent.id
      })
      return getRequirementsByIdsFactory({ db })({ projectId: parent.projectId, ids })
    }
  },

  CoordRequirement: {
    deliverables(parent: CoordRequirementRecord) {
      return listDeliverablesOfRequirementFactory({ db })({
        projectId: parent.projectId,
        requirementId: parent.id
      })
    }
  },

  CoordinationMutations: {
    async setNamingCodes(
      _parent: unknown,
      args: { projectId: string; input: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      await assertCanManageCoordination(ctx, args.projectId)
      const codes = await setNamingCodesFactory({ db })({
        projectId: args.projectId,
        input: args.input
      })
      await audit({
        projectId: args.projectId,
        actorId: userId,
        action: 'naming_codes.updated',
        entityType: 'project',
        entityId: args.projectId,
        data: { count: codes.length }
      })
      return codes
    },

    async createDeliverable(
      _parent: unknown,
      args: { projectId: string; input: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      await assertCanManageCoordination(ctx, args.projectId)
      const projectDb = await getProjectDbClient({ projectId: args.projectId })
      const deliverable = await createDeliverableFactory({ db, projectDb })({
        projectId: args.projectId,
        userId,
        input: args.input
      })
      await audit({
        projectId: deliverable.projectId,
        actorId: userId,
        action: 'deliverable.created',
        entityType: 'deliverable',
        entityId: deliverable.id,
        data: { containerName: deliverable.containerName }
      })
      return deliverable
    },

    async updateDeliverable(
      _parent: unknown,
      args: { id: string; input: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const current = await loadManagedDeliverable(ctx, args.id)
      const projectDb = await getProjectDbClient({ projectId: current.projectId })
      const deliverable = await updateDeliverableServiceFactory({ db, projectDb })({
        current,
        input: args.input
      })
      await audit({
        projectId: deliverable.projectId,
        actorId: userId,
        action: 'deliverable.updated',
        entityType: 'deliverable',
        entityId: deliverable.id,
        data: { containerName: deliverable.containerName }
      })
      return deliverable
    },

    async deleteDeliverable(
      _parent: unknown,
      args: { id: string },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const deliverable = await loadManagedDeliverable(ctx, args.id)
      // the revision rows go by cascade; their files are removed right after
      const blobIds = (
        await listDocumentRevisionsFactory({ db })({
          projectId: deliverable.projectId,
          deliverableId: deliverable.id
        })
      ).map((r) => r.blobId)
      await deleteDeliverableFactory({ db })({ id: deliverable.id })
      if (blobIds.length) {
        const projectDb = await getProjectDbClient({ projectId: deliverable.projectId })
        await deleteDocumentFilesFactory({ projectDb })({
          projectId: deliverable.projectId,
          blobIds
        })
      }
      await audit({
        projectId: deliverable.projectId,
        actorId: userId,
        action: 'deliverable.deleted',
        entityType: 'deliverable',
        entityId: deliverable.id,
        data: { containerName: deliverable.containerName }
      })
      return true
    },

    async setDeliverableStatus(
      _parent: unknown,
      args: { id: string; status: string },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const status = statusSchema.safeParse(args.status)
      if (!status.success) throw new BadRequestError('Status de entregável inválido')
      const current = await loadManagedDeliverable(ctx, args.id)
      if (current.modelId) {
        const versions = await getModelCdeFactory({ db })({
          projectId: current.projectId,
          modelId: current.modelId
        })
        if (versions.length) {
          throw new BadRequestError(
            'O status deste entregável segue os estados do CDE das versões do modelo'
          )
        }
      }
      const documentStates = await listDocumentStatesFactory({ db })({
        projectId: current.projectId,
        deliverableId: current.id
      })
      if (documentStates.length) {
        throw new BadRequestError(
          'O status deste entregável segue os estados do CDE das revisões do documento'
        )
      }
      const deliverable = await updateDeliverableFactory({ db })({
        id: current.id,
        update: { status: status.data }
      })
      await audit({
        projectId: current.projectId,
        actorId: userId,
        action: 'deliverable.status_changed',
        entityType: 'deliverable',
        entityId: current.id,
        data: { from: current.status, to: status.data }
      })
      return deliverable
    },

    async setDeliverableModel(
      _parent: unknown,
      args: { id: string; modelId: string | null },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const current = await loadManagedDeliverable(ctx, args.id)
      if (args.modelId) {
        if (current.kind !== 'model') {
          throw new BadRequestError('Só entregáveis do tipo modelo recebem um modelo')
        }
        const projectDb = await getProjectDbClient({ projectId: current.projectId })
        await assertModelInProjectFactory({ projectDb })({
          projectId: current.projectId,
          modelId: args.modelId
        })
        const other = await findModelDeliverableFactory({ db })({
          projectId: current.projectId,
          modelId: args.modelId
        })
        if (other && other.id !== current.id) {
          throw new BadRequestError(
            `Este modelo já é do entregável ${other.containerName}`
          )
        }
      }
      const deliverable = await updateDeliverableFactory({ db })({
        id: current.id,
        update: { modelId: args.modelId ?? null }
      })
      await audit({
        projectId: current.projectId,
        actorId: userId,
        action: 'deliverable.model_linked',
        entityType: 'deliverable',
        entityId: current.id,
        data: { from: current.modelId, to: args.modelId ?? null }
      })
      if (args.modelId) {
        await syncDeliverableStatusFactory({ db })({
          projectId: current.projectId,
          modelId: args.modelId,
          actorId: userId
        })
      }
      return deliverable
    },

    async importDeliverables(
      _parent: unknown,
      args: { projectId: string; rows: unknown[] },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      await assertCanManageCoordination(ctx, args.projectId)
      const result = await importDeliverablesFactory({ db })({
        projectId: args.projectId,
        userId,
        rows: args.rows
      })
      await audit({
        projectId: args.projectId,
        actorId: userId,
        action: result.imported
          ? 'deliverable.imported'
          : 'deliverable.import_rejected',
        entityType: 'project',
        entityId: args.projectId,
        data: { rows: args.rows?.length ?? 0, imported: result.imported }
      })
      return result
    }
  }
}
