import type { Knex } from 'knex'

/**
 * OFFICIO fork: blobs that a document record points at belong to that
 * record's module, which has its own (stricter) rules for removing them. The
 * generic REST delete only needs comment-write access, so without this check
 * anyone who can comment could delete a published document's file.
 *
 * facility_documents lives in the project's database; coord_* tables always
 * live in the main one (see the coordination module).
 */
export const isBlobReferencedFactory =
  (deps: { db: Knex; projectDb: Knex }) =>
  async (params: { blobId: string }): Promise<boolean> => {
    const checks: [Knex, string][] = [
      [deps.projectDb, 'facility_documents'],
      [deps.db, 'coord_document_revisions']
    ]
    for (const [conn, table] of checks) {
      const row = await conn(table).where({ blobId: params.blobId }).first('blobId')
      if (row) return true
    }
    return false
  }
