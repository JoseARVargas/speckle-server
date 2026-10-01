import type { Knex } from 'knex'
import cryptoRandomString from 'crypto-random-string'
import { moduleLogger } from '@/observability/logging'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { getEventBus } from '@/modules/shared/services/eventBus'
import { VersionEvents } from '@/modules/core/domain/commits/events'
import type {
  CoordCheckResultRecord,
  CoordCheckRunRecord,
  CoordElementScoreRecord,
  CoordRequirementStatRecord,
  CoordRuleRecord,
  CoordRuleStatRecord,
  CoordRunTrigger
} from '@/modules/facilities/helpers/coordinationTypes'
import {
  COORD_LIMITS,
  coordRuleDefinitionSchema
} from '@/modules/facilities/helpers/coordinationTypes'
import {
  claimNextQueuedRunFactory,
  clearRunOutputFactory,
  countQueuedRunsFactory,
  deleteOlderPreviewRunsFactory,
  getActiveRunFactory,
  getBindingFactory,
  getLatestPublishedVersionFactory,
  insertCheckResultsFactory,
  insertCheckRunFactory,
  insertElementScoresFactory,
  insertRunStatsFactory,
  listAutoRunBindingsForModelFactory,
  listRulesFactory,
  pruneOldRunResultsFactory,
  recoverStaleRunsFactory,
  updateCheckRunFactory
} from '@/modules/facilities/repositories/coordination'
import {
  compileRule,
  evaluateElement
} from '@/modules/facilities/services/coordinationEngine'
import { readVersionElementsFactory } from '@/modules/facilities/services/coordinationReader'

const WORKER_INTERVAL_SECONDS = 5
const STALE_RUN_MINUTES = 30
const MAX_ATTEMPTS = 3
const ELEMENT_BATCH = 500
const RESULT_FLUSH = 5000
const UNKEYED_SAMPLE_SIZE = 50
const DEFAULT_UNKEYED_BLOCK_PCT = 2

const GENERIC_RUN_ERROR = 'Falha ao executar a verificação'

/** A failure whose message is safe and useful to show the user as-is. */
export class CoordRunLimitError extends Error {}

// ---- enqueue --------------------------------------------------------------------

export type EnqueueResult = { run: CoordCheckRunRecord; deduplicated: boolean }

/**
 * Queues a run, or returns the one already queued/running for the same
 * rule set version + model version (so double clicks and repeated events
 * don't pile up identical work).
 */
export const enqueueCheckRunFactory =
  (deps: { db: Knex }) =>
  async (params: {
    projectId: string
    ruleSetId: string
    ruleSetVersionId: string
    modelId: string
    versionId: string
    trigger: CoordRunTrigger
    createdBy: string | null
  }): Promise<EnqueueResult> => {
    const active = await getActiveRunFactory(deps)({
      ruleSetVersionId: params.ruleSetVersionId,
      versionId: params.versionId
    })
    if (active) return { run: active, deduplicated: true }

    const queued = await countQueuedRunsFactory(deps)({ projectId: params.projectId })
    if (queued >= COORD_LIMITS.maxQueuedRunsPerProject) {
      throw new CoordRunLimitError(
        'Fila de verificações cheia para este projeto; aguarde as execuções em andamento'
      )
    }

    const binding = await getBindingFactory(deps)({
      ruleSetId: params.ruleSetId,
      modelId: params.modelId
    })
    const run = await insertCheckRunFactory(deps)({
      id: cryptoRandomString({ length: 10 }),
      projectId: params.projectId,
      ruleSetId: params.ruleSetId,
      ruleSetVersionId: params.ruleSetVersionId,
      modelId: params.modelId,
      versionId: params.versionId,
      trigger: params.trigger,
      status: 'queued',
      attempt: 0,
      createdBy: params.createdBy,
      unkeyedBlockPct: binding?.unkeyedBlockPct ?? DEFAULT_UNKEYED_BLOCK_PCT,
      queuedAt: new Date(),
      startedAt: null,
      finishedAt: null,
      error: null,
      elementCount: 0,
      applicableCount: 0,
      passCount: 0,
      warnCount: 0,
      failCount: 0,
      naCount: 0,
      unkeyedCount: 0,
      adherence: null,
      unkeyedSample: []
    })
    return { run, deduplicated: false }
  }

// ---- version created -> auto runs ------------------------------------------------

export const onVersionCreatedFactory =
  (deps: { db: Knex }) =>
  async (params: { projectId: string; modelId: string; versionId: string }) => {
    const bindings = await listAutoRunBindingsForModelFactory(deps)({
      projectId: params.projectId,
      modelId: params.modelId
    })
    for (const binding of bindings) {
      const published = await getLatestPublishedVersionFactory(deps)({
        ruleSetId: binding.ruleSetId
      })
      if (!published) continue
      try {
        await enqueueCheckRunFactory(deps)({
          projectId: params.projectId,
          ruleSetId: binding.ruleSetId,
          ruleSetVersionId: published.id,
          modelId: params.modelId,
          versionId: params.versionId,
          trigger: 'version_created',
          createdBy: null
        })
      } catch (err) {
        moduleLogger.warn(
          { err, projectId: params.projectId, ruleSetId: binding.ruleSetId },
          'Could not queue automatic coordination check'
        )
      }
    }
  }

// ---- processing ------------------------------------------------------------------

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

const parseRules = (rules: CoordRuleRecord[]) =>
  rules.map((rule) => {
    const definition = coordRuleDefinitionSchema.parse(rule.definition)
    return {
      record: rule,
      compiled: compileRule({
        id: rule.id,
        severity: rule.severity,
        weight: rule.weight,
        definition
      })
    }
  })

/**
 * Evaluates every rule of the run's rule set version against every element
 * of the model version and persists results, per-element scores and
 * per-rule / per-requirement aggregates. Fails closed: a run over the
 * unkeyed threshold ends `blocked` with no results.
 */
export const processCheckRunFactory =
  (deps: { db: Knex; projectDb: Knex }) => async (run: CoordCheckRunRecord) => {
    const startedAt = Date.now()
    const rules = parseRules(
      await listRulesFactory({ db: deps.db })({
        ruleSetVersionId: run.ruleSetVersionId
      })
    )
    const ruleById = new Map(rules.map((r) => [r.record.id, r.record]))
    const compiled = rules.map((r) => r.compiled)

    const clearOutput = clearRunOutputFactory({ db: deps.db })
    await clearOutput({ runId: run.id })
    const insertResults = insertCheckResultsFactory({ db: deps.db })
    const insertScores = insertElementScoresFactory({ db: deps.db })

    const seenKeys = new Set<string>()
    const unkeyedSample: string[] = []
    const ruleStats = new Map<string, CoordRuleStatRecord>()
    let elementCount = 0
    let unkeyedCount = 0
    let pass = 0
    let warn = 0
    let fail = 0
    let na = 0
    let scoreSum = 0
    let pendingResults: CoordCheckResultRecord[] = []
    let pendingScores: CoordElementScoreRecord[] = []

    const flush = async () => {
      await insertResults(pendingResults)
      await insertScores(pendingScores)
      pendingResults = []
      pendingScores = []
    }

    const elements = readVersionElementsFactory({ projectDb: deps.projectDb })({
      projectId: run.projectId,
      versionId: run.versionId
    })
    for await (const element of elements) {
      elementCount++
      if (elementCount > COORD_LIMITS.maxElementsPerRun) {
        throw new CoordRunLimitError(
          'Modelo grande demais para a verificação (limite de elementos excedido)'
        )
      }
      if (elementCount % ELEMENT_BATCH === 0) {
        await yieldToEventLoop()
        if ((Date.now() - startedAt) / 1000 > COORD_LIMITS.maxRunSeconds) {
          throw new CoordRunLimitError(
            'Modelo grande demais para a verificação (tempo limite excedido)'
          )
        }
      }

      // Missing or duplicated applicationId: no stable key, so no result
      if (!element.elementKey || seenKeys.has(element.elementKey)) {
        unkeyedCount++
        if (unkeyedSample.length < UNKEYED_SAMPLE_SIZE) {
          unkeyedSample.push(element.speckleObjectId)
        }
        continue
      }
      seenKeys.add(element.elementKey)

      const evaluation = evaluateElement(compiled, element.data)
      if (evaluation.status === 'na') na++
      else {
        if (evaluation.status === 'pass') pass++
        else if (evaluation.status === 'warn') warn++
        else fail++
        scoreSum += evaluation.score ?? 0
      }
      pendingScores.push({
        runId: run.id,
        elementKey: element.elementKey,
        speckleObjectId: element.speckleObjectId,
        status: evaluation.status,
        score: evaluation.score
      })
      for (const result of evaluation.results) {
        pendingResults.push({
          runId: run.id,
          ruleId: result.ruleId,
          elementKey: element.elementKey,
          speckleObjectId: element.speckleObjectId,
          status: result.status,
          actualValue: result.actualValue,
          message: result.message
        })
        const stat = ruleStats.get(result.ruleId) ?? {
          runId: run.id,
          ruleId: result.ruleId,
          applicableCount: 0,
          passCount: 0,
          warnCount: 0,
          failCount: 0
        }
        stat.applicableCount++
        if (result.status === 'pass') stat.passCount++
        else if (result.status === 'warn') stat.warnCount++
        else stat.failCount++
        ruleStats.set(result.ruleId, stat)
      }
      if (
        pendingResults.length >= RESULT_FLUSH ||
        pendingScores.length >= RESULT_FLUSH
      ) {
        await flush()
      }
    }
    await flush()

    const applicable = pass + warn + fail
    const counts = {
      elementCount,
      applicableCount: applicable,
      passCount: pass,
      warnCount: warn,
      failCount: fail,
      naCount: na,
      unkeyedCount,
      unkeyedSample,
      adherence: applicable ? scoreSum / applicable : null
    }

    const unkeyedPct = elementCount ? (unkeyedCount / elementCount) * 100 : 0
    if (unkeyedPct > run.unkeyedBlockPct) {
      await clearOutput({ runId: run.id })
      return await updateCheckRunFactory({ db: deps.db })({
        id: run.id,
        update: {
          ...counts,
          status: 'blocked',
          finishedAt: new Date(),
          error: `Verificação bloqueada: ${unkeyedPct.toFixed(
            1
          )}% dos elementos sem applicationId (limite ${run.unkeyedBlockPct}%)`
        }
      })
    }

    const requirementStats = new Map<string, CoordRequirementStatRecord>()
    for (const stat of ruleStats.values()) {
      const requirementId = ruleById.get(stat.ruleId)?.requirementId
      if (!requirementId) continue
      const agg = requirementStats.get(requirementId) ?? {
        runId: run.id,
        requirementId,
        applicableCount: 0,
        passCount: 0
      }
      agg.applicableCount += stat.applicableCount
      agg.passCount += stat.passCount
      requirementStats.set(requirementId, agg)
    }
    await insertRunStatsFactory({ db: deps.db })({
      ruleStats: [...ruleStats.values()],
      requirementStats: [...requirementStats.values()]
    })

    const finished = await updateCheckRunFactory({ db: deps.db })({
      id: run.id,
      update: { ...counts, status: 'succeeded', finishedAt: new Date(), error: null }
    })

    if (run.trigger === 'preview') {
      await deleteOlderPreviewRunsFactory({ db: deps.db })({
        ruleSetId: run.ruleSetId,
        modelId: run.modelId,
        keepRunId: run.id
      })
    } else {
      await pruneOldRunResultsFactory({ db: deps.db })({
        ruleSetId: run.ruleSetId,
        modelId: run.modelId,
        keep: COORD_LIMITS.keptFullResultRuns
      })
    }
    return finished
  }

/** Claims and processes queued runs until the queue is empty. */
export const drainCheckRunQueueFactory = (deps: { db: Knex }) => async () => {
  for (;;) {
    const run = await claimNextQueuedRunFactory(deps)()
    if (!run) return
    try {
      const projectDb = await getProjectDbClient({ projectId: run.projectId })
      await processCheckRunFactory({ db: deps.db, projectDb })(run)
      moduleLogger.info(
        { runId: run.id, projectId: run.projectId },
        'Coordination check run finished'
      )
    } catch (err) {
      moduleLogger.error(
        { err, runId: run.id, projectId: run.projectId },
        'Coordination check run failed'
      )
      await clearRunOutputFactory(deps)({ runId: run.id }).catch(() => undefined)
      await updateCheckRunFactory(deps)({
        id: run.id,
        update: {
          status: 'failed',
          finishedAt: new Date(),
          error: err instanceof CoordRunLimitError ? err.message : GENERIC_RUN_ERROR
        }
      })
    }
  }
}

// ---- process wiring --------------------------------------------------------------

let drainInFlight = false

/**
 * Starts the in-process queue worker and the version-created listener.
 * Neither may ever take the server down: every failure is logged and the
 * next tick tries again. Tests disable polling and drain the queue
 * explicitly, so a background tick never races the assertions.
 */
export const startCoordinationWorker = (deps: { db: Knex; pollQueue: boolean }) => {
  recoverStaleRunsFactory(deps)({
    staleBefore: new Date(Date.now() - STALE_RUN_MINUTES * 60 * 1000),
    maxAttempts: MAX_ATTEMPTS
  })
    .then((res) => {
      if (res.requeued || res.failed) {
        moduleLogger.warn(res, 'Recovered stale coordination check runs')
      }
    })
    .catch((err) =>
      moduleLogger.error({ err }, 'Stale coordination run recovery failed')
    )

  const drain = drainCheckRunQueueFactory(deps)
  const interval = setInterval(() => {
    if (!deps.pollQueue) return
    if (drainInFlight) return
    drainInFlight = true
    drain()
      .catch((err) => moduleLogger.error({ err }, 'Coordination worker tick failed'))
      .finally(() => {
        drainInFlight = false
      })
  }, WORKER_INTERVAL_SECONDS * 1000)
  interval.unref?.()

  const onVersionCreated = onVersionCreatedFactory(deps)
  const quit = getEventBus().listen(
    VersionEvents.Created,
    async ({ payload: { projectId, modelId, version } }) => {
      try {
        await onVersionCreated({ projectId, modelId, versionId: version.id })
      } catch (err) {
        moduleLogger.error({ err, projectId, modelId }, 'Coordination auto-run failed')
      }
    }
  )

  return () => {
    clearInterval(interval)
    quit()
  }
}
