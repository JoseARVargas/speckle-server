import { FacilityDocuments } from '@/modules/core/dbSchema'
import type {
  DocumentCategory,
  FacilityDocumentRecord
} from '@/modules/facilities/helpers/types'
import type { Knex } from 'knex'

const tables = {
  documents: (db: Knex) => db<FacilityDocumentRecord>(FacilityDocuments.name)
}

export const listFacilityDocumentsFactory =
  (deps: { db: Knex }) =>
  (params: {
    facilityId: string
    limit: number
    cursor?: string | null
    category?: DocumentCategory | null
    assetId?: string | null
    spaceId?: string | null
  }) => {
    const q = tables.documents(deps.db).where({ facilityId: params.facilityId })
    if (params.category) q.andWhere({ category: params.category })
    if (params.assetId) q.andWhere({ assetId: params.assetId })
    if (params.spaceId) q.andWhere({ spaceId: params.spaceId })
    if (params.cursor) q.andWhere('id', '>', params.cursor)
    return q.orderBy('createdAt', 'desc').limit(params.limit)
  }

export const countFacilityDocumentsFactory =
  (deps: { db: Knex }) =>
  async (params: {
    facilityId: string
    category?: DocumentCategory | null
    assetId?: string | null
    spaceId?: string | null
  }) => {
    const q = tables.documents(deps.db).where({ facilityId: params.facilityId })
    if (params.category) q.andWhere({ category: params.category })
    if (params.assetId) q.andWhere({ assetId: params.assetId })
    if (params.spaceId) q.andWhere({ spaceId: params.spaceId })
    const [{ count }] = await q.count()
    return parseInt(count + '')
  }

export const getFacilityDocumentByIdFactory =
  (deps: { db: Knex }) => (params: { id: string }) =>
    tables.documents(deps.db).where({ id: params.id }).first()

export const insertFacilityDocumentFactory =
  (deps: { db: Knex }) => async (document: FacilityDocumentRecord) => {
    const [row] = await tables.documents(deps.db).insert(document).returning('*')
    return row
  }

export const updateFacilityDocumentFactory =
  (deps: { db: Knex }) =>
  async (params: { id: string; update: Partial<FacilityDocumentRecord> }) => {
    const [row] = await tables
      .documents(deps.db)
      .where({ id: params.id })
      .update({ ...params.update, updatedAt: new Date() })
      .returning('*')
    return row
  }

export const deleteFacilityDocumentFactory =
  (deps: { db: Knex }) => (params: { id: string }) =>
    tables.documents(deps.db).where({ id: params.id }).del()
