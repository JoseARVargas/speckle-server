import type { Knex } from 'knex'
import {
  CoordDeliverableRequirements,
  CoordDeliverables,
  CoordMilestones,
  CoordNamingCodes,
  CoordRequirements
} from '@/modules/core/dbSchema'
import type {
  CoordDeliverableRecord,
  CoordDeliverableRequirementRecord,
  CoordNamingCodeRecord,
  DeliverableFilter,
  NamingField
} from '@/modules/coordination/helpers/planningTypes'

/**
 * Information delivery planning storage. Every read is scoped by projectId
 * (A01); callers validate referenced ids against the same project.
 */

const tables = {
  codes: (db: Knex) => db<CoordNamingCodeRecord>(CoordNamingCodes.name),
  deliverables: (db: Knex) => db<CoordDeliverableRecord>(CoordDeliverables.name),
  links: (db: Knex) =>
    db<CoordDeliverableRequirementRecord>(CoordDeliverableRequirements.name)
}

type Scoped = { projectId: string }

// ---- naming codes -------------------------------------------------------------

export const listNamingCodesFactory = (deps: { db: Knex }) => (p: Scoped) =>
  tables
    .codes(deps.db)
    .where({ projectId: p.projectId })
    .orderBy([{ column: 'field' }, { column: 'position' }, { column: 'code' }])

export const replaceNamingCodesFactory =
  (deps: { db: Knex }) =>
  async (p: Scoped & { rows: Omit<CoordNamingCodeRecord, 'projectId'>[] }) =>
    deps.db.transaction(async (trx) => {
      await tables.codes(trx).where({ projectId: p.projectId }).delete()
      if (p.rows.length) {
        await tables
          .codes(trx)
          .insert(p.rows.map((r) => ({ ...r, projectId: p.projectId })))
      }
    })

/** Codes of one field that deliverables of the project still use. */
export const listUsedCodesFactory =
  (deps: { db: Knex }) => async (p: Scoped & { field: NamingField }) =>
    (
      await tables
        .deliverables(deps.db)
        .where({ projectId: p.projectId })
        .distinct(p.field)
    ).map((r) => r[p.field] as string)

// ---- deliverables -------------------------------------------------------------

const applyFilter = (
  q: Knex.QueryBuilder<CoordDeliverableRecord>,
  filter: DeliverableFilter
) => {
  if (filter.originator) q.where('originator', filter.originator)
  if (filter.role) q.where('role', filter.role)
  if (filter.milestoneId) q.where('milestoneId', filter.milestoneId)
  if (filter.status) q.where('status', filter.status)
  return q
}

export const listDeliverablesFactory =
  (deps: { db: Knex }) =>
  (p: Scoped & { filter: DeliverableFilter; limit: number; offset: number }) =>
    applyFilter(
      tables.deliverables(deps.db).where({ projectId: p.projectId }),
      p.filter
    )
      .orderBy('containerName')
      .limit(p.limit)
      .offset(p.offset)

export const countDeliverablesFactory =
  (deps: { db: Knex }) =>
  async (p: Scoped & { filter: DeliverableFilter }): Promise<number> => {
    const row = await applyFilter(
      tables.deliverables(deps.db).where({ projectId: p.projectId }),
      p.filter
    )
      .count<{ count: string }[]>({ count: '*' })
      .first()
    return Number(row?.count ?? 0)
  }

export const getDeliverableFactory =
  (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
    tables.deliverables(deps.db).where({ projectId: p.projectId, id: p.id }).first()

/** Unscoped lookup for mutations: the caller checks access on its projectId. */
export const getDeliverableByIdFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.deliverables(deps.db).where({ id: p.id }).first()

export const insertDeliverablesFactory =
  (deps: { db: Knex }) => async (rows: CoordDeliverableRecord[]) =>
    rows.length ? tables.deliverables(deps.db).insert(rows).returning('*') : []

export const updateDeliverableFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordDeliverableRecord> }) => {
    const [row] = await tables
      .deliverables(deps.db)
      .where({ id: p.id })
      .update({ ...p.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

export const deleteDeliverableFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.deliverables(deps.db).where({ id: p.id }).delete()

/** Highest number already used for this combination of naming codes. */
export const maxDeliverableNumberFactory =
  (deps: { db: Knex }) =>
  async (p: Scoped & { codes: Record<NamingField, string> }): Promise<number> => {
    const row = await tables
      .deliverables(deps.db)
      .where({ projectId: p.projectId, ...p.codes })
      .max<{ max: number | null }[]>({ max: 'number' })
      .first()
    return row?.max ?? 0
  }

export const existingContainerNamesFactory =
  (deps: { db: Knex }) => async (p: Scoped & { names: string[] }) =>
    p.names.length
      ? (
          await tables
            .deliverables(deps.db)
            .where({ projectId: p.projectId })
            .whereIn('containerName', p.names)
            .select('containerName')
        ).map((r) => r.containerName)
      : []

// ---- requirement links ----------------------------------------------------------

export const replaceDeliverableRequirementsFactory =
  (deps: { db: Knex }) =>
  async (p: { deliverableId: string; requirementIds: string[] }) => {
    await tables.links(deps.db).where({ deliverableId: p.deliverableId }).delete()
    if (p.requirementIds.length) {
      await tables.links(deps.db).insert(
        p.requirementIds.map((requirementId) => ({
          deliverableId: p.deliverableId,
          requirementId
        }))
      )
    }
  }

export const listRequirementIdsOfDeliverableFactory =
  (deps: { db: Knex }) => async (p: { deliverableId: string }) =>
    (
      await tables
        .links(deps.db)
        .where({ deliverableId: p.deliverableId })
        .select('requirementId')
    ).map((r) => r.requirementId)

export const listDeliverablesOfRequirementFactory =
  (deps: { db: Knex }) => (p: Scoped & { requirementId: string }) =>
    tables
      .deliverables(deps.db)
      .join(
        CoordDeliverableRequirements.name,
        CoordDeliverableRequirements.col.deliverableId,
        CoordDeliverables.col.id
      )
      .where(CoordDeliverables.col.projectId, p.projectId)
      .andWhere(CoordDeliverableRequirements.col.requirementId, p.requirementId)
      .select<CoordDeliverableRecord[]>(`${CoordDeliverables.name}.*`)
      .orderBy(CoordDeliverables.col.containerName)

// ---- references in the same project (A01) ---------------------------------------

export const findProjectRequirementsFactory =
  (deps: { db: Knex }) => (p: Scoped & { ids?: string[]; codes?: string[] }) => {
    const q = deps
      .db(CoordRequirements.name)
      .where({ projectId: p.projectId })
      .select<{ id: string; code: string }[]>(['id', 'code'])
    if (p.ids) q.whereIn('id', p.ids)
    if (p.codes) q.whereIn('code', p.codes)
    return q
  }

export const findProjectMilestonesFactory =
  (deps: { db: Knex }) => (p: Scoped & { ids?: string[]; names?: string[] }) => {
    const q = deps
      .db(CoordMilestones.name)
      .where({ projectId: p.projectId })
      .select<{ id: string; name: string }[]>(['id', 'name'])
    if (p.ids) q.whereIn('id', p.ids)
    if (p.names) q.whereIn('name', p.names)
    return q
  }
