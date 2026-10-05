import type { Knex } from 'knex'
import {
  CoordClashes,
  CoordClashRaw,
  CoordClashRunElements,
  CoordClashRuns,
  CoordClashTests
} from '@/modules/core/dbSchema'
import type {
  ClashRunStatus,
  ClashStatus,
  CoordClashRawRecord,
  CoordClashRecord,
  CoordClashRunElementRecord,
  CoordClashRunRecord,
  CoordClashTestRecord
} from '@/modules/coordination/helpers/clashTypes'

/**
 * Clash detection storage. Every read is scoped by projectId (A01); the
 * queue claims use FOR UPDATE SKIP LOCKED like the check runs.
 */

const tables = {
  tests: (db: Knex) => db<CoordClashTestRecord>(CoordClashTests.name),
  runs: (db: Knex) => db<CoordClashRunRecord>(CoordClashRuns.name),
  elements: (db: Knex) => db<CoordClashRunElementRecord>(CoordClashRunElements.name),
  raw: (db: Knex) => db<CoordClashRawRecord>(CoordClashRaw.name),
  clashes: (db: Knex) => db<CoordClashRecord>(CoordClashes.name)
}

type Scoped = { projectId: string }

// ---- tests ------------------------------------------------------------------------

export const listClashTestsFactory = (deps: { db: Knex }) => (p: Scoped) =>
  tables.tests(deps.db).where({ projectId: p.projectId }).orderBy('name')

export const getClashTestFactory =
  (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
    tables.tests(deps.db).where({ id: p.id, projectId: p.projectId }).first()

/** By id only: callers gate on the returned record's projectId. */
export const getClashTestByIdFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.tests(deps.db).where({ id: p.id }).first()

export const insertClashTestFactory =
  (deps: { db: Knex }) => async (row: CoordClashTestRecord) => {
    const [res] = await tables.tests(deps.db).insert(row).returning('*')
    return res
  }

export const updateClashTestFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordClashTestRecord> }) => {
    const [res] = await tables
      .tests(deps.db)
      .where({ id: p.id })
      .update({ ...p.update, updatedAt: new Date() })
      .returning('*')
    return res
  }

export const deleteClashTestFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.tests(deps.db).where({ id: p.id }).delete()

export const listAutoRunClashTestsForModelFactory =
  (deps: { db: Knex }) => (p: Scoped & { modelId: string }) =>
    tables
      .tests(deps.db)
      .where({ projectId: p.projectId, autoRun: true })
      .andWhere((q) =>
        q
          .whereRaw(`"groupA"->>'modelId' = ?`, [p.modelId])
          .orWhereRaw(`"groupB"->>'modelId' = ?`, [p.modelId])
      )

// ---- runs ---------------------------------------------------------------------------

export const ACTIVE_CLASH_RUN_STATUSES: ClashRunStatus[] = [
  'queued',
  'geometry',
  'geometry_running',
  'geometry_done',
  'processing'
]

export const insertClashRunFactory =
  (deps: { db: Knex }) => async (row: CoordClashRunRecord) => {
    const [res] = await tables.runs(deps.db).insert(row).returning('*')
    return res
  }

export const updateClashRunFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordClashRunRecord> }) => {
    const [res] = await tables
      .runs(deps.db)
      .where({ id: p.id })
      .update(p.update)
      .returning('*')
    return res
  }

export const getClashRunFactory =
  (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
    tables.runs(deps.db).where({ id: p.id, projectId: p.projectId }).first()

export const listClashRunsFactory =
  (deps: { db: Knex }) => (p: Scoped & { testId: string; limit: number }) =>
    tables
      .runs(deps.db)
      .where({ projectId: p.projectId, testId: p.testId })
      .orderBy('queuedAt', 'desc')
      .limit(p.limit)

/** An identical run (same test and versions) still in flight, to dedupe. */
export const getActiveClashRunFactory =
  (deps: { db: Knex }) =>
  (p: { testId: string; versionIdA: string; versionIdB: string }) =>
    tables
      .runs(deps.db)
      .where({ testId: p.testId, versionIdA: p.versionIdA, versionIdB: p.versionIdB })
      .whereIn('status', ACTIVE_CLASH_RUN_STATUSES)
      .first()

export const countQueuedClashRunsFactory =
  (deps: { db: Knex }) => async (p: Scoped) => {
    const [row] = await tables
      .runs(deps.db)
      .where({ projectId: p.projectId })
      .whereIn('status', ACTIVE_CLASH_RUN_STATUSES)
      .count<{ count: string }[]>('id as count')
    return Number(row?.count ?? 0)
  }

export const countManualClashRunsSinceFactory =
  (deps: { db: Knex }) => async (p: Scoped & { since: Date }) => {
    const [row] = await tables
      .runs(deps.db)
      .where({ projectId: p.projectId, trigger: 'manual' })
      .andWhere('queuedAt', '>=', p.since)
      .count<{ count: string }[]>('id as count')
    return Number(row?.count ?? 0)
  }

/** The previous finished run of a test, for status carry-over. */
export const getPreviousSucceededClashRunFactory =
  (deps: { db: Knex }) => (p: { testId: string; beforeRunId: string }) =>
    tables
      .runs(deps.db)
      .where({ testId: p.testId, status: 'succeeded' })
      .whereNot({ id: p.beforeRunId })
      .orderBy('queuedAt', 'desc')
      .first()

/**
 * Node side of the queue: `queued` (select elements) and `geometry_done`
 * (post-process). The Python worker owns `geometry` -> `geometry_running`.
 */
export const claimNextClashRunFactory = (deps: { db: Knex }) => async () =>
  await deps.db.transaction(async (trx) => {
    const next = await tables
      .runs(trx)
      .whereIn('status', ['queued', 'geometry_done'])
      .orderBy('queuedAt', 'asc')
      .forUpdate()
      .skipLocked()
      .first()
    if (!next) return null
    const selecting = next.status === 'queued'
    const [claimed] = await tables
      .runs(trx)
      .where({ id: next.id })
      .update(
        selecting
          ? { status: 'processing', startedAt: new Date(), error: null }
          : { status: 'processing' }
      )
      .returning('*')
    return {
      run: claimed,
      phase: selecting ? ('select' as const) : ('finish' as const)
    }
  })

/**
 * Runs left mid-flight by a dead process, and runs that waited too long for
 * memory / the worker: fail them with a message instead of hanging forever.
 */
export const failStaleClashRunsFactory =
  (deps: { db: Knex }) =>
  async (p: { processingBefore: Date; waitingBefore: Date; geometryBefore: Date }) => {
    const processing = await tables
      .runs(deps.db)
      .where({ status: 'processing' })
      .andWhere('startedAt', '<', p.processingBefore)
      .update({
        status: 'failed',
        finishedAt: new Date(),
        error: 'Falha ao processar o clash'
      })
    const waiting = await tables
      .runs(deps.db)
      .whereIn('status', ['queued', 'geometry'])
      .andWhere('queuedAt', '<', p.waitingBefore)
      .update({
        status: 'failed',
        finishedAt: new Date(),
        error:
          'O servidor ficou sem memória livre por muito tempo; tente de novo mais tarde'
      })
    const geometry = await tables
      .runs(deps.db)
      .where({ status: 'geometry_running' })
      .andWhere('startedAt', '<', p.geometryBefore)
      .update({
        status: 'failed',
        finishedAt: new Date(),
        error: 'O cálculo da geometria excedeu o tempo limite'
      })
    return { failed: processing + waiting + geometry }
  }

// ---- elements / raw / clashes --------------------------------------------------------

export const insertClashRunElementsFactory =
  (deps: { db: Knex }) => async (rows: CoordClashRunElementRecord[]) => {
    for (let i = 0; i < rows.length; i += 1000) {
      await tables.elements(deps.db).insert(rows.slice(i, i + 1000))
    }
  }

export const listClashRunElementsFactory =
  (deps: { db: Knex }) => (p: { runId: string }) =>
    tables.elements(deps.db).where({ runId: p.runId })

export const listClashRawFactory = (deps: { db: Knex }) => (p: { runId: string }) =>
  tables.raw(deps.db).where({ runId: p.runId })

export const deleteClashRunWorkFactory =
  (deps: { db: Knex }) => async (p: { runId: string }) => {
    await tables.raw(deps.db).where({ runId: p.runId }).delete()
  }

export const insertClashesFactory =
  (deps: { db: Knex }) => async (rows: CoordClashRecord[]) => {
    for (let i = 0; i < rows.length; i += 1000) {
      await tables.clashes(deps.db).insert(rows.slice(i, i + 1000))
    }
  }

export const listClashesByFingerprintFactory =
  (deps: { db: Knex }) => (p: { runId: string }) =>
    tables
      .clashes(deps.db)
      .where({ runId: p.runId })
      .select('fingerprint', 'status', 'assignee', 'comment')

export const listClashesFactory =
  (deps: { db: Knex }) =>
  (
    p: Scoped & {
      runId: string
      statuses?: ClashStatus[] | null
      keyA?: string | null
      limit: number
      offset: number
    }
  ) => {
    const q = tables
      .clashes(deps.db)
      .where({ projectId: p.projectId, runId: p.runId })
      .orderBy([{ column: 'keyA' }, { column: 'distanceMm' }])
      .limit(p.limit)
      .offset(p.offset)
    if (p.statuses?.length) q.whereIn('status', p.statuses)
    if (p.keyA) q.where({ keyA: p.keyA })
    return q
  }

export const countClashesByStatusFactory =
  (deps: { db: Knex }) => async (p: Scoped & { runId: string }) =>
    (await tables
      .clashes(deps.db)
      .where({ projectId: p.projectId, runId: p.runId })
      .groupBy('status')
      .select('status')
      .count<{ status: ClashStatus; count: string }[]>('id as count')) as {
      status: ClashStatus
      count: string
    }[]

export const getClashesByIdsFactory = (deps: { db: Knex }) => (p: { ids: string[] }) =>
  tables.clashes(deps.db).whereIn('id', p.ids)

export const updateClashesFactory =
  (deps: { db: Knex }) =>
  (p: {
    ids: string[]
    update: Partial<Pick<CoordClashRecord, 'status' | 'assignee' | 'comment'>>
  }) =>
    tables
      .clashes(deps.db)
      .whereIn('id', p.ids)
      .update({ ...p.update, updatedAt: new Date() })

/** Keeps the clash rows of the newest N runs of a test (older runs keep counts). */
export const pruneOldClashesFactory =
  (deps: { db: Knex }) => async (p: { testId: string; keep: number }) => {
    const keepIds = (
      await tables
        .runs(deps.db)
        .where({ testId: p.testId })
        .orderBy('queuedAt', 'desc')
        .limit(p.keep)
        .select('id')
    ).map((r) => r.id)
    if (!keepIds.length) return 0
    return await tables
      .clashes(deps.db)
      .where({ testId: p.testId })
      .whereNotIn('runId', keepIds)
      .delete()
  }
