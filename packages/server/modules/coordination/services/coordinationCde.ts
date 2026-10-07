import type { Knex } from 'knex'
import { moduleLogger } from '@/observability/logging'
import { getEventBus } from '@/modules/shared/services/eventBus'
import { VersionEvents } from '@/modules/core/domain/commits/events'
import {
  CoordCheckRuns,
  CoordDeliverables,
  CoordRequirementStats,
  CoordRequirements,
  StreamAcl
} from '@/modules/core/dbSchema'
import { Roles } from '@/modules/core/helpers/mainConstants'
import {
  getCommitBranchFactory,
  getCommitFactory
} from '@/modules/core/repositories/commits'
import { BadRequestError, ForbiddenError } from '@/modules/shared/errors'
import type {
  CdeAction,
  CdeConfig,
  CdeKind,
  CdeStage,
  CdeState,
  CoordVersionStateRecord,
  TransitionInput
} from '@/modules/coordination/helpers/cdeTypes'
import {
  CDE_LIMITS,
  DEFAULT_CDE_CONFIG,
  cdeConfigSchema
} from '@/modules/coordination/helpers/cdeTypes'
import type {
  CoordDeliverableRecord,
  DeliverableStatus
} from '@/modules/coordination/helpers/planningTypes'
import {
  getCdeConfigRecordFactory,
  insertVersionStateFactory,
  listApproverIdsFactory,
  listModelStatesFactory,
  listUsedCdeCodesFactory,
  listVersionStatesFactory,
  replaceApproversFactory,
  upsertCdeConfigFactory
} from '@/modules/coordination/repositories/cde'
import {
  listRequirementIdsOfDeliverableFactory,
  updateDeliverableFactory
} from '@/modules/coordination/repositories/planning'
import { auditFactory, newCoordId } from '@/modules/coordination/services/coordination'

/**
 * ISO 19650 CDE flow per model version (plan 2026-10-07-upload-midp-cde):
 * every new version enters the first WIP state; WIP → Shared (suitability,
 * P revision) by contributors; Shared → Published (A/B, C revision) or back
 * to WIP (rejection, comment required) by an approver; a new publication
 * archives the previous one. States are configurable per project, the flow
 * rules follow each state's ISO stage. The MIDP status of the deliverable
 * linked to the model is derived from it.
 */

// ---- configuration ----------------------------------------------------------

export const getCdeConfigFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string }): Promise<CdeConfig> =>
    (await getCdeConfigRecordFactory(deps)(p))?.config ?? DEFAULT_CDE_CONFIG

export const setCdeConfigFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; config: unknown; userId: string }) => {
    const parsed = cdeConfigSchema.safeParse(p.config)
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues[0]?.message ?? 'Configuração do CDE inválida'
      )
    }
    const config = parsed.data
    // the history keeps codes: a used code can be deactivated, not removed
    const used = await listUsedCdeCodesFactory(deps)({ projectId: p.projectId })
    const stateCodes = new Set(config.states.map((s) => s.code.toUpperCase()))
    const missingState = used.stateCodes.find((c) => !stateCodes.has(c.toUpperCase()))
    if (missingState) {
      throw new BadRequestError(
        `O estado ${missingState} já foi usado e não pode ser removido; desative-o`
      )
    }
    const suitability = new Set(
      [...config.suitability.shared, ...config.suitability.published].map((s) =>
        s.code.toUpperCase()
      )
    )
    const missingCode = used.suitability.find((c) => !suitability.has(c.toUpperCase()))
    if (missingCode) {
      throw new BadRequestError(
        `O código ${missingCode} já foi usado e não pode ser removido; desative-o`
      )
    }
    await upsertCdeConfigFactory(deps)({
      projectId: p.projectId,
      config,
      updatedBy: p.userId
    })
    return config
  }

const activeStates = (config: CdeConfig, stage?: CdeStage) =>
  config.states.filter((s) => s.active && (!stage || s.stage === stage))

const findState = (config: CdeConfig, code: string) =>
  config.states.find((s) => s.code.toUpperCase() === code.toUpperCase()) ?? null

// ---- roles and approvers ----------------------------------------------------

const projectRoleFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; userId: string }) =>
    ((
      await deps
        .db(StreamAcl.name)
        .where({ resourceId: p.projectId, userId: p.userId })
        .first()
    )?.role as string | undefined) ?? null

const WRITE_ROLES: string[] = [Roles.Stream.Owner, Roles.Stream.Contributor]

/** Approvers designated by the owner; while there are none, the owners approve. */
export const effectiveApproversFactory =
  (deps: { db: Knex }) => async (p: { projectId: string }) => {
    const approvers = await listApproverIdsFactory(deps)(p)
    if (approvers.length) return { userIds: approvers, fallbackToOwners: false }
    const owners = await deps
      .db(StreamAcl.name)
      .where({ resourceId: p.projectId, role: Roles.Stream.Owner })
      .select('userId')
    return { userIds: owners.map((o) => o.userId as string), fallbackToOwners: true }
  }

export const setApproversFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; userIds: string[]; actorId: string }) => {
    const userIds = [...new Set(p.userIds)]
    if (userIds.length > CDE_LIMITS.maxApprovers) {
      throw new BadRequestError(`No máximo ${CDE_LIMITS.maxApprovers} aprovadores`)
    }
    if (userIds.length) {
      // A01: only collaborators who can publish to the project
      const members = await deps
        .db(StreamAcl.name)
        .where({ resourceId: p.projectId })
        .whereIn('userId', userIds)
        .whereIn('role', WRITE_ROLES)
        .select('userId')
      if (members.length !== userIds.length) {
        throw new BadRequestError(
          'Aprovador precisa ser colaborador ou dono do projeto'
        )
      }
    }
    await replaceApproversFactory(deps)({
      projectId: p.projectId,
      userIds,
      createdBy: p.actorId
    })
    return userIds
  }

// ---- Model Check criterion ----------------------------------------------------

export type RequirementAdherence = {
  requirementId: string
  code: string
  applicableCount: number
  passCount: number
  pct: number | null
  targetPct: number | null
  met: boolean | null
}

/**
 * Adherence of a version to the requirements of its deliverable: the latest
 * succeeded (non-preview) run of each rule set on that version, summed per
 * requirement and compared with the requirement's target.
 */
export const versionAdherenceFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; versionId: string; deliverableId: string | null }) => {
    const requirementIds = p.deliverableId
      ? await listRequirementIdsOfDeliverableFactory(deps)({
          deliverableId: p.deliverableId
        })
      : []
    if (!requirementIds.length) {
      return {
        evaluated: false,
        met: false,
        requirements: [] as RequirementAdherence[]
      }
    }
    const runs = await deps
      .db(CoordCheckRuns.name)
      .where({ projectId: p.projectId, versionId: p.versionId, status: 'succeeded' })
      .whereNot({ trigger: 'preview' })
      .orderBy('finishedAt', 'desc')
      .select('id', 'ruleSetId')
    const latestPerRuleSet = new Map<string, string>()
    for (const run of runs) {
      if (!latestPerRuleSet.has(run.ruleSetId))
        latestPerRuleSet.set(run.ruleSetId, run.id)
    }
    const runIds = [...latestPerRuleSet.values()]
    const stats = runIds.length
      ? await deps
          .db(CoordRequirementStats.name)
          .whereIn('runId', runIds)
          .whereIn('requirementId', requirementIds)
          .select<
            { requirementId: string; applicableCount: number; passCount: number }[]
          >('requirementId', 'applicableCount', 'passCount')
      : []
    const requirements = await deps
      .db(CoordRequirements.name)
      .where({ projectId: p.projectId })
      .whereIn('id', requirementIds)
      .select<{ id: string; code: string; targetPct: number | string | null }[]>(
        'id',
        'code',
        'targetPct'
      )
    const result: RequirementAdherence[] = requirements.map((r) => {
      const own = stats.filter((s) => s.requirementId === r.id)
      const applicableCount = own.reduce((sum, s) => sum + s.applicableCount, 0)
      const passCount = own.reduce((sum, s) => sum + s.passCount, 0)
      const pct = applicableCount ? (passCount / applicableCount) * 100 : null
      const targetPct = r.targetPct === null ? null : Number(r.targetPct)
      return {
        requirementId: r.id,
        code: r.code,
        applicableCount,
        passCount,
        pct,
        targetPct,
        met: pct === null || targetPct === null ? null : pct >= targetPct
      }
    })
    const evaluated = result.some((r) => r.met !== null)
    return {
      evaluated,
      met: evaluated && result.every((r) => r.met !== false),
      requirements: result
    }
  }

const describeShortfall = (requirements: RequirementAdherence[]) =>
  requirements
    .filter((r) => r.met === false)
    .map((r) => `${r.code} ${r.pct!.toFixed(0)}% < ${r.targetPct}%`)
    .join('; ')

// ---- state history ------------------------------------------------------------

type VersionCde = {
  versionId: string
  current: CoordVersionStateRecord
  history: CoordVersionStateRecord[]
}

const groupByVersion = (rows: CoordVersionStateRecord[]): VersionCde[] => {
  const byVersion = new Map<string, CoordVersionStateRecord[]>()
  for (const row of rows) {
    const list = byVersion.get(row.versionId) ?? []
    list.push(row)
    byVersion.set(row.versionId, list)
  }
  return [...byVersion.entries()].map(([versionId, history]) => ({
    versionId,
    current: history[history.length - 1],
    history
  }))
}

export const getModelCdeFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; modelId: string }) =>
    groupByVersion(await listModelStatesFactory(deps)(p))

/**
 * MIDP status from the model's versions: a publication wins; otherwise the
 * latest submission decides (rejected → blocked, shared → in review); WIP only
 * → in progress. A rejection doesn't revoke an older shared version: it stays
 * the current one for the other teams, the deliverable shows "blocked".
 */
export const deriveDeliverableStatus = (
  rows: CoordVersionStateRecord[]
): DeliverableStatus | null => {
  const versions = groupByVersion(rows)
  if (!versions.length) return null
  const stages = versions.map((v) => v.current.stage)
  if (stages.includes('published')) return 'published'
  const lastSubmission = [...rows]
    .reverse()
    .find((r) => r.action === 'shared' || r.action === 'rejected')
  if (lastSubmission?.action === 'rejected') return 'blocked'
  if (stages.includes('shared')) return 'in_review'
  if (stages.includes('wip')) return 'in_progress'
  return null
}

export const findModelDeliverableFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; modelId: string }) =>
    ((await deps
      .db<CoordDeliverableRecord>(CoordDeliverables.name)
      .where({ projectId: p.projectId, modelId: p.modelId })
      .orderBy('createdAt')
      .first()) as CoordDeliverableRecord | undefined) ?? null

export const syncDeliverableStatusFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; modelId: string; actorId: string | null }) => {
    const deliverable = await findModelDeliverableFactory(deps)(p)
    if (!deliverable) return
    const status = deriveDeliverableStatus(await listModelStatesFactory(deps)(p))
    if (!status || status === deliverable.status) return
    await updateDeliverableFactory(deps)({ id: deliverable.id, update: { status } })
    await auditFactory(deps)({
      projectId: p.projectId,
      actorId: p.actorId,
      action: 'deliverable.status_derived',
      entityType: 'deliverable',
      entityId: deliverable.id,
      data: { from: deliverable.status, to: status }
    })
  }

/** Next revision of a stage for the model (rejected numbers aren't reused). */
const nextRevision = (
  rows: CoordVersionStateRecord[],
  action: 'shared' | 'published',
  prefix: string,
  digits: number
) => {
  const pattern = new RegExp(`^${prefix}(\\d+)$`, 'i')
  const highest = rows
    .filter((r) => r.action === action && r.revision)
    .map((r) => Number(pattern.exec(r.revision!)?.[1] ?? 0))
    .reduce((a, b) => Math.max(a, b), 0)
  return `${prefix.toUpperCase()}${String(highest + 1).padStart(digits, '0')}`
}

const stateRow = (p: {
  projectId: string
  modelId: string
  versionId: string
  deliverableId: string | null
  state: CdeState
  action: CdeAction
  kind: CdeKind
  suitability?: string | null
  revision?: string | null
  comment?: string | null
  changedBy: string | null
}): CoordVersionStateRecord => ({
  id: newCoordId(),
  projectId: p.projectId,
  modelId: p.modelId,
  versionId: p.versionId,
  deliverableId: p.deliverableId,
  stage: p.state.stage,
  stateCode: p.state.code,
  stateLabel: p.state.label,
  suitability: p.suitability ?? null,
  revision: p.revision ?? null,
  action: p.action,
  kind: p.kind,
  comment: p.comment ?? null,
  changedBy: p.changedBy,
  changedAt: new Date()
})

/** One writer per model at a time: revisions and "previous published" are per model. */
const lockModel = (trx: Knex.Transaction, modelId: string) =>
  trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`coord-cde:${modelId}`])

// ---- new versions -----------------------------------------------------------------

/** Every new version (app upload or connector) enters the first WIP state. */
export const recordVersionCreatedFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; modelId: string; versionId: string }) => {
    const config = await getCdeConfigFactory(deps)(p)
    const [first] = activeStates(config, 'wip')
    const deliverable = await findModelDeliverableFactory(deps)(p)
    await deps.db.transaction(async (trx) => {
      await lockModel(trx, p.modelId)
      const existing = await listVersionStatesFactory({ db: trx })(p)
      if (existing.length) return
      await insertVersionStateFactory({ db: trx })(
        stateRow({
          ...p,
          deliverableId: deliverable?.id ?? null,
          state: first,
          action: 'created',
          kind: 'system',
          suitability: null,
          changedBy: null
        })
      )
    })
    await syncDeliverableStatusFactory(deps)({ ...p, actorId: null })
  }

// ---- transitions ------------------------------------------------------------------

export const transitionVersionFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: {
    projectId: string
    versionId: string
    userId: string
    input: TransitionInput
  }) => {
    const version = await getCommitFactory({ db: deps.projectDb })(p.versionId, {
      streamId: p.projectId
    })
    const model = version
      ? await getCommitBranchFactory({ db: deps.projectDb })(p.versionId)
      : null
    if (!version || !model)
      throw new BadRequestError('Versão não pertence a este projeto')
    const modelId = model.id

    const role = await projectRoleFactory(deps)({
      projectId: p.projectId,
      userId: p.userId
    })
    if (!role || !WRITE_ROLES.includes(role)) {
      throw new ForbiddenError('Só colaboradores e donos mudam o estado de uma versão')
    }
    const config = await getCdeConfigFactory(deps)({ projectId: p.projectId })
    const target = findState(config, p.input.toStateCode)
    if (!target || !target.active)
      throw new BadRequestError('Estado de destino inválido')
    const deliverable = await findModelDeliverableFactory(deps)({
      projectId: p.projectId,
      modelId
    })

    const requireApprover = async (sharedBy: string | null) => {
      const approvers = await effectiveApproversFactory(deps)({
        projectId: p.projectId
      })
      if (!approvers.userIds.includes(p.userId)) {
        throw new ForbiddenError(
          approvers.fallbackToOwners
            ? 'Só o dono do projeto aprova enquanto não houver aprovadores'
            : 'Só um aprovador do projeto pode publicar ou recusar'
        )
      }
      // the author of the submission doesn't approve it, if someone else can
      if (sharedBy === p.userId && approvers.userIds.some((id) => id !== p.userId)) {
        throw new ForbiddenError(
          'Quem compartilhou a versão não pode aprová-la; peça a outro aprovador'
        )
      }
    }

    const inserted = await deps.db.transaction(async (trx) => {
      await lockModel(trx, modelId)
      const modelRows = await listModelStatesFactory({ db: trx })({
        projectId: p.projectId,
        modelId
      })
      const versionRows = modelRows.filter((r) => r.versionId === p.versionId)
      // versions from before the CDE flow start in the first WIP state
      const firstWip = activeStates(config, 'wip')[0]
      const current =
        versionRows[versionRows.length - 1] ??
        stateRow({
          projectId: p.projectId,
          modelId,
          versionId: p.versionId,
          deliverableId: deliverable?.id ?? null,
          state: firstWip,
          action: 'created',
          kind: 'system',
          changedBy: null
        })
      if (!versionRows.length) await insertVersionStateFactory({ db: trx })(current)

      const from = current.stage
      const to = target.stage
      const stageStates = activeStates(config, from)
      const position = stageStates.findIndex(
        (s) => s.code.toUpperCase() === current.stateCode.toUpperCase()
      )
      const atStageEnd = position === -1 || position === stageStates.length - 1
      const base = {
        projectId: p.projectId,
        modelId,
        versionId: p.versionId,
        deliverableId: deliverable?.id ?? null,
        state: target,
        changedBy: p.userId
      }
      const sharedBy =
        [...versionRows].reverse().find((r) => r.action === 'shared')?.changedBy ?? null
      const suitabilityOf = (stage: 'shared' | 'published') => {
        const code = p.input.suitability?.toUpperCase()
        const allowed = config.suitability[stage].filter((s) => s.active)
        const match = allowed.find((s) => s.code.toUpperCase() === code)
        if (!match) {
          throw new BadRequestError(
            `Escolha o código de adequação (${allowed.map((s) => s.code).join(', ')})`
          )
        }
        return match.code
      }

      let row: CoordVersionStateRecord
      if (from === 'archived') {
        throw new BadRequestError('Versão arquivada não muda de estado')
      } else if (from === to) {
        // next state inside the same stage (custom states)
        if (stageStates[position + 1]?.code !== target.code) {
          throw new BadRequestError('Avance para o próximo estado da etapa')
        }
        if (from === 'published') await requireApprover(null)
        row = stateRow({
          ...base,
          action: 'advanced',
          kind: 'manual',
          suitability: current.suitability,
          revision: current.revision,
          comment: p.input.comment
        })
      } else if (from === 'wip' && to === 'shared') {
        if (!atStageEnd)
          throw new BadRequestError('Conclua os estados de WIP antes de compartilhar')
        if (activeStates(config, 'shared')[0].code !== target.code) {
          throw new BadRequestError('Compartilhe no primeiro estado da etapa Shared')
        }
        row = stateRow({
          ...base,
          action: 'shared',
          kind: 'manual',
          suitability: suitabilityOf('shared'),
          revision: nextRevision(
            modelRows,
            'shared',
            config.revision.sharedPrefix,
            config.revision.digits
          ),
          comment: p.input.comment
        })
      } else if (from === 'shared' && to === 'published') {
        if (!atStageEnd)
          throw new BadRequestError('Conclua os estados de Shared antes de publicar')
        if (activeStates(config, 'published')[0].code !== target.code) {
          throw new BadRequestError('Publique no primeiro estado da etapa Published')
        }
        await requireApprover(sharedBy)
        let kind: CdeKind = 'manual'
        let comment = p.input.comment ?? null
        if (config.requireAdherenceToPublish) {
          const adherence = await versionAdherenceFactory({ db: trx })({
            projectId: p.projectId,
            versionId: p.versionId,
            deliverableId: deliverable?.id ?? null
          })
          if (!adherence.met) {
            if (!p.input.justification) {
              throw new BadRequestError(
                adherence.evaluated
                  ? `Aderência abaixo da meta (${describeShortfall(
                      adherence.requirements
                    )}): informe uma justificativa para publicar`
                  : 'Sem Model Check concluído para os requisitos do entregável: informe uma justificativa para publicar'
              )
            }
            kind = 'exception'
            comment = [p.input.justification, comment].filter(Boolean).join(' — ')
          }
        }
        row = stateRow({
          ...base,
          action: 'published',
          kind,
          suitability: suitabilityOf('published'),
          revision: nextRevision(
            modelRows,
            'published',
            config.revision.publishedPrefix,
            config.revision.digits
          ),
          comment
        })
      } else if (from === 'shared' && to === 'wip') {
        if (firstWip.code !== target.code) {
          throw new BadRequestError('A recusa volta para o primeiro estado de WIP')
        }
        if (!p.input.comment) throw new BadRequestError('Informe o motivo da recusa')
        await requireApprover(sharedBy)
        row = stateRow({
          ...base,
          action: 'rejected',
          kind: 'manual',
          suitability: null,
          revision: current.revision,
          comment: p.input.comment
        })
      } else if (from === 'published' && to === 'archived') {
        if (role !== Roles.Stream.Owner) {
          throw new ForbiddenError('Só o dono do projeto arquiva uma versão publicada')
        }
        row = stateRow({
          ...base,
          action: 'archived',
          kind: 'manual',
          suitability: current.suitability,
          revision: current.revision,
          comment: p.input.comment
        })
      } else {
        throw new BadRequestError('Transição não permitida')
      }

      const saved = await insertVersionStateFactory({ db: trx })(row)

      if (row.action === 'published') {
        // the previous publication of this model is superseded
        const [archived] = activeStates(config, 'archived')
        for (const other of groupByVersion(modelRows)) {
          if (other.versionId === p.versionId || other.current.stage !== 'published')
            continue
          await insertVersionStateFactory({ db: trx })(
            stateRow({
              projectId: p.projectId,
              modelId,
              versionId: other.versionId,
              deliverableId: other.current.deliverableId,
              state: archived,
              action: 'archived',
              kind: 'system',
              suitability: other.current.suitability,
              revision: other.current.revision,
              comment: `Substituída por ${row.revision}`,
              changedBy: p.userId
            })
          )
        }
      }
      return saved
    })

    await auditFactory(deps)({
      projectId: p.projectId,
      actorId: p.userId,
      action: `cde.${inserted.action}`,
      entityType: 'version',
      entityId: p.versionId,
      data: {
        modelId,
        state: inserted.stateCode,
        suitability: inserted.suitability,
        revision: inserted.revision,
        kind: inserted.kind
      }
    })
    await syncDeliverableStatusFactory(deps)({
      projectId: p.projectId,
      modelId,
      actorId: p.userId
    })
    if (inserted.action === 'shared') {
      // the Model Check may already be done (it runs when the version is created)
      await evaluateAutoRejectFactory(deps)({
        projectId: p.projectId,
        versionId: p.versionId
      })
    }
    return inserted
  }

// ---- automatic rejection ------------------------------------------------------------

/**
 * With autoRejectBelowTarget on, a shared version whose Model Check is below
 * the target of a requirement of its deliverable goes back to WIP by itself.
 * Called when a run finishes and right after a version is shared.
 */
export const evaluateAutoRejectFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; versionId: string }) => {
    const config = await getCdeConfigFactory(deps)(p)
    if (!config.autoRejectBelowTarget) return null
    const rows = await listVersionStatesFactory(deps)(p)
    const current = rows[rows.length - 1]
    if (!current || current.stage !== 'shared') return null
    const deliverable = await findModelDeliverableFactory(deps)({
      projectId: p.projectId,
      modelId: current.modelId
    })
    const adherence = await versionAdherenceFactory(deps)({
      projectId: p.projectId,
      versionId: p.versionId,
      deliverableId: deliverable?.id ?? null
    })
    if (!adherence.evaluated || adherence.met) return null

    const [firstWip] = activeStates(config, 'wip')
    const rejected = await deps.db.transaction(async (trx) => {
      await lockModel(trx, current.modelId)
      const latest = await listVersionStatesFactory({ db: trx })(p)
      // someone moved it meanwhile: nothing to do
      if (latest[latest.length - 1]?.id !== current.id) return null
      return await insertVersionStateFactory({ db: trx })(
        stateRow({
          projectId: p.projectId,
          modelId: current.modelId,
          versionId: p.versionId,
          deliverableId: deliverable?.id ?? null,
          state: firstWip,
          action: 'rejected',
          kind: 'automatic',
          suitability: null,
          revision: current.revision,
          comment: `Model Check abaixo da meta: ${describeShortfall(
            adherence.requirements
          )}`,
          changedBy: null
        })
      )
    })
    if (!rejected) return null
    await auditFactory(deps)({
      projectId: p.projectId,
      actorId: null,
      action: 'cde.rejected',
      entityType: 'version',
      entityId: p.versionId,
      data: { modelId: current.modelId, kind: 'automatic', comment: rejected.comment }
    })
    await syncDeliverableStatusFactory(deps)({
      projectId: p.projectId,
      modelId: current.modelId,
      actorId: null
    })
    return rejected
  }

// ---- listener ---------------------------------------------------------------------

/** New versions enter the CDE flow; a failure here never affects the upload (A10). */
export const startCdeListener = (deps: { db: Knex }) => {
  const record = recordVersionCreatedFactory(deps)
  return getEventBus().listen(
    VersionEvents.Created,
    async ({ payload: { projectId, modelId, version } }) => {
      try {
        await record({ projectId, modelId, versionId: version.id })
      } catch (err) {
        moduleLogger.error(
          { err, projectId, modelId },
          'CDE state for new version failed'
        )
      }
    }
  )
}
