import { db } from '@/db/knex'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/modules/shared/errors'
import type { GraphQLContext } from '@/modules/shared/helpers/typeHelper'
import { getProjectModelByIdFactory } from '@/modules/core/repositories/branches'
import { assertCanManageCoordination } from '@/modules/coordination/helpers/access'
import type {
  CoordCheckRunRecord,
  CoordElementStatus,
  CoordRequirementRecord,
  CoordRequirementSourceRecord,
  CoordRuleRecord,
  CoordRuleSetBindingRecord,
  CoordRuleSetRecord,
  CoordRuleSetVersionRecord
} from '@/modules/coordination/helpers/coordinationTypes'
import {
  coordRuleDefinitionSchema,
  isIdsRuleDefinition
} from '@/modules/coordination/helpers/coordinationTypes'
import { importIdsRuleSetFactory } from '@/modules/coordination/services/coordinationIds'
import {
  countCheckRunsFactory,
  countElementScoresFactory,
  countPublishedRulesByRequirementFactory,
  countRequirementsBySourceFactory,
  deleteBindingFactory,
  deleteMilestoneFactory,
  deleteRequirementFactory,
  deleteRequirementSourceFactory,
  deleteRuleFactory,
  deleteRuleSetFactory,
  getCheckRunFactory,
  getDraftVersionFactory,
  getElementScoreFactory,
  getLatestPublishedVersionFactory,
  getLatestRunFactory,
  getLatestSucceededRunFactory,
  getMilestoneByIdFactory,
  getMilestoneFactory,
  getRequirementByIdFactory,
  getRequirementSourceByIdFactory,
  getRequirementFactory,
  getRequirementSourceFactory,
  getRuleByIdFactory,
  getRuleFactory,
  getRuleSetByIdFactory,
  getRuleSetFactory,
  getRuleSetVersionFactory,
  getRulesByIdsFactory,
  insertMilestoneFactory,
  insertRequirementFactory,
  insertRequirementSourceFactory,
  insertRuleSetFactory,
  listBindingsFactory,
  listCheckRunsFactory,
  listElementResultsFactory,
  listElementScoresFactory,
  listMilestonesFactory,
  listRequirementSourcesFactory,
  listRequirementsFactory,
  listRuleSetVersionsFactory,
  listRuleSetsFactory,
  listRuleStatsFactory,
  listRulesFactory,
  updateMilestoneFactory,
  updateRequirementFactory,
  updateRequirementSourceFactory,
  updateRuleFactory,
  updateRuleSetFactory,
  upsertBindingFactory
} from '@/modules/coordination/repositories/coordination'
import {
  assertMilestoneInProjectFactory,
  assertModelInProjectFactory,
  auditFactory,
  duplicateRuleSetFactory,
  ensureDraftFactory,
  getMilestoneReportFactory,
  getRequirementComplianceFactory,
  importRuleSetFactory,
  isUniqueViolation,
  milestoneInputSchema,
  newCoordId,
  parseOrBadRequest,
  previewDraftFactory,
  publishRuleSetFactory,
  requirementInputSchema,
  requirementSourceInputSchema,
  resolveDraftRuleFactory,
  ruleSetInputSchema,
  runCheckFactory,
  upsertDraftRuleFactory
} from '@/modules/coordination/services/coordination'
import {
  describeExpected,
  describeRule
} from '@/modules/coordination/services/coordinationEngine'

/**
 * All coord_* tables live in the main database (the queue worker polls it,
 * like the simulation worker); only Speckle's own data (models, versions,
 * objects) is read through getProjectDbClient.
 *
 * Reads are nested under Project.coordination (core already checked the
 * caller can read the project) and every lookup is scoped by that projectId,
 * so ids from another project resolve to null. Mutations resolve the
 * projectId from the stored record, never from the client, and go through
 * assertCanManageCoordination.
 */

type CoordParent = { projectId: string }

const audit = auditFactory({ db })

const requireUser = (ctx: GraphQLContext) => {
  if (!ctx.userId) throw new ForbiddenError('No userId provided')
  return ctx.userId
}

/** Loads a rule set by id and gates the caller on its (stored) project. */
async function loadManagedRuleSet(ctx: GraphQLContext, ruleSetId: string) {
  const ruleSet = await getRuleSetByIdFactory({ db })({ id: ruleSetId })
  if (!ruleSet) throw new NotFoundError('Conjunto de regras não encontrado')
  await assertCanManageCoordination(ctx, ruleSet.projectId)
  return ruleSet
}

const modelNameOf = async (projectId: string, modelId: string) => {
  const projectDb = await getProjectDbClient({ projectId })
  const model = await getProjectModelByIdFactory({ db: projectDb })({
    projectId,
    modelId
  })
  return model?.name ?? null
}

const assertSourceParent = async (
  projectId: string,
  sourceId: string | null,
  parentId: string | null
) => {
  if (!parentId) return
  // Walk up the chain: the parent must exist in this project and not loop back
  let cursor: string | null = parentId
  for (let depth = 0; cursor && depth < 20; depth++) {
    if (cursor === sourceId)
      throw new BadRequestError('Origem não pode ser pai de si mesma')
    const parent: CoordRequirementSourceRecord | undefined =
      await getRequirementSourceFactory({ db })({ projectId, id: cursor })
    if (!parent) throw new BadRequestError('Origem pai não pertence a este projeto')
    cursor = parent.parentId
  }
}

const withUniqueMessage = async <T>(message: string, fn: () => Promise<T>) => {
  try {
    return await fn()
  } catch (err) {
    if (isUniqueViolation(err)) throw new BadRequestError(message)
    throw err
  }
}

const coordinationMutations = {
  // ---- requirement sources ----
  async createRequirementSource(
    _parent: unknown,
    args: { projectId: string; input: unknown },
    ctx: GraphQLContext
  ) {
    await assertCanManageCoordination(ctx, args.projectId)
    const input = parseOrBadRequest(requirementSourceInputSchema, args.input, 'Origem')
    await assertSourceParent(args.projectId, null, input.parentId)
    const row = await insertRequirementSourceFactory({ db })({
      id: newCoordId(),
      projectId: args.projectId,
      ...input,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    await audit({
      projectId: args.projectId,
      actorId: ctx.userId ?? null,
      action: 'requirement_source.created',
      entityType: 'requirement_source',
      entityId: row.id
    })
    return row
  },

  async updateRequirementSource(
    _parent: unknown,
    args: { id: string; input: unknown },
    ctx: GraphQLContext
  ) {
    const source = await getRequirementSourceByIdOrThrow(args.id)
    await assertCanManageCoordination(ctx, source.projectId)
    const input = parseOrBadRequest(requirementSourceInputSchema, args.input, 'Origem')
    await assertSourceParent(source.projectId, source.id, input.parentId)
    const row = await updateRequirementSourceFactory({ db })({
      id: source.id,
      update: input
    })
    await audit({
      projectId: source.projectId,
      actorId: ctx.userId ?? null,
      action: 'requirement_source.updated',
      entityType: 'requirement_source',
      entityId: source.id
    })
    return row
  },

  async deleteRequirementSource(
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext
  ) {
    const source = await getRequirementSourceByIdOrThrow(args.id)
    await assertCanManageCoordination(ctx, source.projectId)
    if (await countRequirementsBySourceFactory({ db })({ sourceId: source.id })) {
      throw new BadRequestError('Remova antes os requisitos ligados a esta origem')
    }
    await deleteRequirementSourceFactory({ db })({ id: source.id })
    await audit({
      projectId: source.projectId,
      actorId: ctx.userId ?? null,
      action: 'requirement_source.deleted',
      entityType: 'requirement_source',
      entityId: source.id
    })
    return true
  },

  // ---- milestones ----
  async createMilestone(
    _parent: unknown,
    args: { projectId: string; input: unknown },
    ctx: GraphQLContext
  ) {
    await assertCanManageCoordination(ctx, args.projectId)
    const input = parseOrBadRequest(milestoneInputSchema, args.input, 'Marco')
    const row = await withUniqueMessage('Já existe um marco com esse nome', () =>
      insertMilestoneFactory({ db })({
        id: newCoordId(),
        projectId: args.projectId,
        ...input,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )
    await audit({
      projectId: args.projectId,
      actorId: ctx.userId ?? null,
      action: 'milestone.created',
      entityType: 'milestone',
      entityId: row.id
    })
    return row
  },

  async updateMilestone(
    _parent: unknown,
    args: { id: string; input: unknown },
    ctx: GraphQLContext
  ) {
    const milestone = await getMilestoneByIdOrThrow(args.id)
    await assertCanManageCoordination(ctx, milestone.projectId)
    const input = parseOrBadRequest(milestoneInputSchema, args.input, 'Marco')
    const row = await withUniqueMessage('Já existe um marco com esse nome', () =>
      updateMilestoneFactory({ db })({ id: milestone.id, update: input })
    )
    await audit({
      projectId: milestone.projectId,
      actorId: ctx.userId ?? null,
      action: 'milestone.updated',
      entityType: 'milestone',
      entityId: milestone.id
    })
    return row
  },

  async deleteMilestone(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const milestone = await getMilestoneByIdOrThrow(args.id)
    await assertCanManageCoordination(ctx, milestone.projectId)
    await deleteMilestoneFactory({ db })({ id: milestone.id })
    await audit({
      projectId: milestone.projectId,
      actorId: ctx.userId ?? null,
      action: 'milestone.deleted',
      entityType: 'milestone',
      entityId: milestone.id
    })
    return true
  },

  // ---- requirements ----
  async createRequirement(
    _parent: unknown,
    args: { projectId: string; input: unknown },
    ctx: GraphQLContext
  ) {
    await assertCanManageCoordination(ctx, args.projectId)
    const input = parseOrBadRequest(requirementInputSchema, args.input, 'Requisito')
    await assertRequirementRefs(args.projectId, input.sourceId, input.milestoneId)
    const row = await withUniqueMessage(`Já existe um requisito ${input.code}`, () =>
      insertRequirementFactory({ db })({
        id: newCoordId(),
        projectId: args.projectId,
        ...input,
        targetPct: input.targetPct ?? 95,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    )
    await audit({
      projectId: args.projectId,
      actorId: ctx.userId ?? null,
      action: 'requirement.created',
      entityType: 'requirement',
      entityId: row.id
    })
    return row
  },

  async updateRequirement(
    _parent: unknown,
    args: { id: string; input: unknown },
    ctx: GraphQLContext
  ) {
    const requirement = await getRequirementByIdOrThrow(args.id)
    await assertCanManageCoordination(ctx, requirement.projectId)
    const input = parseOrBadRequest(requirementInputSchema, args.input, 'Requisito')
    await assertRequirementRefs(
      requirement.projectId,
      input.sourceId,
      input.milestoneId
    )
    const row = await withUniqueMessage(`Já existe um requisito ${input.code}`, () =>
      updateRequirementFactory({ db })({
        id: requirement.id,
        update: { ...input, targetPct: input.targetPct ?? requirement.targetPct }
      })
    )
    await audit({
      projectId: requirement.projectId,
      actorId: ctx.userId ?? null,
      action: 'requirement.updated',
      entityType: 'requirement',
      entityId: requirement.id
    })
    return row
  },

  async deleteRequirement(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const requirement = await getRequirementByIdOrThrow(args.id)
    await assertCanManageCoordination(ctx, requirement.projectId)
    await deleteRequirementFactory({ db })({ id: requirement.id })
    await audit({
      projectId: requirement.projectId,
      actorId: ctx.userId ?? null,
      action: 'requirement.deleted',
      entityType: 'requirement',
      entityId: requirement.id
    })
    return true
  },

  // ---- rule sets ----
  async createRuleSet(
    _parent: unknown,
    args: { projectId: string; input: unknown },
    ctx: GraphQLContext
  ) {
    await assertCanManageCoordination(ctx, args.projectId)
    const userId = requireUser(ctx)
    const input = parseOrBadRequest(
      ruleSetInputSchema,
      args.input,
      'Conjunto de regras'
    )
    await assertMilestoneInProjectFactory({ db })({
      projectId: args.projectId,
      milestoneId: input.milestoneId
    })
    const ruleSet = await insertRuleSetFactory({ db })({
      id: newCoordId(),
      projectId: args.projectId,
      format: 'native',
      ...input,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    await ensureDraftFactory({ db })(ruleSet)
    await audit({
      projectId: args.projectId,
      actorId: userId,
      action: 'rule_set.created',
      entityType: 'rule_set',
      entityId: ruleSet.id
    })
    return ruleSet
  },

  async updateRuleSet(
    _parent: unknown,
    args: { id: string; input: unknown },
    ctx: GraphQLContext
  ) {
    const ruleSet = await loadManagedRuleSet(ctx, args.id)
    const input = parseOrBadRequest(
      ruleSetInputSchema,
      args.input,
      'Conjunto de regras'
    )
    await assertMilestoneInProjectFactory({ db })({
      projectId: ruleSet.projectId,
      milestoneId: input.milestoneId
    })
    const row = await updateRuleSetFactory({ db })({ id: ruleSet.id, update: input })
    await audit({
      projectId: ruleSet.projectId,
      actorId: ctx.userId ?? null,
      action: 'rule_set.updated',
      entityType: 'rule_set',
      entityId: ruleSet.id
    })
    return row
  },

  async deleteRuleSet(_parent: unknown, args: { id: string }, ctx: GraphQLContext) {
    const ruleSet = await loadManagedRuleSet(ctx, args.id)
    await deleteRuleSetFactory({ db })({ id: ruleSet.id })
    await audit({
      projectId: ruleSet.projectId,
      actorId: ctx.userId ?? null,
      action: 'rule_set.deleted',
      entityType: 'rule_set',
      entityId: ruleSet.id,
      data: { name: ruleSet.name }
    })
    return true
  },

  async duplicateRuleSet(
    _parent: unknown,
    args: { id: string; name: string },
    ctx: GraphQLContext
  ) {
    const source = await loadManagedRuleSet(ctx, args.id)
    const userId = requireUser(ctx)
    const name = args.name.trim()
    if (!name || name.length > 200) throw new BadRequestError('Nome inválido')
    const ruleSet = await duplicateRuleSetFactory({ db })({ source, name, userId })
    await audit({
      projectId: source.projectId,
      actorId: userId,
      action: 'rule_set.duplicated',
      entityType: 'rule_set',
      entityId: ruleSet.id,
      data: { from: source.id }
    })
    return ruleSet
  },

  async importRuleSet(
    _parent: unknown,
    args: { projectId: string; document: unknown },
    ctx: GraphQLContext
  ) {
    await assertCanManageCoordination(ctx, args.projectId)
    const userId = requireUser(ctx)
    const result = await importRuleSetFactory({ db })({
      projectId: args.projectId,
      document: args.document,
      userId
    })
    await audit({
      projectId: args.projectId,
      actorId: userId,
      action: 'rule_set.imported',
      entityType: 'rule_set',
      entityId: result.ruleSet.id,
      data: { createdRequirements: result.createdRequirements }
    })
    return result
  },

  async upsertDraftRule(
    _parent: unknown,
    args: { ruleSetId: string; ruleId?: string | null; input: unknown },
    ctx: GraphQLContext
  ) {
    const ruleSet = await loadManagedRuleSet(ctx, args.ruleSetId)
    let existingRule: CoordRuleRecord | null = null
    if (args.ruleId) {
      existingRule =
        (await getRuleFactory({ db })({
          projectId: ruleSet.projectId,
          id: args.ruleId
        })) ?? null
      const version = existingRule
        ? await getRuleSetVersionFactory({ db })({
            projectId: ruleSet.projectId,
            id: existingRule.ruleSetVersionId
          })
        : null
      if (!existingRule || version?.ruleSetId !== ruleSet.id) {
        throw new NotFoundError('Regra não encontrada neste conjunto')
      }
    }
    const rule = await upsertDraftRuleFactory({ db })({
      ruleSet,
      existingRule,
      input: args.input
    })
    await audit({
      projectId: ruleSet.projectId,
      actorId: ctx.userId ?? null,
      action: existingRule ? 'rule.updated' : 'rule.created',
      entityType: 'rule',
      entityId: rule.id,
      data: { ruleSetId: ruleSet.id, code: rule.code }
    })
    return rule
  },

  async importIdsRuleSet(
    _parent: unknown,
    args: {
      projectId: string
      xml: string
      name?: string | null
      milestoneId?: string | null
      ruleSetId?: string | null
    },
    ctx: GraphQLContext
  ) {
    await assertCanManageCoordination(ctx, args.projectId)
    const userId = requireUser(ctx)
    let ruleSet: CoordRuleSetRecord | null = null
    if (args.ruleSetId) {
      ruleSet = await loadManagedRuleSet(ctx, args.ruleSetId)
      if (ruleSet.projectId !== args.projectId) {
        throw new BadRequestError('Conjunto de regras não pertence a este projeto')
      }
    }
    await assertMilestoneInProjectFactory({ db })({
      projectId: args.projectId,
      milestoneId: args.milestoneId ?? null
    })
    const result = await importIdsRuleSetFactory({ db })({
      projectId: args.projectId,
      xml: args.xml,
      userId,
      name: args.name,
      milestoneId: args.milestoneId ?? null,
      ruleSet
    })
    await audit({
      projectId: args.projectId,
      actorId: userId,
      action: ruleSet ? 'rule_set.ids_reimported' : 'rule_set.ids_imported',
      entityType: 'rule_set',
      entityId: result.ruleSet.id,
      data: {
        specifications: result.specifications,
        createdRequirements: result.createdRequirements
      }
    })
    return result
  },

  async deleteDraftRule(
    _parent: unknown,
    args: { ruleId: string },
    ctx: GraphQLContext
  ) {
    const rule = await getRuleByIdFactory({ db })({ id: args.ruleId })
    if (!rule) throw new NotFoundError('Regra não encontrada')
    const version = await getRuleSetVersionFactory({ db })({
      projectId: rule.projectId,
      id: rule.ruleSetVersionId
    })
    if (!version) throw new NotFoundError('Regra não encontrada')
    const ruleSet = await loadManagedRuleSet(ctx, version.ruleSetId)
    if (ruleSet.format === 'ids') {
      throw new BadRequestError(
        'Regras de um conjunto IDS não são editadas aqui: altere o IDS e importe a nova versão'
      )
    }
    const draft = await ensureDraftFactory({ db })(ruleSet)
    const target = await resolveDraftRuleFactory({ db })({ rule, draft })
    await deleteRuleFactory({ db })({ id: target.id })
    await audit({
      projectId: ruleSet.projectId,
      actorId: ctx.userId ?? null,
      action: 'rule.deleted',
      entityType: 'rule',
      entityId: target.id,
      data: { ruleSetId: ruleSet.id, code: target.code }
    })
    return true
  },

  async reorderDraftRules(
    _parent: unknown,
    args: { ruleSetId: string; ruleIds: string[] },
    ctx: GraphQLContext
  ) {
    const ruleSet = await loadManagedRuleSet(ctx, args.ruleSetId)
    const draft = await ensureDraftFactory({ db })(ruleSet)
    const given = await getRulesByIdsFactory({ db })({
      projectId: ruleSet.projectId,
      ids: args.ruleIds
    })
    const byId = new Map(given.map((r) => [r.id, r]))
    const ordered: CoordRuleRecord[] = []
    for (const id of args.ruleIds) {
      const rule = byId.get(id)
      if (!rule) throw new BadRequestError('Regra não pertence a este conjunto')
      ordered.push(await resolveDraftRuleFactory({ db })({ rule, draft }))
    }
    await Promise.all(
      ordered.map((rule, position) =>
        updateRuleFactory({ db })({ id: rule.id, update: { position } })
      )
    )
    return await listRulesFactory({ db })({ ruleSetVersionId: draft.id })
  },

  async publishRuleSet(
    _parent: unknown,
    args: { ruleSetId: string },
    ctx: GraphQLContext
  ) {
    const ruleSet = await loadManagedRuleSet(ctx, args.ruleSetId)
    const userId = requireUser(ctx)
    const version = await publishRuleSetFactory({ db })({ ruleSet, userId })
    await audit({
      projectId: ruleSet.projectId,
      actorId: userId,
      action: 'rule_set.published',
      entityType: 'rule_set',
      entityId: ruleSet.id,
      data: { version: version.version }
    })
    return version
  },

  // ---- bindings & runs ----
  async setRuleSetBinding(
    _parent: unknown,
    args: {
      ruleSetId: string
      modelId: string
      autoRun: boolean
      unkeyedBlockPct?: number | null
    },
    ctx: GraphQLContext
  ) {
    const ruleSet = await loadManagedRuleSet(ctx, args.ruleSetId)
    const pct = args.unkeyedBlockPct ?? 2
    if (pct < 0 || pct > 100) {
      throw new BadRequestError(
        'Limite de elementos sem chave deve estar entre 0 e 100'
      )
    }
    const projectDb = await getProjectDbClient({ projectId: ruleSet.projectId })
    await assertModelInProjectFactory({ projectDb })({
      projectId: ruleSet.projectId,
      modelId: args.modelId
    })
    const binding = await upsertBindingFactory({ db })({
      projectId: ruleSet.projectId,
      ruleSetId: ruleSet.id,
      modelId: args.modelId,
      autoRun: args.autoRun,
      unkeyedBlockPct: pct,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    await audit({
      projectId: ruleSet.projectId,
      actorId: ctx.userId ?? null,
      action: 'rule_set.binding_set',
      entityType: 'rule_set',
      entityId: ruleSet.id,
      data: { modelId: args.modelId, autoRun: args.autoRun, unkeyedBlockPct: pct }
    })
    return binding
  },

  async removeRuleSetBinding(
    _parent: unknown,
    args: { ruleSetId: string; modelId: string },
    ctx: GraphQLContext
  ) {
    const ruleSet = await loadManagedRuleSet(ctx, args.ruleSetId)
    await deleteBindingFactory({ db })({ ruleSetId: ruleSet.id, modelId: args.modelId })
    await audit({
      projectId: ruleSet.projectId,
      actorId: ctx.userId ?? null,
      action: 'rule_set.binding_removed',
      entityType: 'rule_set',
      entityId: ruleSet.id,
      data: { modelId: args.modelId }
    })
    return true
  },

  async runCheck(
    _parent: unknown,
    args: { ruleSetId: string; modelId: string; versionId?: string | null },
    ctx: GraphQLContext
  ) {
    const ruleSet = await loadManagedRuleSet(ctx, args.ruleSetId)
    const userId = requireUser(ctx)
    const projectDb = await getProjectDbClient({ projectId: ruleSet.projectId })
    const run = await runCheckFactory({ db, projectDb })({
      ruleSet,
      modelId: args.modelId,
      versionId: args.versionId,
      userId
    })
    await audit({
      projectId: ruleSet.projectId,
      actorId: userId,
      action: 'check_run.requested',
      entityType: 'check_run',
      entityId: run.id,
      data: { ruleSetId: ruleSet.id, modelId: run.modelId, versionId: run.versionId }
    })
    return run
  },

  async previewDraft(
    _parent: unknown,
    args: { ruleSetId: string; modelId: string },
    ctx: GraphQLContext
  ) {
    const ruleSet = await loadManagedRuleSet(ctx, args.ruleSetId)
    const userId = requireUser(ctx)
    const projectDb = await getProjectDbClient({ projectId: ruleSet.projectId })
    const run = await previewDraftFactory({ db, projectDb })({
      ruleSet,
      modelId: args.modelId,
      userId
    })
    await audit({
      projectId: ruleSet.projectId,
      actorId: userId,
      action: 'check_run.preview_requested',
      entityType: 'check_run',
      entityId: run.id,
      data: { ruleSetId: ruleSet.id, modelId: run.modelId }
    })
    return run
  }
}

// ---- unscoped loaders for mutation targets (projectId comes from the record) ----

async function getRequirementSourceByIdOrThrow(id: string) {
  const row = await getRequirementSourceByIdFactory({ db })({ id })
  if (!row) throw new NotFoundError('Origem não encontrada')
  return row
}

async function getMilestoneByIdOrThrow(id: string) {
  const row = await getMilestoneByIdFactory({ db })({ id })
  if (!row) throw new NotFoundError('Marco não encontrado')
  return row
}

async function getRequirementByIdOrThrow(id: string) {
  const row = await getRequirementByIdFactory({ db })({ id })
  if (!row) throw new NotFoundError('Requisito não encontrado')
  return row
}

async function assertRequirementRefs(
  projectId: string,
  sourceId: string,
  milestoneId: string | null
) {
  const source = await getRequirementSourceFactory({ db })({ projectId, id: sourceId })
  if (!source) throw new BadRequestError('Origem não pertence a este projeto')
  await assertMilestoneInProjectFactory({ db })({ projectId, milestoneId })
}

// ---- read side --------------------------------------------------------------------

/** Results of a run are only served once it succeeded (no partial output). */
const succeeded = (run: CoordCheckRunRecord) => run.status === 'succeeded'

const idsDefinition = (rule: CoordRuleRecord) =>
  isIdsRuleDefinition(rule.definition) ? rule.definition : null

const ruleDefinition = (rule: CoordRuleRecord) => {
  const parsed = coordRuleDefinitionSchema.safeParse(rule.definition)
  return parsed.success ? parsed.data : null
}

export default {
  Project: {
    coordination(parent: { id: string }): CoordParent {
      return { projectId: parent.id }
    }
  },

  ProjectCoordination: {
    requirementSources(parent: CoordParent) {
      return listRequirementSourcesFactory({ db })(parent)
    },
    requirements(parent: CoordParent, args: { milestoneId?: string | null }) {
      return listRequirementsFactory({ db })({
        ...parent,
        milestoneId: args.milestoneId
      })
    },
    milestones(parent: CoordParent) {
      return listMilestonesFactory({ db })(parent)
    },
    ruleSets(parent: CoordParent) {
      return listRuleSetsFactory({ db })(parent)
    },
    async ruleSet(parent: CoordParent, args: { id: string }) {
      return (await getRuleSetFactory({ db })({ ...parent, id: args.id })) ?? null
    },
    async checkRuns(
      parent: CoordParent,
      args: {
        ruleSetId?: string | null
        modelId?: string | null
        includePreview?: boolean | null
        limit?: number | null
        cursor?: string | null
      }
    ) {
      const filter = {
        ...parent,
        ruleSetId: args.ruleSetId,
        modelId: args.modelId,
        includePreview: !!args.includePreview
      }
      const limit = Math.min(Math.max(args.limit ?? 25, 1), 100)
      const [items, totalCount] = await Promise.all([
        listCheckRunsFactory({ db })({ ...filter, limit, cursor: args.cursor }),
        countCheckRunsFactory({ db })(filter)
      ])
      return {
        items,
        totalCount,
        cursor:
          items.length === limit ? items[items.length - 1].queuedAt.toISOString() : null
      }
    },
    async checkRun(parent: CoordParent, args: { id: string }) {
      return (await getCheckRunFactory({ db })({ ...parent, id: args.id })) ?? null
    },
    milestoneReport(parent: CoordParent, args: { milestoneId: string }) {
      return getMilestoneReportFactory({ db })({
        ...parent,
        milestoneId: args.milestoneId
      })
    }
  },

  CoordRequirementSource: {
    async parent(parent: CoordRequirementSourceRecord) {
      if (!parent.parentId) return null
      return (
        (await getRequirementSourceFactory({ db })({
          projectId: parent.projectId,
          id: parent.parentId
        })) ?? null
      )
    }
  },

  CoordRequirement: {
    source(parent: CoordRequirementRecord) {
      return getRequirementSourceFactory({ db })({
        projectId: parent.projectId,
        id: parent.sourceId
      })
    },
    async milestone(parent: CoordRequirementRecord) {
      if (!parent.milestoneId) return null
      return (
        (await getMilestoneFactory({ db })({
          projectId: parent.projectId,
          id: parent.milestoneId
        })) ?? null
      )
    },
    ruleCount(parent: CoordRequirementRecord) {
      return countPublishedRulesByRequirementFactory({ db })({
        requirementId: parent.id
      })
    }
  },

  CoordRuleSet: {
    async milestone(parent: CoordRuleSetRecord) {
      if (!parent.milestoneId) return null
      return (
        (await getMilestoneFactory({ db })({
          projectId: parent.projectId,
          id: parent.milestoneId
        })) ?? null
      )
    },
    async published(parent: CoordRuleSetRecord) {
      return (
        (await getLatestPublishedVersionFactory({ db })({ ruleSetId: parent.id })) ??
        null
      )
    },
    async draft(parent: CoordRuleSetRecord) {
      return (await getDraftVersionFactory({ db })({ ruleSetId: parent.id })) ?? null
    },
    versions(parent: CoordRuleSetRecord) {
      return listRuleSetVersionsFactory({ db })({ ruleSetId: parent.id })
    },
    bindings(parent: CoordRuleSetRecord) {
      return listBindingsFactory({ db })({ ruleSetId: parent.id })
    },
    async lastRun(parent: CoordRuleSetRecord) {
      return (
        (await getLatestRunFactory({ db })({
          projectId: parent.projectId,
          ruleSetId: parent.id
        })) ?? null
      )
    }
  },

  CoordRuleSetBinding: {
    modelName(parent: CoordRuleSetBindingRecord) {
      return modelNameOf(parent.projectId, parent.modelId)
    }
  },

  CoordRuleSetVersion: {
    rules(parent: CoordRuleSetVersionRecord) {
      return listRulesFactory({ db })({ ruleSetVersionId: parent.id })
    }
  },

  CoordRule: {
    async requirement(parent: CoordRuleRecord) {
      if (!parent.requirementId) return null
      return (
        (await getRequirementFactory({ db })({
          projectId: parent.projectId,
          id: parent.requirementId
        })) ?? null
      )
    },
    summary(parent: CoordRuleRecord) {
      const ids = idsDefinition(parent)
      if (ids) return `Onde ${ids.applicability}, exigir ${ids.requirements}`
      const definition = ruleDefinition(parent)
      return definition ? describeRule(definition) : ''
    },
    expected(parent: CoordRuleRecord) {
      const ids = idsDefinition(parent)
      if (ids) return ids.requirements
      const definition = ruleDefinition(parent)
      return definition ? describeExpected(definition) : ''
    }
  },

  CoordCheckRun: {
    modelName(parent: CoordCheckRunRecord) {
      return modelNameOf(parent.projectId, parent.modelId)
    },
    async ruleSet(parent: CoordCheckRunRecord) {
      return (
        (await getRuleSetFactory({ db })({
          projectId: parent.projectId,
          id: parent.ruleSetId
        })) ?? null
      )
    },
    ruleSetVersion(parent: CoordCheckRunRecord) {
      return getRuleSetVersionFactory({ db })({
        projectId: parent.projectId,
        id: parent.ruleSetVersionId
      })
    },
    summary(parent: CoordCheckRunRecord) {
      return {
        elements: parent.elementCount,
        applicable: parent.applicableCount,
        passed: parent.passCount,
        warned: parent.warnCount,
        failed: parent.failCount,
        notApplicable: parent.naCount,
        unkeyed: parent.unkeyedCount,
        adherence: parent.adherence
      }
    },
    requirements(parent: CoordCheckRunRecord) {
      if (!succeeded(parent)) return []
      return getRequirementComplianceFactory({ db })({
        projectId: parent.projectId,
        runIds: [parent.id]
      })
    },
    async ruleStats(parent: CoordCheckRunRecord) {
      if (!succeeded(parent)) return []
      const stats = await listRuleStatsFactory({ db })({ runId: parent.id })
      const rules = await getRulesByIdsFactory({ db })({
        projectId: parent.projectId,
        ids: stats.map((s) => s.ruleId)
      })
      const byId = new Map(rules.map((r) => [r.id, r]))
      return stats
        .filter((s) => byId.has(s.ruleId))
        .map((s) => ({
          rule: byId.get(s.ruleId),
          applicable: s.applicableCount,
          passed: s.passCount,
          warned: s.warnCount,
          failed: s.failCount
        }))
        .sort((a, b) => a.rule!.position - b.rule!.position)
    },
    unkeyedSample(parent: CoordCheckRunRecord) {
      return Array.isArray(parent.unkeyedSample) ? parent.unkeyedSample : []
    },
    async previous(parent: CoordCheckRunRecord) {
      return (
        (await getLatestSucceededRunFactory({ db })({
          projectId: parent.projectId,
          ruleSetId: parent.ruleSetId,
          modelId: parent.modelId,
          before: parent.queuedAt
        })) ?? null
      )
    },
    async elementResults(
      parent: CoordCheckRunRecord,
      args: {
        status?: CoordElementStatus[] | null
        ruleId?: string | null
        requirementId?: string | null
        limit?: number | null
        cursor?: string | null
      }
    ) {
      if (!succeeded(parent)) return { items: [], totalCount: 0, cursor: null }
      const filter = {
        runId: parent.id,
        statuses: args.status,
        ruleId: args.ruleId,
        requirementId: args.requirementId
      }
      const limit = Math.min(Math.max(args.limit ?? 5000, 1), 5000)
      const [items, totalCount] = await Promise.all([
        listElementScoresFactory({ db })({ ...filter, limit, cursor: args.cursor }),
        countElementScoresFactory({ db })(filter)
      ])
      return {
        items,
        totalCount,
        cursor: items.length === limit ? items[items.length - 1].elementKey : null
      }
    },
    async element(parent: CoordCheckRunRecord, args: { elementKey: string }) {
      if (!succeeded(parent)) return null
      const score = await getElementScoreFactory({ db })({
        runId: parent.id,
        elementKey: args.elementKey
      })
      if (!score) return null
      const results = await listElementResultsFactory({ db })({
        runId: parent.id,
        elementKey: args.elementKey
      })
      const rules = await getRulesByIdsFactory({ db })({
        projectId: parent.projectId,
        ids: results.map((r) => r.ruleId)
      })
      const byId = new Map(rules.map((r) => [r.id, r]))
      return {
        ...score,
        results: results
          .filter((r) => byId.has(r.ruleId))
          .map((r) => ({
            rule: byId.get(r.ruleId),
            status: r.status,
            actualValue: Array.isArray(r.actualValue)
              ? r.actualValue.map((v) => String(v))
              : null,
            message: r.message
          }))
          .sort((a, b) => a.rule!.position - b.rule!.position)
      }
    }
  },

  Mutation: {
    coordinationMutations: () => ({})
  },
  CoordinationMutations: {
    ...coordinationMutations
  }
}
