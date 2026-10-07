import type { Knex } from 'knex'
import { CoordPropertyIndex, CoordSearchSets } from '@/modules/core/dbSchema'
import type {
  CoordPropertyIndexRecord,
  CoordSearchSetRecord
} from '@/modules/coordination/helpers/searchSetTypes'

/**
 * Property index and Search Sets storage. Every read is scoped by projectId
 * (A01); the jsonb columns are written as JSON strings.
 */

const tables = {
  index: (db: Knex) => db<CoordPropertyIndexRecord>(CoordPropertyIndex.name),
  sets: (db: Knex) => db<CoordSearchSetRecord>(CoordSearchSets.name)
}

type Scoped = { projectId: string }

// ---- property index ---------------------------------------------------------------

export const getPropertyIndexFactory =
  (deps: { db: Knex }) => (p: Scoped & { versionId: string }) =>
    tables
      .index(deps.db)
      .where({ projectId: p.projectId, versionId: p.versionId })
      .first()

/** Two concurrent builds of the same version: the first one wins. */
export const insertPropertyIndexFactory =
  (deps: { db: Knex }) => async (row: CoordPropertyIndexRecord) => {
    await tables
      .index(deps.db)
      .insert({
        ...row,
        paths: JSON.stringify(
          row.paths
        ) as unknown as CoordPropertyIndexRecord['paths'],
        ifcTypes: JSON.stringify(
          row.ifcTypes
        ) as unknown as CoordPropertyIndexRecord['ifcTypes']
      })
      .onConflict('versionId')
      .ignore()
  }

// ---- search sets ---------------------------------------------------------------------

const serialize = (row: Partial<CoordSearchSetRecord>) =>
  row.where
    ? {
        ...row,
        where: JSON.stringify(row.where) as unknown as CoordSearchSetRecord['where']
      }
    : row

export const listSearchSetsFactory = (deps: { db: Knex }) => (p: Scoped) =>
  tables.sets(deps.db).where({ projectId: p.projectId }).orderBy('name')

export const countSearchSetsFactory =
  (deps: { db: Knex }) =>
  async (p: Scoped): Promise<number> =>
    Number(
      (
        await tables
          .sets(deps.db)
          .where({ projectId: p.projectId })
          .count<{ count: string }[]>({ count: '*' })
          .first()
      )?.count ?? 0
    )

export const getSearchSetFactory =
  (deps: { db: Knex }) => (p: Scoped & { id: string }) =>
    tables.sets(deps.db).where({ projectId: p.projectId, id: p.id }).first()

/** Unscoped lookup for mutations: the caller checks access on its projectId. */
export const getSearchSetByIdFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.sets(deps.db).where({ id: p.id }).first()

export const insertSearchSetFactory =
  (deps: { db: Knex }) => async (row: CoordSearchSetRecord) => {
    const [created] = await tables
      .sets(deps.db)
      .insert(serialize(row) as CoordSearchSetRecord)
      .returning('*')
    return created
  }

export const updateSearchSetFactory =
  (deps: { db: Knex }) =>
  async (p: { id: string; update: Partial<CoordSearchSetRecord> }) => {
    const [row] = await tables
      .sets(deps.db)
      .where({ id: p.id })
      .update({ ...serialize(p.update), updatedAt: new Date() })
      .returning('*')
    return row
  }

export const deleteSearchSetFactory = (deps: { db: Knex }) => (p: { id: string }) =>
  tables.sets(deps.db).where({ id: p.id }).delete()

/** Names of the clash tests whose group A or B points at the Search Set. */
export const listClashTestsUsingSearchSetFactory =
  (deps: { db: Knex }) =>
  async (p: Scoped & { searchSetId: string }): Promise<string[]> =>
    (
      await deps
        .db('coord_clash_tests')
        .where({ projectId: p.projectId })
        .andWhere((q) =>
          q
            .whereRaw(`"groupA"->>'searchSetId' = ?`, [p.searchSetId])
            .orWhereRaw(`"groupB"->>'searchSetId' = ?`, [p.searchSetId])
        )
        .select<{ name: string }[]>('name')
    ).map((r) => r.name)
