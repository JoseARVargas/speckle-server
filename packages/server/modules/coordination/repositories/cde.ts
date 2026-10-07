import type { Knex } from 'knex'
import {
  CoordCdeConfigs,
  CoordProjectApprovers,
  CoordVersionStates
} from '@/modules/core/dbSchema'
import type {
  CdeConfig,
  CoordCdeConfigRecord,
  CoordProjectApproverRecord,
  CoordVersionStateRecord
} from '@/modules/coordination/helpers/cdeTypes'

/** ISO 19650 CDE states, approvers and configuration (main database). */

const configs = (db: Knex) => db<CoordCdeConfigRecord>(CoordCdeConfigs.name)
const approvers = (db: Knex) =>
  db<CoordProjectApproverRecord>(CoordProjectApprovers.name)
const states = (db: Knex) => db<CoordVersionStateRecord>(CoordVersionStates.name)

export const getCdeConfigRecordFactory =
  (deps: { db: Knex }) => async (p: { projectId: string }) =>
    (await configs(deps.db).where({ projectId: p.projectId }).first()) ?? null

export const upsertCdeConfigFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; config: CdeConfig; updatedBy: string }) => {
    const [row] = await configs(deps.db)
      .insert({
        projectId: p.projectId,
        config: p.config,
        updatedBy: p.updatedBy,
        updatedAt: new Date()
      })
      .onConflict('projectId')
      .merge()
      .returning('*')
    return row
  }

export const listApproverIdsFactory =
  (deps: { db: Knex }) => async (p: { projectId: string }) =>
    (
      await approvers(deps.db)
        .where({ projectId: p.projectId })
        .orderBy('createdAt')
        .select('userId')
    ).map((r) => r.userId)

export const replaceApproversFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; userIds: string[]; createdBy: string }) =>
    await deps.db.transaction(async (trx) => {
      await approvers(trx).where({ projectId: p.projectId }).delete()
      if (p.userIds.length) {
        await approvers(trx).insert(
          p.userIds.map((userId) => ({
            projectId: p.projectId,
            userId,
            createdBy: p.createdBy,
            createdAt: new Date()
          }))
        )
      }
    })

export const insertVersionStateFactory =
  (deps: { db: Knex }) => async (row: CoordVersionStateRecord) => {
    const [inserted] = await states(deps.db).insert(row).returning('*')
    return inserted
  }

/** Every state row of the model's versions, oldest first (history order). */
export const listModelStatesFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; modelId: string }) =>
    await states(deps.db)
      .where({ projectId: p.projectId, modelId: p.modelId })
      .orderBy([
        { column: 'changedAt', order: 'asc' },
        { column: 'id', order: 'asc' }
      ])

export const listVersionStatesFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; versionId: string }) =>
    await states(deps.db)
      .where({ projectId: p.projectId, versionId: p.versionId })
      .orderBy([
        { column: 'changedAt', order: 'asc' },
        { column: 'id', order: 'asc' }
      ])

/** State codes and suitability codes ever used in the project (history). */
export const listUsedCdeCodesFactory =
  (deps: { db: Knex }) => async (p: { projectId: string }) => {
    const rows = await states(deps.db)
      .where({ projectId: p.projectId })
      .distinct('stateCode', 'suitability')
    return {
      stateCodes: [...new Set(rows.map((r) => r.stateCode))],
      suitability: [
        ...new Set(rows.map((r) => r.suitability).filter((s): s is string => !!s))
      ]
    }
  }
