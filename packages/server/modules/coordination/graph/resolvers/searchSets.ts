import { db } from '@/db/knex'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/modules/shared/errors'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { assertCanManageCoordination } from '@/modules/coordination/helpers/access'
import {
  deleteSearchSetFactory,
  getSearchSetByIdFactory,
  getSearchSetFactory,
  listClashTestsUsingSearchSetFactory,
  listSearchSetsFactory
} from '@/modules/coordination/repositories/searchSets'
import {
  createSearchSetFactory,
  getModelPropertiesFactory,
  previewSearchSetFactory,
  updateSearchSetServiceFactory
} from '@/modules/coordination/services/coordinationSearchSets'
import { auditFactory } from '@/modules/coordination/services/coordination'

/**
 * Phase 2a API: property index and Search Sets. Reads are nested under
 * Project.coordination (core already checked read access); every write
 * resolves the projectId from the stored record and goes through
 * assertCanManageCoordination (A01).
 */

type CoordParent = { projectId: string }

const audit = auditFactory({ db })

const requireUser = (ctx: GraphQLContext) => {
  if (!ctx.userId) throw new ForbiddenError('No userId provided')
  return ctx.userId
}

async function loadManagedSearchSet(ctx: GraphQLContext, id: string) {
  const set = await getSearchSetByIdFactory({ db })({ id })
  if (!set) throw new NotFoundError('Search Set não encontrado')
  await assertCanManageCoordination(ctx, set.projectId)
  return set
}

export default {
  ProjectCoordination: {
    async modelProperties(
      parent: CoordParent,
      args: { modelId: string; versionId?: string | null }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return getModelPropertiesFactory({ db, projectDb })({
        projectId: parent.projectId,
        modelId: args.modelId,
        versionId: args.versionId
      })
    },
    searchSets(parent: CoordParent) {
      return listSearchSetsFactory({ db })({ projectId: parent.projectId })
    },
    async searchSet(parent: CoordParent, args: { id: string }) {
      return (
        (await getSearchSetFactory({ db })({
          projectId: parent.projectId,
          id: args.id
        })) ?? null
      )
    },
    async searchSetPreview(
      parent: CoordParent,
      args: { modelId: string; versionId?: string | null; where: unknown }
    ) {
      const projectDb = await getProjectDbClient({ projectId: parent.projectId })
      return previewSearchSetFactory({ projectDb })({
        projectId: parent.projectId,
        modelId: args.modelId,
        versionId: args.versionId,
        where: args.where
      })
    }
  },

  CoordinationMutations: {
    async createSearchSet(
      _parent: unknown,
      args: { projectId: string; input: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      await assertCanManageCoordination(ctx, args.projectId)
      const projectDb = await getProjectDbClient({ projectId: args.projectId })
      const set = await createSearchSetFactory({ db, projectDb })({
        projectId: args.projectId,
        userId,
        input: args.input
      })
      await audit({
        projectId: set.projectId,
        actorId: userId,
        action: 'search_set.created',
        entityType: 'search_set',
        entityId: set.id,
        data: { name: set.name }
      })
      return set
    },

    async updateSearchSet(
      _parent: unknown,
      args: { id: string; input: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const current = await loadManagedSearchSet(ctx, args.id)
      const projectDb = await getProjectDbClient({ projectId: current.projectId })
      const set = await updateSearchSetServiceFactory({ db, projectDb })({
        current,
        input: args.input
      })
      await audit({
        projectId: set.projectId,
        actorId: userId,
        action: 'search_set.updated',
        entityType: 'search_set',
        entityId: set.id,
        data: { name: set.name }
      })
      return set
    },

    async deleteSearchSet(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
      const userId = requireUser(ctx)
      const set = await loadManagedSearchSet(ctx, args.id)
      const usedBy = await listClashTestsUsingSearchSetFactory({ db })({
        projectId: set.projectId,
        searchSetId: set.id
      })
      if (usedBy.length) {
        throw new BadRequestError(
          `O Search Set é usado pelos testes de clash: ${usedBy.join(', ')}`
        )
      }
      await deleteSearchSetFactory({ db })({ id: set.id })
      await audit({
        projectId: set.projectId,
        actorId: userId,
        action: 'search_set.deleted',
        entityType: 'search_set',
        entityId: set.id,
        data: { name: set.name }
      })
      return true
    }
  }
}
