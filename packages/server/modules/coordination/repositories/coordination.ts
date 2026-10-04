import type { Knex } from 'knex'
import {
  CoordAuditEvents,
  CoordCheckResults,
  CoordCheckRuns,
  CoordElementScores,
  CoordMilestones,
  CoordRequirementSources,
  CoordRequirementStats,
  CoordRequirements,
  CoordRuleSetBindings,
  CoordRuleSetVersions,
  CoordRuleSets,
  CoordRuleStats,
  CoordRules
} from '@/modules/core/dbSchema'
import type {
  CoordAuditEventRecord,
  CoordCheckResultRecord,
  CoordCheckRunRecord,
  CoordElementScoreRecord,
  CoordElementStatus,
  CoordMilestoneRecord,
  CoordRequirementRecord,
  CoordRequirementSourceRecord,
  CoordRequirementStatRecord,
  CoordRuleRecord,
  CoordRuleSetBindingRecord,
  CoordRuleSetRecord,
  CoordRuleSetVersionRecord,
  CoordRuleStatRecord,
  CoordRunStatus
} from '@/modules/coordination/helpers/coordinationTypes'

const tables = {
  sources: (db: Knex) => db<CoordRequirementSourceRecord>(CoordRequirementSources.name),
  milestones: (db: Knex) => db<CoordMilestoneRecord>(CoordMilestones.name),
  requirements: (db: Knex) => db<CoordRequirementRecord>(CoordRequirements.name),
  ruleSets: (db: Knex) => db<CoordRuleSetRecord>(CoordRuleSets.name),
  versions: (db: Knex) => db<CoordRuleSetVersionRecord>(CoordRuleSetVersions.name),
  rules: (db: Knex) => db<CoordRuleRecord>(CoordRules.name),
  bindings: (db: Knex) => db<CoordRuleSetBindingRecord>(CoordRuleSetBindings.name),
  runs: (db: Knex) => db<CoordCheckRunRecord>(CoordCheckRuns.name),
  results: (db: Knex) => db<CoordCheckResultRecord>(CoordCheckResults.name),
  scores: (db: Knex) => db<CoordElementScoreRecord>(CoordElementScores.name),
  requirementStats: (db: Knex) =>
    db<CoordRequirementStatRecord>(CoordRequirementStats.name),
  ruleStats: (db: Knex) => db<CoordRuleStatRecord>(CoordRuleStats.name),
  audit: (db: Knex) => db<CoordAuditEventRecord>(CoordAuditEvents.name)
}

const INSERT_CHUNK = 1000

/**
 * Every lookup by id also takes the projectId the caller is scoped to, so a
 * record id from another project simply isn't found (no IDOR via ids).
 */
type Scoped = { projectId: string }

// ---- requirement sources ------------------------------------------------------

export const listRequirementSourcesFactory = (deps: { db: Knex }) => (p: Scoped) =>
  tables.sources(deps.db).where({ projectId: p.projectId }).orderBy('title')

export const getRequirementSourceFactory =
  (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
    tables.sources(deps.db).where({ id: p.id, projectId: p.projectId }).first()

/** Unscoped lookup - only for resolving the projectId of a mutation target. */
export const getRequirementSourceByIdFactory =
  (deps: { db: Knex }) => (p: { id: string }) =>
    tables.sources(deps.db).where({ id: p.id }).first()

export const insertRequirementSourceFactory =
  (deps: { db: Knex }) => async (row: CoordRequirementSourceRecord) => {
    const [res] = await tables.sources(deps.db).insert(row).returning('*')
    return res
  }

export const updateRequirementSourceFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordRequirementSourceRecord> }) => {
    const [res] = await tables
      .sources(deps.db)
      .where({ id: p.id })
      .update({ ...p.update, updatedAt: new Date() })
      .returning('*')
    return res
  }

export const deleteRequirementSourceFactory =
  (deps: { db: Knex }) => (p: { id: string }) =>
    tables.sources(deps.db).where({ id: p.id }).del()

export const countRequirementsBySourceFactory =
  (deps: { db: Knex }) => async (p: { sourceId: string }) => {
    const [{ count }] = await tables
      .requirements(deps.db)
      .where({ sourceId: p.sourceId })
      .count()
    return parseInt(count + '')
  }

// ---- milestones ---------------------------------------------------------------

export const listMilestonesFactory = (deps: { db: Knex }) => (p: Scoped) =>
  tables
    .milestones(deps.db)
    .where({ projectId: p.projectId })
    .orderByRaw('"dueDate" asc nulls last, name asc')

export const getMilestoneFactory =
  (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
    tables.milestones(deps.db).where({ id: p.id, projectId: p.projectId }).first()

/** Unscoped lookup - only for resolving the projectId of a mutation target. */
export const getMilestoneByIdFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.milestones(deps.db).where({ id: p.id }).first()

export const getMilestoneByNameFactory =
  (deps: { db: Knex }) => (p: Scoped & { name: string }) =>
    tables
      .milestones(deps.db)
      .where({ projectId: p.projectId })
      .andWhereRaw('lower(name) = lower(?)', [p.name])
      .first()

export const insertMilestoneFactory =
  (deps: { db: Knex }) => async (row: CoordMilestoneRecord) => {
    const [res] = await tables.milestones(deps.db).insert(row).returning('*')
    return res
  }

export const updateMilestoneFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordMilestoneRecord> }) => {
    const [res] = await tables
      .milestones(deps.db)
      .where({ id: p.id })
      .update({ ...p.update, updatedAt: new Date() })
      .returning('*')
    return res
  }

export const deleteMilestoneFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.milestones(deps.db).where({ id: p.id }).del()

// ---- requirements -------------------------------------------------------------

export const listRequirementsFactory =
  (deps: { db: Knex }) => (p: Scoped & { milestoneId?: string | null }) => {
    const q = tables
      .requirements(deps.db)
      .where({ projectId: p.projectId })
      .orderBy('code')
    if (p.milestoneId) q.andWhere({ milestoneId: p.milestoneId })
    return q
  }

export const getRequirementFactory =
  (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
    tables.requirements(deps.db).where({ id: p.id, projectId: p.projectId }).first()

/** Unscoped lookup - only for resolving the projectId of a mutation target. */
export const getRequirementByIdFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.requirements(deps.db).where({ id: p.id }).first()

export const getRequirementsByIdsFactory =
  (deps: { db: Knex }) => (p: Scoped & { ids: string[] }) =>
    p.ids.length
      ? tables
          .requirements(deps.db)
          .where({ projectId: p.projectId })
          .whereIn('id', p.ids)
      : Promise.resolve([] as CoordRequirementRecord[])

export const getRequirementByCodeFactory =
  (deps: { db: Knex }) => (p: Scoped & { code: string }) =>
    tables
      .requirements(deps.db)
      .where({ projectId: p.projectId })
      .andWhereRaw('lower(code) = lower(?)', [p.code])
      .first()

export const insertRequirementFactory =
  (deps: { db: Knex }) => async (row: CoordRequirementRecord) => {
    const [res] = await tables.requirements(deps.db).insert(row).returning('*')
    return res
  }

export const updateRequirementFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordRequirementRecord> }) => {
    const [res] = await tables
      .requirements(deps.db)
      .where({ id: p.id })
      .update({ ...p.update, updatedAt: new Date() })
      .returning('*')
    return res
  }

export const deleteRequirementFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.requirements(deps.db).where({ id: p.id }).del()

/** Rules linked to the requirement in the latest published version of each set. */
export const countPublishedRulesByRequirementFactory =
  (deps: { db: Knex }) => async (p: { requirementId: string }) => {
    const [{ count }] = await tables
      .rules(deps.db)
      .join(
        CoordRuleSetVersions.name,
        CoordRuleSetVersions.col.id,
        CoordRules.col.ruleSetVersionId
      )
      .where(CoordRules.col.requirementId, p.requirementId)
      .andWhere(CoordRuleSetVersions.col.status, 'published')
      .andWhereRaw(
        `?? = (select max(v2.version) from ?? v2 where v2."ruleSetId" = ?? and v2.status = 'published')`,
        [
          CoordRuleSetVersions.col.version,
          CoordRuleSetVersions.name,
          CoordRuleSetVersions.col.ruleSetId
        ]
      )
      .count()
    return parseInt(count + '')
  }

// ---- rule sets & versions -------------------------------------------------------

export const listRuleSetsFactory = (deps: { db: Knex }) => (p: Scoped) =>
  tables.ruleSets(deps.db).where({ projectId: p.projectId }).orderBy('name')

export const getRuleSetFactory = (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
  tables.ruleSets(deps.db).where({ id: p.id, projectId: p.projectId }).first()

/** Unscoped lookup - only for resolving the projectId of a mutation target. */
export const getRuleSetByIdFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.ruleSets(deps.db).where({ id: p.id }).first()

export const listRuleSetsByMilestoneFactory =
  (deps: { db: Knex }) => (p: Scoped & { milestoneId: string }) =>
    tables
      .ruleSets(deps.db)
      .where({ projectId: p.projectId, milestoneId: p.milestoneId })
      .orderBy('name')

export const insertRuleSetFactory =
  (deps: { db: Knex }) => async (row: CoordRuleSetRecord) => {
    const [res] = await tables.ruleSets(deps.db).insert(row).returning('*')
    return res
  }

export const updateRuleSetFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordRuleSetRecord> }) => {
    const [res] = await tables
      .ruleSets(deps.db)
      .where({ id: p.id })
      .update({ ...p.update, updatedAt: new Date() })
      .returning('*')
    return res
  }

export const deleteRuleSetFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.ruleSets(deps.db).where({ id: p.id }).del()

export const listRuleSetVersionsFactory =
  (deps: { db: Knex }) =>
  (p: { ruleSetId: string; status?: 'draft' | 'published' }) => {
    const q = tables
      .versions(deps.db)
      .where({ ruleSetId: p.ruleSetId })
      .orderBy('version', 'desc')
    if (p.status) q.andWhere({ status: p.status })
    return q
  }

export const getRuleSetVersionFactory =
  (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
    tables.versions(deps.db).where({ id: p.id, projectId: p.projectId }).first()

export const getDraftVersionFactory =
  (deps: { db: Knex }) => (p: { ruleSetId: string }) =>
    tables.versions(deps.db).where({ ruleSetId: p.ruleSetId, status: 'draft' }).first()

export const getLatestPublishedVersionFactory =
  (deps: { db: Knex }) => (p: { ruleSetId: string }) =>
    tables
      .versions(deps.db)
      .where({ ruleSetId: p.ruleSetId, status: 'published' })
      .orderBy('version', 'desc')
      .first()

export const getMaxVersionNumberFactory =
  (deps: { db: Knex }) => async (p: { ruleSetId: string }) => {
    const row = await tables
      .versions(deps.db)
      .where({ ruleSetId: p.ruleSetId })
      .max<{ max: number | null }>('version as max')
      .first()
    return row?.max ?? 0
  }

export const insertRuleSetVersionFactory =
  (deps: { db: Knex }) => async (row: CoordRuleSetVersionRecord) => {
    const [res] = await tables.versions(deps.db).insert(row).returning('*')
    return res
  }

export const updateRuleSetVersionFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordRuleSetVersionRecord> }) => {
    const [res] = await tables
      .versions(deps.db)
      .where({ id: p.id })
      .update({ ...p.update, updatedAt: new Date() })
      .returning('*')
    return res
  }

// ---- rules ----------------------------------------------------------------------

export const listRulesFactory =
  (deps: { db: Knex }) => (p: { ruleSetVersionId: string }) =>
    tables
      .rules(deps.db)
      .where({ ruleSetVersionId: p.ruleSetVersionId })
      .orderBy([{ column: 'position' }, { column: 'code' }])

export const getRuleFactory = (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
  tables.rules(deps.db).where({ id: p.id, projectId: p.projectId }).first()

/** Unscoped lookup - only for resolving the projectId of a mutation target. */
export const getRuleByIdFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.rules(deps.db).where({ id: p.id }).first()

export const getRulesByIdsFactory =
  (deps: { db: Knex }) => (p: Scoped & { ids: string[] }) =>
    p.ids.length
      ? tables.rules(deps.db).where({ projectId: p.projectId }).whereIn('id', p.ids)
      : Promise.resolve([] as CoordRuleRecord[])

export const insertRulesFactory =
  (deps: { db: Knex }) => async (rows: CoordRuleRecord[]) => {
    if (!rows.length) return []
    return await tables
      .rules(deps.db)
      .insert(
        rows.map((r) => ({ ...r, definition: JSON.stringify(r.definition) as never }))
      )
      .returning('*')
  }

export const updateRuleFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordRuleRecord> }) => {
    const update: Record<string, unknown> = { ...p.update, updatedAt: new Date() }
    if (p.update.definition) update.definition = JSON.stringify(p.update.definition)
    const [res] = await tables
      .rules(deps.db)
      .where({ id: p.id })
      .update(update)
      .returning('*')
    return res
  }

/** Empties a draft before an IDS re-import replaces its rules. */
export const deleteRulesOfVersionFactory =
  (deps: { db: Knex }) => (p: { ruleSetVersionId: string }) =>
    tables.rules(deps.db).where({ ruleSetVersionId: p.ruleSetVersionId }).del()

export const deleteRuleFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.rules(deps.db).where({ id: p.id }).del()

export const countRulesFactory =
  (deps: { db: Knex }) => async (p: { ruleSetVersionId: string }) => {
    const [{ count }] = await tables
      .rules(deps.db)
      .where({ ruleSetVersionId: p.ruleSetVersionId })
      .count()
    return parseInt(count + '')
  }

// ---- bindings -------------------------------------------------------------------

export const listBindingsFactory = (deps: { db: Knex }) => (p: { ruleSetId: string }) =>
  tables.bindings(deps.db).where({ ruleSetId: p.ruleSetId }).orderBy('createdAt')

export const getBindingFactory =
  (deps: { db: Knex }) => (p: { ruleSetId: string; modelId: string }) =>
    tables
      .bindings(deps.db)
      .where({ ruleSetId: p.ruleSetId, modelId: p.modelId })
      .first()

export const listAutoRunBindingsForModelFactory =
  (deps: { db: Knex }) => (p: Scoped & { modelId: string }) =>
    tables
      .bindings(deps.db)
      .where({ projectId: p.projectId, modelId: p.modelId, autoRun: true })

export const upsertBindingFactory =
  (deps: { db: Knex }) => async (row: CoordRuleSetBindingRecord) => {
    const [res] = await tables
      .bindings(deps.db)
      .insert(row)
      .onConflict(['ruleSetId', 'modelId'])
      .merge(['autoRun', 'unkeyedBlockPct', 'updatedAt'])
      .returning('*')
    return res
  }

export const deleteBindingFactory =
  (deps: { db: Knex }) => (p: { ruleSetId: string; modelId: string }) =>
    tables.bindings(deps.db).where({ ruleSetId: p.ruleSetId, modelId: p.modelId }).del()

// ---- runs -----------------------------------------------------------------------

export const insertCheckRunFactory =
  (deps: { db: Knex }) => async (row: CoordCheckRunRecord) => {
    const [res] = await tables
      .runs(deps.db)
      .insert({ ...row, unkeyedSample: JSON.stringify(row.unkeyedSample) as never })
      .returning('*')
    return res
  }

export const updateCheckRunFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordCheckRunRecord> }) => {
    const update: Record<string, unknown> = { ...p.update }
    if (p.update.unkeyedSample)
      update.unkeyedSample = JSON.stringify(p.update.unkeyedSample)
    const [res] = await tables
      .runs(deps.db)
      .where({ id: p.id })
      .update(update)
      .returning('*')
    return res
  }

export const getCheckRunFactory =
  (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
    tables.runs(deps.db).where({ id: p.id, projectId: p.projectId }).first()

/** Statuses of a run that is still being worked on (by Node or Python). */
export const ACTIVE_RUN_STATUSES: CoordRunStatus[] = [
  'queued',
  'running',
  'ids_running',
  'ids_done',
  'processing'
]

export const getActiveRunFactory =
  (deps: { db: Knex }) => (p: { ruleSetVersionId: string; versionId: string }) =>
    tables
      .runs(deps.db)
      .where({ ruleSetVersionId: p.ruleSetVersionId, versionId: p.versionId })
      .whereIn('status', ACTIVE_RUN_STATUSES)
      .first()

export const countQueuedRunsFactory = (deps: { db: Knex }) => async (p: Scoped) => {
  const [{ count }] = await tables
    .runs(deps.db)
    .where({ projectId: p.projectId, status: 'queued' })
    .count()
  return parseInt(count + '')
}

export const countUserTriggeredRunsSinceFactory =
  (deps: { db: Knex }) => async (p: Scoped & { since: Date }) => {
    const [{ count }] = await tables
      .runs(deps.db)
      .where({ projectId: p.projectId })
      .whereIn('trigger', ['manual', 'preview'])
      .andWhere('queuedAt', '>=', p.since)
      .count()
    return parseInt(count + '')
  }

type RunFilter = Scoped & {
  ruleSetId?: string | null
  modelId?: string | null
  includePreview?: boolean
  status?: CoordRunStatus
}

const runsQuery = (db: Knex, p: RunFilter) => {
  const q = tables.runs(db).where({ projectId: p.projectId })
  if (p.ruleSetId) q.andWhere({ ruleSetId: p.ruleSetId })
  if (p.modelId) q.andWhere({ modelId: p.modelId })
  if (!p.includePreview) q.andWhereNot({ trigger: 'preview' })
  if (p.status) q.andWhere({ status: p.status })
  return q
}

/** Newest first; cursor = queuedAt ISO of the last item of the previous page. */
export const listCheckRunsFactory =
  (deps: { db: Knex }) =>
  (p: RunFilter & { limit: number; cursor?: string | null }) => {
    const q = runsQuery(deps.db, p)
      .orderBy([
        { column: 'queuedAt', order: 'desc' },
        { column: 'id', order: 'desc' }
      ])
      .limit(p.limit)
    if (p.cursor) q.andWhere('queuedAt', '<', new Date(p.cursor))
    return q
  }

export const countCheckRunsFactory = (deps: { db: Knex }) => async (p: RunFilter) => {
  const [{ count }] = await runsQuery(deps.db, p).count()
  return parseInt(count + '')
}

export const getLatestSucceededRunFactory =
  (deps: { db: Knex }) =>
  (
    p: Scoped & { ruleSetId: string; modelId?: string | null; before?: Date | null }
  ) => {
    const q = runsQuery(deps.db, { ...p, status: 'succeeded' }).orderBy(
      'queuedAt',
      'desc'
    )
    if (p.before) q.andWhere('queuedAt', '<', p.before)
    return q.first()
  }

/** Models that have at least one succeeded, non-preview run of the rule set. */
export const listRunModelIdsFactory =
  (deps: { db: Knex }) => async (p: Scoped & { ruleSetId: string }) => {
    const rows = await runsQuery(deps.db, { ...p, status: 'succeeded' })
      .distinct('modelId')
      .select('modelId')
    return rows.map((r) => r.modelId)
  }

export const getLatestRunFactory =
  (deps: { db: Knex }) => (p: Scoped & { ruleSetId: string }) =>
    runsQuery(deps.db, p).orderBy('queuedAt', 'desc').first()

/**
 * Claims the oldest run the Node worker can process, without blocking other
 * workers (SKIP LOCKED makes concurrent claimers pass over a locked row):
 * native runs waiting in the queue (queued -> running) and IDS runs the
 * Python worker already validated (ids_done -> processing). Queued IDS runs
 * belong to the Python worker and are never claimed here.
 */
export const claimNextQueuedRunFactory = (deps: { db: Knex }) => async () =>
  await deps.db.transaction(async (trx) => {
    const next = await tables
      .runs(trx)
      .where((q) =>
        q.where({ status: 'queued', engine: 'native' }).orWhere({ status: 'ids_done' })
      )
      .orderBy('queuedAt', 'asc')
      .forUpdate()
      .skipLocked()
      .first()
    if (!next) return null
    const native = next.engine === 'native'
    const [claimed] = await tables
      .runs(trx)
      .where({ id: next.id })
      .update({
        status: native ? 'running' : 'processing',
        // the Python worker already counted the attempt of an ids run
        attempt: native ? next.attempt + 1 : next.attempt,
        startedAt: native ? new Date() : next.startedAt,
        error: null
      })
      .returning('*')
    return claimed
  })

/**
 * Runs left mid-flight by a dead process: retry while attempts remain.
 * running / ids_running go back to the queue; processing (Node aggregation
 * of an IDS run) goes back to ids_done, keeping the Python results.
 */
export const recoverStaleRunsFactory =
  (deps: { db: Knex }) => async (p: { staleBefore: Date; maxAttempts: number }) => {
    const stale = () => tables.runs(deps.db).andWhere('startedAt', '<', p.staleBefore)
    const requeued = await stale()
      .whereIn('status', ['running', 'ids_running'])
      .andWhere('attempt', '<', p.maxAttempts)
      .update({ status: 'queued', startedAt: null })
    const reprocessed = await stale()
      .where({ status: 'processing' })
      .andWhere('attempt', '<', p.maxAttempts)
      .update({ status: 'ids_done' })
    const failed = await stale()
      .whereIn('status', ['running', 'ids_running', 'processing'])
      .andWhere('attempt', '>=', p.maxAttempts)
      .update({
        status: 'failed',
        finishedAt: new Date(),
        error: 'Falha ao executar a verificação'
      })
    return { requeued: requeued + reprocessed, failed }
  }

/** Keeps only the newest preview run per (rule set, model). */
export const deleteOlderPreviewRunsFactory =
  (deps: { db: Knex }) =>
  (p: { ruleSetId: string; modelId: string; keepRunId: string }) =>
    tables
      .runs(deps.db)
      .where({ ruleSetId: p.ruleSetId, modelId: p.modelId, trigger: 'preview' })
      .whereNot({ id: p.keepRunId })
      .whereNotIn('status', ACTIVE_RUN_STATUSES)
      .del()

/** Drops per-rule results of all but the newest N runs; aggregates stay. */
export const pruneOldRunResultsFactory =
  (deps: { db: Knex }) =>
  async (p: { ruleSetId: string; modelId: string; keep: number }) => {
    const keepIds = tables
      .runs(deps.db)
      .select('id')
      .where({ ruleSetId: p.ruleSetId, modelId: p.modelId })
      .whereNot({ trigger: 'preview' })
      .orderBy('queuedAt', 'desc')
      .limit(p.keep)
    const oldIds = tables
      .runs(deps.db)
      .select('id')
      .where({ ruleSetId: p.ruleSetId, modelId: p.modelId })
      .whereNot({ trigger: 'preview' })
      .whereNotIn('id', keepIds)
    return await tables.results(deps.db).whereIn('runId', oldIds).del()
  }

// ---- results ----------------------------------------------------------------------

export const insertCheckResultsFactory =
  (deps: { db: Knex }) => async (rows: CoordCheckResultRecord[]) => {
    if (!rows.length) return
    await deps.db.batchInsert(
      CoordCheckResults.name,
      rows.map((r) => ({
        ...r,
        actualValue: r.actualValue === null ? null : JSON.stringify(r.actualValue)
      })),
      INSERT_CHUNK
    )
  }

export const insertElementScoresFactory =
  (deps: { db: Knex }) => async (rows: CoordElementScoreRecord[]) => {
    if (!rows.length) return
    await deps.db.batchInsert(CoordElementScores.name, rows, INSERT_CHUNK)
  }

export const insertRunStatsFactory =
  (deps: { db: Knex }) =>
  async (p: {
    requirementStats: CoordRequirementStatRecord[]
    ruleStats: CoordRuleStatRecord[]
  }) => {
    if (p.requirementStats.length) {
      await deps.db.batchInsert(
        CoordRequirementStats.name,
        p.requirementStats,
        INSERT_CHUNK
      )
    }
    if (p.ruleStats.length) {
      await deps.db.batchInsert(CoordRuleStats.name, p.ruleStats, INSERT_CHUNK)
    }
  }

/**
 * Clears partial output of a run attempt before (re)processing it. IDS runs
 * keep the per-rule results, which come from the Python worker.
 */
export const clearRunOutputFactory =
  (deps: { db: Knex }) => async (p: { runId: string; keepResults?: boolean }) => {
    if (!p.keepResults) await tables.results(deps.db).where({ runId: p.runId }).del()
    await tables.scores(deps.db).where({ runId: p.runId }).del()
    await tables.requirementStats(deps.db).where({ runId: p.runId }).del()
    await tables.ruleStats(deps.db).where({ runId: p.runId }).del()
  }

/** Every per-rule result of a run (IDS aggregation reads what Python wrote). */
export const listRunResultsFactory = (deps: { db: Knex }) => (p: { runId: string }) =>
  tables.results(deps.db).where({ runId: p.runId })

/** IDS results come as pass/fail; failures of warning rules become warn. */
export const downgradeWarningFailuresFactory =
  (deps: { db: Knex }) => (p: { runId: string; ruleIds: string[] }) =>
    p.ruleIds.length
      ? tables
          .results(deps.db)
          .where({ runId: p.runId, status: 'fail' })
          .whereIn('ruleId', p.ruleIds)
          .update({ status: 'warn' })
      : Promise.resolve(0)

export const listRequirementStatsFactory =
  (deps: { db: Knex }) => (p: { runIds: string[] }) =>
    p.runIds.length
      ? tables.requirementStats(deps.db).whereIn('runId', p.runIds)
      : Promise.resolve([] as CoordRequirementStatRecord[])

export const listRuleStatsFactory = (deps: { db: Knex }) => (p: { runId: string }) =>
  tables.ruleStats(deps.db).where({ runId: p.runId })

type ElementFilter = {
  runId: string
  statuses?: CoordElementStatus[] | null
  ruleId?: string | null
  requirementId?: string | null
}

const elementScoresQuery = (db: Knex, p: ElementFilter) => {
  const q = tables.scores(db).where(CoordElementScores.col.runId, p.runId)
  if (p.statuses?.length) q.whereIn(CoordElementScores.col.status, p.statuses)
  return q
}

/**
 * Per-element results restricted to one rule or to a requirement's rules:
 * the status is the worst of those rules only (fail > warn > pass), so a
 * column failing an unrelated rule still shows as passing this requirement.
 * Score isn't meaningful for a subset of rules and comes back null.
 */
const scopedResultsQuery = (db: Knex, p: ElementFilter) => {
  const scoped = db(CoordCheckResults.name)
    .select('elementKey')
    .select(db.raw('max("speckleObjectId") as "speckleObjectId"'))
    .select(
      db.raw(
        "case when bool_or(status = 'fail') then 'fail' when bool_or(status = 'warn') then 'warn' else 'pass' end as status"
      )
    )
    .select(db.raw('null::double precision as score'))
    .where({ runId: p.runId })
    .groupBy('elementKey')
  if (p.ruleId) scoped.andWhere({ ruleId: p.ruleId })
  if (p.requirementId) {
    scoped.whereIn(
      'ruleId',
      db(CoordRules.name).select('id').where({ requirementId: p.requirementId })
    )
  }
  const q = db.from<CoordElementScoreRecord>(scoped.as('scoped'))
  if (p.statuses?.length) q.whereIn('status', p.statuses)
  return q
}

const elementQuery = (db: Knex, p: ElementFilter) =>
  p.ruleId || p.requirementId ? scopedResultsQuery(db, p) : elementScoresQuery(db, p)

/** Ordered by elementKey; cursor = last elementKey of the previous page. */
export const listElementScoresFactory =
  (deps: { db: Knex }) =>
  async (
    p: ElementFilter & { limit: number; cursor?: string | null }
  ): Promise<CoordElementScoreRecord[]> => {
    const q = elementQuery(deps.db, p).orderBy('elementKey').limit(p.limit)
    if (p.cursor) q.andWhere('elementKey', '>', p.cursor)
    return (await q) as CoordElementScoreRecord[]
  }

export const countElementScoresFactory =
  (deps: { db: Knex }) => async (p: ElementFilter) => {
    const [{ count }] = await elementQuery(deps.db, p).count({ count: '*' })
    return parseInt(count + '')
  }

export const getElementScoreFactory =
  (deps: { db: Knex }) => (p: { runId: string; elementKey: string }) =>
    tables.scores(deps.db).where({ runId: p.runId, elementKey: p.elementKey }).first()

export const listElementResultsFactory =
  (deps: { db: Knex }) => (p: { runId: string; elementKey: string }) =>
    tables.results(deps.db).where({ runId: p.runId, elementKey: p.elementKey })

// ---- audit ------------------------------------------------------------------------

export const insertAuditEventFactory =
  (deps: { db: Knex }) => async (row: CoordAuditEventRecord) => {
    await tables.audit(deps.db).insert({
      ...row,
      data: row.data === null ? null : (JSON.stringify(row.data) as never)
    })
  }
