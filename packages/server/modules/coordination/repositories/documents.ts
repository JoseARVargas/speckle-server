import type { Knex } from 'knex'
import { CoordDocumentRevisions, CoordVersionStates } from '@/modules/core/dbSchema'
import type {
  CoordDocumentRevisionRecord,
  CoordVersionStateRecord
} from '@/modules/coordination/helpers/cdeTypes'

/** Document revisions of deliverables (main database, like every coord_* table). */

const revisions = (db: Knex) =>
  db<CoordDocumentRevisionRecord>(CoordDocumentRevisions.name)
const states = (db: Knex) => db<CoordVersionStateRecord>(CoordVersionStates.name)

export const insertDocumentRevisionFactory =
  (deps: { db: Knex }) => async (row: CoordDocumentRevisionRecord) => {
    const [inserted] = await revisions(deps.db).insert(row).returning('*')
    return inserted
  }

/** Newest first. */
export const listDocumentRevisionsFactory =
  (deps: { db: Knex }) => (p: { projectId: string; deliverableId: string }) =>
    revisions(deps.db)
      .where({ projectId: p.projectId, deliverableId: p.deliverableId })
      .orderBy([
        { column: 'createdAt', order: 'desc' },
        { column: 'id', order: 'desc' }
      ])

export const countDocumentRevisionsFactory =
  (deps: { db: Knex }) => async (p: { deliverableId: string }) => {
    const [{ count }] = await revisions(deps.db)
      .where({ deliverableId: p.deliverableId })
      .count()
    return parseInt(count + '')
  }

export const getDocumentRevisionFactory =
  (deps: { db: Knex }) => (p: { projectId: string; id: string }) =>
    revisions(deps.db).where({ projectId: p.projectId, id: p.id }).first()

/** Unscoped lookup - only for resolving the projectId of a mutation target. */
export const getDocumentRevisionByIdFactory =
  (deps: { db: Knex }) => (p: { id: string }) =>
    revisions(deps.db).where({ id: p.id }).first()

export const findDocumentRevisionByHashFactory =
  (deps: { db: Knex }) => (p: { deliverableId: string; sha256: string }) =>
    revisions(deps.db)
      .where({ deliverableId: p.deliverableId, sha256: p.sha256 })
      .first()

export const deleteDocumentRevisionFactory =
  (deps: { db: Knex }) => (p: { id: string }) =>
    revisions(deps.db).where({ id: p.id }).del()

/** CDE rows of every revision of the deliverable, oldest first (history order). */
export const listDocumentStatesFactory =
  (deps: { db: Knex }) => (p: { projectId: string; deliverableId: string }) =>
    states(deps.db)
      .where({ projectId: p.projectId, deliverableId: p.deliverableId })
      .whereNotNull('documentRevisionId')
      .orderBy([
        { column: 'changedAt', order: 'asc' },
        { column: 'id', order: 'asc' }
      ])
