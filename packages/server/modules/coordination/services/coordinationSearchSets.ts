import type { Knex } from 'knex'
import { BadRequestError } from '@/modules/shared/errors'
import { COORD_LIMITS } from '@/modules/coordination/helpers/coordinationTypes'
import type {
  CoordPropertyIndexRecord,
  CoordSearchSetRecord,
  IndexedPath
} from '@/modules/coordination/helpers/searchSetTypes'
import {
  PROPERTY_LIMITS,
  UNINDEXED_ROOT_KEYS,
  searchSetInputSchema,
  searchSetWhereSchema
} from '@/modules/coordination/helpers/searchSetTypes'
import {
  countSearchSetsFactory,
  getPropertyIndexFactory,
  getSearchSetFactory,
  insertPropertyIndexFactory,
  insertSearchSetFactory,
  updateSearchSetFactory
} from '@/modules/coordination/repositories/searchSets'
import {
  assertModelInProjectFactory,
  isUniqueViolation,
  newCoordId,
  parseOrBadRequest,
  resolveModelVersionFactory
} from '@/modules/coordination/services/coordination'
import {
  compileCondition,
  flattenLeaves,
  matchesWhere
} from '@/modules/coordination/services/coordinationEngine'
import { readVersionElementsFactory } from '@/modules/coordination/services/coordinationReader'

/**
 * Phase 2a: the property index of a model version (feeds autocomplete and
 * the bSDD report) and Search Sets (named element selections). See
 * officio-bim-coordination/.ai/plans/2026-10-06-fase2-search-sets-bsdd-ids.md.
 */

const sampleOf = (value: unknown) =>
  (typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(
    0,
    PROPERTY_LIMITS.maxSampleLength
  )

const ifcTypeOf = (data: Record<string, unknown>) =>
  typeof data.ifcType === 'string' && data.ifcType.trim() ? data.ifcType.trim() : null

const nameOf = (data: Record<string, unknown>) =>
  typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null

// ---- property index --------------------------------------------------------------

/**
 * Scans a version once: which property paths exist, in how many elements, a
 * few sample values, and the IFC classes. Versions are immutable, so the
 * result is stored and never recomputed.
 */
export const buildPropertyIndex = async (
  elements: AsyncIterable<{ data: Record<string, unknown> }>
) => {
  const stats = new Map<string, { count: number; samples: Set<string> }>()
  const ifcTypes = new Map<string, number>()
  let elementCount = 0
  let truncated = false

  for await (const { data } of elements) {
    if (elementCount >= COORD_LIMITS.maxElementsPerRun) {
      truncated = true
      break
    }
    elementCount++
    const type = ifcTypeOf(data)
    if (type) ifcTypes.set(type, (ifcTypes.get(type) ?? 0) + 1)

    const seen = new Set<string>()
    for (const leaf of flattenLeaves(data)) {
      if (!leaf.segments.length || UNINDEXED_ROOT_KEYS.has(leaf.segments[0])) continue
      const path = leaf.segments.join('.')
      if (seen.has(path)) continue
      seen.add(path)
      let entry = stats.get(path)
      if (!entry) {
        if (stats.size >= PROPERTY_LIMITS.maxTrackedPaths) {
          truncated = true
          continue
        }
        entry = { count: 0, samples: new Set() }
        stats.set(path, entry)
      }
      entry.count++
      const value = leaf.value
      if (
        entry.samples.size < PROPERTY_LIMITS.samplesPerPath &&
        value !== null &&
        value !== undefined &&
        value !== ''
      ) {
        entry.samples.add(sampleOf(value))
      }
    }
  }

  const ranked = [...stats.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])
  )
  if (ranked.length > PROPERTY_LIMITS.maxIndexedPaths) truncated = true
  const paths: IndexedPath[] = ranked
    .slice(0, PROPERTY_LIMITS.maxIndexedPaths)
    .map(([path, s]) => ({ path, count: s.count, samples: [...s.samples] }))
  return {
    elementCount,
    truncated,
    paths,
    ifcTypes: [...ifcTypes.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  }
}

export const getModelPropertiesFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: {
    projectId: string
    modelId: string
    versionId?: string | null
  }): Promise<CoordPropertyIndexRecord> => {
    const versionId = await resolveModelVersionFactory(deps)(p)
    const cached = await getPropertyIndexFactory(deps)({
      projectId: p.projectId,
      versionId
    })
    if (cached) return cached

    const built = await buildPropertyIndex(
      readVersionElementsFactory(deps)({ projectId: p.projectId, versionId })
    )
    const row: CoordPropertyIndexRecord = {
      versionId,
      projectId: p.projectId,
      modelId: p.modelId,
      ...built,
      createdAt: new Date()
    }
    await insertPropertyIndexFactory(deps)(row)
    return row
  }

// ---- preview -----------------------------------------------------------------------

/** How many elements of a version match the conditions, with a small sample. */
export const previewSearchSetFactory =
  (deps: { projectDb: Knex }) =>
  async (p: {
    projectId: string
    modelId: string
    versionId?: string | null
    where: unknown
  }) => {
    const where = parseOrBadRequest(searchSetWhereSchema, p.where, 'Condições')
    const versionId = await resolveModelVersionFactory(deps)(p)
    const compiled = where.map(compileCondition)

    let elementCount = 0
    let matchCount = 0
    let truncated = false
    const objectIds: string[] = []
    const sample: {
      elementKey: string | null
      speckleObjectId: string
      name: string | null
      ifcType: string | null
    }[] = []
    for await (const el of readVersionElementsFactory(deps)({
      projectId: p.projectId,
      versionId
    })) {
      if (elementCount >= COORD_LIMITS.maxElementsPerRun) {
        truncated = true
        break
      }
      elementCount++
      if (!matchesWhere(compiled, flattenLeaves(el.data))) continue
      matchCount++
      if (objectIds.length < PROPERTY_LIMITS.previewObjectIds) {
        objectIds.push(el.speckleObjectId)
      }
      if (sample.length < PROPERTY_LIMITS.previewSample) {
        sample.push({
          elementKey: el.elementKey,
          speckleObjectId: el.speckleObjectId,
          name: nameOf(el.data),
          ifcType: ifcTypeOf(el.data)
        })
      }
    }
    return { versionId, elementCount, matchCount, truncated, sample, objectIds }
  }

// ---- CRUD ------------------------------------------------------------------------------

const duplicateName = (name: string) => `Já existe um Search Set chamado "${name}"`

export const createSearchSetFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: { projectId: string; userId: string; input: unknown }) => {
    const input = parseOrBadRequest(searchSetInputSchema, p.input, 'Search Set')
    if (input.modelId) {
      await assertModelInProjectFactory(deps)({
        projectId: p.projectId,
        modelId: input.modelId
      })
    }
    const count = await countSearchSetsFactory(deps)({ projectId: p.projectId })
    if (count >= PROPERTY_LIMITS.maxSearchSetsPerProject) {
      throw new BadRequestError(
        `Limite de ${PROPERTY_LIMITS.maxSearchSetsPerProject} Search Sets por projeto`
      )
    }
    try {
      return await insertSearchSetFactory(deps)({
        id: newCoordId(),
        projectId: p.projectId,
        name: input.name,
        description: input.description,
        modelId: input.modelId ?? null,
        where: input.where,
        createdBy: p.userId,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    } catch (err) {
      if (isUniqueViolation(err)) throw new BadRequestError(duplicateName(input.name))
      throw err
    }
  }

export const updateSearchSetServiceFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (p: { current: CoordSearchSetRecord; input: unknown }) => {
    const input = parseOrBadRequest(searchSetInputSchema, p.input, 'Search Set')
    if (input.modelId) {
      await assertModelInProjectFactory(deps)({
        projectId: p.current.projectId,
        modelId: input.modelId
      })
    }
    try {
      return await updateSearchSetFactory(deps)({
        id: p.current.id,
        update: {
          name: input.name,
          description: input.description,
          modelId: input.modelId ?? null,
          where: input.where
        }
      })
    } catch (err) {
      if (isUniqueViolation(err)) throw new BadRequestError(duplicateName(input.name))
      throw err
    }
  }

// ---- clash groups --------------------------------------------------------------------

/**
 * A clash group may point at a Search Set: its conditions are prepended to the
 * group's own when a run is queued, so the run keeps the selection it was
 * started with even if the set changes later.
 */
export const expandClashGroupFactory =
  (deps: { db: Knex }) =>
  async <
    G extends { modelId: string; where: unknown[]; searchSetId?: string | null }
  >(p: {
    projectId: string
    group: G
  }): Promise<G> => {
    if (!p.group.searchSetId) return p.group
    const set = await getSearchSetFactory(deps)({
      projectId: p.projectId,
      id: p.group.searchSetId
    })
    if (!set) throw new BadRequestError('O Search Set do grupo não existe mais')
    if (set.modelId && set.modelId !== p.group.modelId) {
      throw new BadRequestError(`O Search Set "${set.name}" é de outro modelo`)
    }
    return { ...p.group, where: [...set.where, ...p.group.where] }
  }

/** Validates a Search Set referenced by a clash group (same project and model). */
export const assertClashSearchSetFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; modelId: string; searchSetId?: string | null }) => {
    if (!p.searchSetId) return
    const set = await getSearchSetFactory(deps)({
      projectId: p.projectId,
      id: p.searchSetId
    })
    if (!set) throw new BadRequestError('Search Set não pertence a este projeto')
    if (set.modelId && set.modelId !== p.modelId) {
      throw new BadRequestError(`O Search Set "${set.name}" é de outro modelo`)
    }
  }
