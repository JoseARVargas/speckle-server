import type { Knex } from 'knex'
import crypto from 'crypto'
import { BadRequestError } from '@/modules/shared/errors'
import { moduleLogger } from '@/observability/logging'
import { getProjectDbClient } from '@/modules/multiregion/utils/dbSelector'
import { getEventBus } from '@/modules/shared/services/eventBus'
import { VersionEvents } from '@/modules/core/domain/commits/events'
import type {
  ClashRelation,
  ClashStatus,
  ClashTestInput,
  CoordClashRecord,
  CoordClashRunElementRecord,
  CoordClashRunRecord,
  CoordClashTestRecord
} from '@/modules/coordination/helpers/clashTypes'
import {
  CLASH_LIMITS,
  clashTestInputSchema
} from '@/modules/coordination/helpers/clashTypes'
import {
  claimNextClashRunFactory,
  countManualClashRunsSinceFactory,
  countQueuedClashRunsFactory,
  deleteClashRunWorkFactory,
  failStaleClashRunsFactory,
  getActiveClashRunFactory,
  getPreviousSucceededClashRunFactory,
  insertClashesFactory,
  insertClashRunElementsFactory,
  insertClashRunFactory,
  insertClashTestFactory,
  listAutoRunClashTestsForModelFactory,
  listClashesByFingerprintFactory,
  listClashRawFactory,
  listClashRunElementsFactory,
  pruneOldClashesFactory,
  updateClashRunFactory,
  updateClashTestFactory
} from '@/modules/coordination/repositories/clash'
import {
  assertModelInProjectFactory,
  newCoordId,
  parseOrBadRequest,
  resolveModelVersionFactory
} from '@/modules/coordination/services/coordination'
import {
  compileCondition,
  flattenLeaves,
  matchesWhere
} from '@/modules/coordination/services/coordinationEngine'
import {
  readVersionElementsFactory,
  resolveIfcObjectKeyFactory
} from '@/modules/coordination/services/coordinationReader'
import { CoordRunLimitError } from '@/modules/coordination/services/coordinationRunner'
import {
  assertClashSearchSetFactory,
  expandClashGroupFactory
} from '@/modules/coordination/services/coordinationSearchSets'

/**
 * Clash detection pipeline, Node side (see the migration for the states).
 * The geometry is computed by the Python coord-worker; here: test CRUD,
 * enqueue, element selection with the Model Check WHERE engine, and the
 * post-processing (ignore rules, fingerprints, status carry-over).
 */

// ---- tests ------------------------------------------------------------------------

const assertGroupModelsFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: { projectId: string; input: ClashTestInput }) => {
    for (const group of [p.input.groupA, p.input.groupB]) {
      if (!group) continue
      await assertModelInProjectFactory(deps)({
        projectId: p.projectId,
        modelId: group.modelId
      })
      await assertClashSearchSetFactory(deps)({
        projectId: p.projectId,
        modelId: group.modelId,
        searchSetId: group.searchSetId
      })
    }
  }

export const createClashTestFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: { projectId: string; userId: string; input: unknown }) => {
    const input = parseOrBadRequest(clashTestInputSchema, p.input, 'Teste de clash')
    await assertGroupModelsFactory(deps)({ projectId: p.projectId, input })
    try {
      return await insertClashTestFactory(deps)({
        id: newCoordId(),
        projectId: p.projectId,
        ...input,
        createdBy: p.userId,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new BadRequestError(`Já existe um teste de clash chamado "${input.name}"`)
      }
      throw err
    }
  }

export const updateClashTestServiceFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: { test: CoordClashTestRecord; input: unknown }) => {
    const input = parseOrBadRequest(clashTestInputSchema, p.input, 'Teste de clash')
    await assertGroupModelsFactory(deps)({ projectId: p.test.projectId, input })
    try {
      return await updateClashTestFactory(deps)({ id: p.test.id, update: input })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new BadRequestError(`Já existe um teste de clash chamado "${input.name}"`)
      }
      throw err
    }
  }

// ---- enqueue -----------------------------------------------------------------------

const resolveSideFactory =
  (deps: { projectDb: Knex }) => async (p: { projectId: string; modelId: string }) => {
    const versionId = await resolveModelVersionFactory(deps)({
      projectId: p.projectId,
      modelId: p.modelId
    })
    const objectKey = await resolveIfcObjectKeyFactory(deps)({
      projectId: p.projectId,
      versionId
    })
    if (!objectKey) {
      throw new CoordRunLimitError(
        'A versão mais recente de um dos modelos não veio de um arquivo IFC importado; o clash exige o IFC original'
      )
    }
    return { versionId, objectKey }
  }

/**
 * Queues a clash run on the latest version of each side, or returns the
 * identical run still in flight.
 */
export const enqueueClashRunFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: {
    test: CoordClashTestRecord
    trigger: 'manual' | 'version_created'
    createdBy: string | null
  }): Promise<CoordClashRunRecord> => {
    const { test } = p
    const modelIdB = test.groupB?.modelId ?? test.groupA.modelId
    const a = await resolveSideFactory(deps)({
      projectId: test.projectId,
      modelId: test.groupA.modelId
    })
    const b =
      modelIdB === test.groupA.modelId
        ? a
        : await resolveSideFactory(deps)({
            projectId: test.projectId,
            modelId: modelIdB
          })

    const active = await getActiveClashRunFactory(deps)({
      testId: test.id,
      versionIdA: a.versionId,
      versionIdB: b.versionId
    })
    if (active) return active

    if (
      (await countQueuedClashRunsFactory(deps)({ projectId: test.projectId })) >=
      CLASH_LIMITS.maxQueuedRunsPerProject
    ) {
      throw new CoordRunLimitError(
        'Fila de clash cheia para este projeto; aguarde as execuções em andamento'
      )
    }
    if (p.trigger === 'manual') {
      const since = new Date(Date.now() - 60 * 60 * 1000)
      const count = await countManualClashRunsSinceFactory(deps)({
        projectId: test.projectId,
        since
      })
      if (count >= CLASH_LIMITS.maxManualRunsPerProjectPerHour) {
        throw new CoordRunLimitError(
          'Limite de execuções de clash por hora atingido neste projeto; tente mais tarde'
        )
      }
    }

    return await insertClashRunFactory(deps)({
      id: newCoordId(),
      projectId: test.projectId,
      testId: test.id,
      modelIdA: test.groupA.modelId,
      versionIdA: a.versionId,
      objectKeyA: a.objectKey,
      modelIdB,
      versionIdB: b.versionId,
      objectKeyB: b.objectKey,
      trigger: p.trigger,
      status: 'queued',
      attempt: 0,
      createdBy: p.createdBy,
      settings: {
        type: test.type,
        toleranceMm: test.toleranceMm,
        clearanceMm: test.clearanceMm,
        // Search Sets are expanded now: the run keeps this selection
        groupA: await expandClashGroupFactory(deps)({
          projectId: test.projectId,
          group: test.groupA
        }),
        groupB: test.groupB
          ? await expandClashGroupFactory(deps)({
              projectId: test.projectId,
              group: test.groupB
            })
          : null,
        ignore: test.ignore
      },
      queuedAt: new Date(),
      startedAt: null,
      finishedAt: null,
      error: null,
      countA: 0,
      countB: 0,
      rawCount: 0,
      ignoredCount: 0,
      clashCount: 0,
      geometrySeconds: null,
      peakRssMb: null
    })
  }

/** autoRun tests whose A or B model just got a new version. */
export const onVersionCreatedClashFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; modelId: string }) => {
    const tests = await listAutoRunClashTestsForModelFactory(deps)(p)
    if (!tests.length) return
    const projectDb = await getProjectDbClient({ projectId: p.projectId })
    for (const test of tests) {
      try {
        await enqueueClashRunFactory({ db: deps.db, projectDb })({
          test,
          trigger: 'version_created',
          createdBy: null
        })
      } catch (err) {
        moduleLogger.warn(
          { err, projectId: p.projectId, testId: test.id },
          'Could not queue automatic clash run'
        )
      }
    }
  }

// ---- selection (queued -> geometry) ------------------------------------------------

/**
 * Picks the elements of each group with the Model Check WHERE engine over
 * the Speckle objects of the run's versions. Only keyed elements (GlobalId)
 * can be matched to the IFC geometry; unkeyed ones are skipped.
 */
export const selectClashElementsFactory =
  (deps: { db: Knex; projectDb: Knex }) => async (run: CoordClashRunRecord) => {
    const { settings } = run
    const opening = settings.ignore.plannedOpening
      ? compileCondition(settings.ignore.plannedOpening)
      : null

    const pick = async (
      versionId: string,
      where: CoordClashTestRecord['groupA']['where']
    ) => {
      const compiled = where.map(compileCondition)
      const picked = new Map<
        string,
        { speckleObjectId: string; plannedOpening: boolean }
      >()
      for await (const el of readVersionElementsFactory(deps)({
        projectId: run.projectId,
        versionId
      })) {
        if (!el.elementKey) continue
        const leaves = flattenLeaves(el.data)
        if (!matchesWhere(compiled, leaves)) continue
        picked.set(el.elementKey, {
          speckleObjectId: el.speckleObjectId,
          plannedOpening: opening ? opening.evaluate(leaves).passed : false
        })
        if (picked.size > CLASH_LIMITS.maxElementsPerGroup) {
          throw new CoordRunLimitError(
            `Um dos grupos passa de ${CLASH_LIMITS.maxElementsPerGroup} elementos; refine as condições do grupo`
          )
        }
      }
      return picked
    }

    const groupA = await pick(run.versionIdA, settings.groupA.where)
    const groupB = settings.groupB
      ? await pick(run.versionIdB, settings.groupB.where)
      : groupA
    if (!groupA.size || !groupB.size) {
      throw new CoordRunLimitError(
        'Um dos grupos não tem elementos; confira o modelo e as condições do teste'
      )
    }

    const rows: CoordClashRunElementRecord[] = []
    for (const [side, group] of [
      ['a', groupA],
      ['b', groupB]
    ] as const) {
      for (const [elementKey, v] of group) {
        rows.push({ runId: run.id, side, elementKey, ...v })
      }
    }
    await insertClashRunElementsFactory(deps)(rows)
    return await updateClashRunFactory(deps)({
      id: run.id,
      update: { status: 'geometry', countA: groupA.size, countB: groupB.size }
    })
  }

// ---- post-processing (geometry_done -> succeeded) ----------------------------------

/** Order-independent identity of a clash within a test. */
export const clashFingerprint = (keyA: string, keyB: string, testId: string) => {
  const [lo, hi] = keyA < keyB ? [keyA, keyB] : [keyB, keyA]
  return crypto.createHash('sha1').update(`${lo}|${hi}|${testId}`).digest('hex')
}

/** A clash seen before keeps its triage; new or reappearing ones are active again. */
export const carriedStatus = (previous: ClashStatus | undefined): ClashStatus => {
  if (!previous) return 'new'
  if (previous === 'new' || previous === 'resolved') return 'active'
  return previous
}

const ignoredByRelation = (
  relation: ClashRelation | null,
  ignore: CoordClashRunRecord['settings']['ignore']
) =>
  (relation === 'hosted' && ignore.hosted) ||
  (relation === 'connected' && ignore.connected) ||
  (relation === 'same_system' && ignore.sameSystem)

export const finishClashRunFactory =
  (deps: { db: Knex }) => async (run: CoordClashRunRecord) => {
    const { ignore } = run.settings
    const elements = await listClashRunElementsFactory(deps)({ runId: run.id })
    const bySide = {
      a: new Map(elements.filter((e) => e.side === 'a').map((e) => [e.elementKey, e])),
      b: new Map(elements.filter((e) => e.side === 'b').map((e) => [e.elementKey, e]))
    }
    const raw = await listClashRawFactory(deps)({ runId: run.id })

    const previousRun = await getPreviousSucceededClashRunFactory(deps)({
      testId: run.testId,
      beforeRunId: run.id
    })
    const previous = new Map(
      previousRun
        ? (await listClashesByFingerprintFactory(deps)({ runId: previousRun.id })).map(
            (c) => [c.fingerprint, c]
          )
        : []
    )

    const seen = new Set<string>()
    const clashes: CoordClashRecord[] = []
    let ignored = 0
    for (const pair of raw) {
      const a = bySide.a.get(pair.keyA)
      const b = bySide.b.get(pair.keyB)
      const sameElement = pair.keyA === pair.keyB
      const fingerprint = clashFingerprint(pair.keyA, pair.keyB, run.testId)
      if (
        (sameElement && ignore.sameElement) ||
        ignoredByRelation(pair.relation, ignore) ||
        a?.plannedOpening ||
        b?.plannedOpening
      ) {
        ignored++
        continue
      }
      // A x A reports (x, y) and (y, x): keep one
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      const before = previous.get(fingerprint)
      clashes.push({
        id: newCoordId(),
        projectId: run.projectId,
        runId: run.id,
        testId: run.testId,
        fingerprint,
        keyA: pair.keyA,
        keyB: pair.keyB,
        speckleObjectIdA: a?.speckleObjectId ?? null,
        speckleObjectIdB: b?.speckleObjectId ?? null,
        distanceMm: pair.distanceMm,
        point: pair.point,
        clashType: pair.clashType,
        status: carriedStatus(before?.status),
        assignee: before?.assignee ?? null,
        comment: before?.comment ?? null,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    }

    await insertClashesFactory(deps)(clashes)
    await deleteClashRunWorkFactory(deps)({ runId: run.id })
    await pruneOldClashesFactory(deps)({
      testId: run.testId,
      keep: CLASH_LIMITS.keptRunsPerTest
    })
    return await updateClashRunFactory(deps)({
      id: run.id,
      update: {
        status: 'succeeded',
        finishedAt: new Date(),
        rawCount: raw.length,
        ignoredCount: ignored,
        clashCount: clashes.length,
        error: null
      }
    })
  }

// ---- queue worker -----------------------------------------------------------------

const CLASH_WORKER_INTERVAL_SECONDS = 5
const CLASH_PROCESSING_STALE_MINUTES = 30
const CLASH_GEOMETRY_STALE_MINUTES = 75
const GENERIC_CLASH_ERROR = 'Falha ao executar o clash'

/** Claims the Node-side clash work (selection / post-processing) until none is left. */
export const drainClashQueueFactory = (deps: { db: Knex }) => async () => {
  for (;;) {
    const claimed = await claimNextClashRunFactory(deps)()
    if (!claimed) return
    const { run, phase } = claimed
    try {
      if (phase === 'select') {
        const projectDb = await getProjectDbClient({ projectId: run.projectId })
        await selectClashElementsFactory({ db: deps.db, projectDb })(run)
      } else {
        await finishClashRunFactory(deps)(run)
        moduleLogger.info(
          { runId: run.id, projectId: run.projectId },
          'Clash run finished'
        )
      }
    } catch (err) {
      moduleLogger.error(
        { err, runId: run.id, projectId: run.projectId },
        'Clash run failed'
      )
      await deleteClashRunWorkFactory(deps)({ runId: run.id }).catch(() => undefined)
      await updateClashRunFactory(deps)({
        id: run.id,
        update: {
          status: 'failed',
          finishedAt: new Date(),
          error: err instanceof CoordRunLimitError ? err.message : GENERIC_CLASH_ERROR
        }
      })
    }
  }
}

let clashDrainInFlight = false

/**
 * In-process worker for the Node side of clash runs plus the autoRun
 * listener. Never takes the server down; tests drain explicitly.
 */
export const startClashWorker = (deps: { db: Knex; pollQueue: boolean }) => {
  const drain = drainClashQueueFactory(deps)
  const failStale = failStaleClashRunsFactory(deps)
  const interval = setInterval(() => {
    if (!deps.pollQueue || clashDrainInFlight) return
    clashDrainInFlight = true
    const now = Date.now()
    failStale({
      processingBefore: new Date(now - CLASH_PROCESSING_STALE_MINUTES * 60_000),
      waitingBefore: new Date(now - CLASH_LIMITS.maxWaitMinutes * 60_000),
      geometryBefore: new Date(now - CLASH_GEOMETRY_STALE_MINUTES * 60_000)
    })
      .then((res) => {
        if (res.failed) moduleLogger.warn(res, 'Failed stale clash runs')
      })
      .then(drain)
      .catch((err) => moduleLogger.error({ err }, 'Clash worker tick failed'))
      .finally(() => {
        clashDrainInFlight = false
      })
  }, CLASH_WORKER_INTERVAL_SECONDS * 1000)
  interval.unref?.()

  const onVersionCreated = onVersionCreatedClashFactory(deps)
  const quit = getEventBus().listen(
    VersionEvents.Created,
    async ({ payload: { projectId, modelId } }) => {
      try {
        await onVersionCreated({ projectId, modelId })
      } catch (err) {
        moduleLogger.error({ err, projectId, modelId }, 'Clash auto-run failed')
      }
    }
  )
  return () => {
    clearInterval(interval)
    quit()
  }
}
