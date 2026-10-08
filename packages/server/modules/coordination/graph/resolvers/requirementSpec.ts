import { db } from '@/db/knex'
import { Streams } from '@/modules/core/dbSchema'
import { ForbiddenError, NotFoundError } from '@/modules/shared/errors'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { assertCanManageCoordination } from '@/modules/coordination/helpers/access'
import type {
  CoordRequirementRecord,
  CoordRuleSetRecord
} from '@/modules/coordination/helpers/coordinationTypes'
import { coordRequirementSpecSchema } from '@/modules/coordination/helpers/coordinationTypes'
import type { CoordDeliverableRecord } from '@/modules/coordination/helpers/planningTypes'
import {
  getRequirementByIdFactory,
  getRequirementsByIdsFactory
} from '@/modules/coordination/repositories/coordination'
import { listRequirementIdsOfDeliverableFactory } from '@/modules/coordination/repositories/planning'
import { auditFactory } from '@/modules/coordination/services/coordination'
import type { ProjectRunStats } from '@/modules/coordination/services/coordinationRequirementSpec'
import {
  deliverableCompliance,
  describeRequirementSpec,
  exportRequirementsIdsFactory,
  generateRequirementRulesFactory,
  loadProjectRunStatsFactory,
  setRequirementSpecFactory
} from '@/modules/coordination/services/coordinationRequirementSpec'

/**
 * Fase 2c API: requirement specification, "Gerar regras", "Exportar IDS" and
 * the MIDP compliance column. Reads are nested under Project.coordination
 * (core already checked read access); writes resolve the projectId from the
 * stored record and go through assertCanManageCoordination (A01).
 */

type CoordParent = { projectId: string }

const audit = auditFactory({ db })

const requireUser = (ctx: GraphQLContext) => {
  if (!ctx.userId) throw new ForbiddenError('No userId provided')
  return ctx.userId
}

/**
 * The MIDP asks for the compliance of up to 500 deliverables in one request:
 * the project's latest runs and their stats load once per request and
 * project, then each deliverable is computed in memory.
 */
const runStatsByRequest = new WeakMap<object, Map<string, Promise<ProjectRunStats>>>()

const projectRunStats = (ctx: GraphQLContext, projectId: string) => {
  let byProject = runStatsByRequest.get(ctx)
  if (!byProject) {
    byProject = new Map()
    runStatsByRequest.set(ctx, byProject)
  }
  let stats = byProject.get(projectId)
  if (!stats) {
    stats = loadProjectRunStatsFactory({ db })({ projectId })
    byProject.set(projectId, stats)
  }
  return stats
}

const projectNameOf = async (projectId: string) => {
  const row = await db(Streams.name)
    .where(Streams.col.id, projectId)
    .first<{ name: string } | undefined>(Streams.col.name)
  return row?.name ?? projectId
}

export default {
  CoordRequirement: {
    spec(parent: CoordRequirementRecord) {
      return parent.spec ?? null
    },
    specSummary(parent: CoordRequirementRecord) {
      const parsed = coordRequirementSpecSchema.safeParse(parent.spec)
      return parsed.success ? describeRequirementSpec(parsed.data) : null
    }
  },

  CoordRuleSet: {
    generatedFrom(parent: CoordRuleSetRecord) {
      return parent.generatedFrom ?? null
    }
  },

  ProjectCoordination: {
    async requirementsIds(parent: CoordParent, args: { milestoneId?: string | null }) {
      const result = await exportRequirementsIdsFactory({ db })({
        projectId: parent.projectId,
        projectName: await projectNameOf(parent.projectId),
        milestoneId: args.milestoneId
      })
      return { ...result, fileName: `requisitos-${parent.projectId}.ids` }
    }
  },

  CoordDeliverable: {
    async compliance(
      parent: CoordDeliverableRecord,
      _args: unknown,
      ctx: GraphQLContext
    ) {
      if (!parent.modelId) {
        return deliverableCompliance({
          modelId: null,
          requirements: [],
          stats: new Map()
        })
      }
      const ids = await listRequirementIdsOfDeliverableFactory({ db })({
        deliverableId: parent.id
      })
      const [requirements, stats] = await Promise.all([
        getRequirementsByIdsFactory({ db })({ projectId: parent.projectId, ids }),
        projectRunStats(ctx, parent.projectId)
      ])
      return deliverableCompliance({
        modelId: parent.modelId,
        requirements: [...requirements].sort((a, b) => a.code.localeCompare(b.code)),
        stats
      })
    }
  },

  CoordinationMutations: {
    async setRequirementSpec(
      _parent: unknown,
      args: { id: string; spec?: unknown },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      const requirement = await getRequirementByIdFactory({ db })({ id: args.id })
      if (!requirement) throw new NotFoundError('Requisito não encontrado')
      await assertCanManageCoordination(ctx, requirement.projectId)
      const row = await setRequirementSpecFactory({ db })({
        requirement,
        spec: args.spec ?? null
      })
      await audit({
        projectId: requirement.projectId,
        actorId: userId,
        action: 'requirement_spec.updated',
        entityType: 'requirement',
        entityId: requirement.id,
        data: { code: requirement.code, cleared: !row.spec }
      })
      return row
    },

    async generateRequirementRules(
      _parent: unknown,
      args: { projectId: string },
      ctx: GraphQLContext
    ) {
      const userId = requireUser(ctx)
      await assertCanManageCoordination(ctx, args.projectId)
      const result = await generateRequirementRulesFactory({ db })({
        projectId: args.projectId,
        userId
      })
      await audit({
        projectId: args.projectId,
        actorId: userId,
        action: 'rules.generated',
        entityType: 'rule_set',
        entityId: result.ruleSet.id,
        data: { generated: result.generated, skipped: result.skipped.length }
      })
      return result
    }
  }
}
