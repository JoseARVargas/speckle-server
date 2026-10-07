import { db } from '@/db/knex'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { BadRequestError, ForbiddenError } from '@/modules/shared/errors'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import {
  assertCanManageCoordination,
  assertProjectOwner
} from '@/modules/coordination/helpers/access'
import { transitionInputSchema } from '@/modules/coordination/helpers/cdeTypes'
import { listVersionStatesFactory } from '@/modules/coordination/repositories/cde'
import { auditFactory } from '@/modules/coordination/services/coordination'
import {
  effectiveApproversFactory,
  findModelDeliverableFactory,
  getCdeConfigFactory,
  getModelCdeFactory,
  setApproversFactory,
  setCdeConfigFactory,
  transitionVersionFactory,
  versionAdherenceFactory
} from '@/modules/coordination/services/coordinationCde'

/**
 * ISO 19650 CDE API. Reads are nested under Project.coordination (core already
 * checked read access) and filtered by that project; configuration and
 * approvers are the owner's; transitions check the flow and the role in the
 * service (A01).
 */

type CoordParent = { projectId: string }

const audit = auditFactory({ db })

const requireUser = (ctx: GraphQLContext) => {
  if (!ctx.userId) throw new ForbiddenError('No userId provided')
  return ctx.userId
}

export default {
  ProjectCoordination: {
    cdeConfig(parent: CoordParent) {
      return getCdeConfigFactory({ db })({ projectId: parent.projectId })
    },
    cdeApprovers(parent: CoordParent) {
      return effectiveApproversFactory({ db })({ projectId: parent.projectId })
    },
    modelCde(parent: CoordParent, args: { modelId: string }) {
      return getModelCdeFactory({ db })({
        projectId: parent.projectId,
        modelId: args.modelId
      })
    },
    async versionAdherence(parent: CoordParent, args: { versionId: string }) {
      const rows = await listVersionStatesFactory({ db })({
        projectId: parent.projectId,
        versionId: args.versionId
      })
      const modelId = rows[rows.length - 1]?.modelId
      const deliverable = modelId
        ? await findModelDeliverableFactory({ db })({
            projectId: parent.projectId,
            modelId
          })
        : null
      return versionAdherenceFactory({ db })({
        projectId: parent.projectId,
        versionId: args.versionId,
        deliverableId: deliverable?.id ?? null
      })
    }
  },

  CoordinationMutations: {
    async setCdeConfig(
      _parent: unknown,
      args: { projectId: string; config: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      await assertProjectOwner(ctx, args.projectId)
      const config = await setCdeConfigFactory({ db })({
        projectId: args.projectId,
        config: args.config,
        userId
      })
      await audit({
        projectId: args.projectId,
        actorId: userId,
        action: 'cde.config_changed',
        entityType: 'project',
        entityId: args.projectId,
        data: {
          states: config.states.map((s) => s.code),
          requireAdherenceToPublish: config.requireAdherenceToPublish,
          autoRejectBelowTarget: config.autoRejectBelowTarget
        }
      })
      return config
    },

    async setCdeApprovers(
      _parent: unknown,
      args: { projectId: string; userIds: string[] },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      await assertProjectOwner(ctx, args.projectId)
      const userIds = await setApproversFactory({ db })({
        projectId: args.projectId,
        userIds: args.userIds,
        actorId: userId
      })
      // A09: permission change
      await audit({
        projectId: args.projectId,
        actorId: userId,
        action: 'cde.approvers_changed',
        entityType: 'project',
        entityId: args.projectId,
        data: { userIds }
      })
      return effectiveApproversFactory({ db })({ projectId: args.projectId })
    },

    async transitionVersion(
      _parent: unknown,
      args: { projectId: string; versionId: string; input: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      await assertCanManageCoordination(ctx, args.projectId)
      const input = transitionInputSchema.safeParse(args.input)
      if (!input.success)
        throw new BadRequestError('Dados da mudança de estado inválidos')
      const projectDb = await getProjectDbClient({ projectId: args.projectId })
      return transitionVersionFactory({ db, projectDb })({
        projectId: args.projectId,
        versionId: args.versionId,
        userId,
        input: input.data
      })
    }
  }
}
