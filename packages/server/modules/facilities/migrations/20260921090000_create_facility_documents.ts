import type { Knex } from 'knex'

const FACILITIES = 'facilities'
const ASSETS = 'assets'
const SPACES = 'spaces'
const FACILITY_DOCUMENTS = 'facility_documents'

/**
 * Documents (plantas, manuais, ARTs, ...) attached to a facility, optionally
 * scoped to one Asset or Space. The file itself lives in Speckle's own
 * generic blob storage (POST/GET/DELETE /api/stream/:projectId/blob... -
 * see modules/blobstorage/rest/router.ts - unrelated to the model-import
 * pipeline used by the "Modelos" tab). This table only tracks the blobId
 * plus the facility-specific metadata blob storage doesn't have.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(FACILITY_DOCUMENTS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table
      .string('facilityId', 10)
      .notNullable()
      .references('id')
      .inTable(FACILITIES)
      .onDelete('cascade')
    table
      .string('assetId', 10)
      .nullable()
      .references('id')
      .inTable(ASSETS)
      .onDelete('set null')
    table
      .string('spaceId', 10)
      .nullable()
      .references('id')
      .inTable(SPACES)
      .onDelete('set null')
    table.string('title').notNullable()
    table.string('category').nullable() // 'drawing' | 'manual' | 'art' | 'other'
    table.text('description').nullable()
    table.string('blobId').notNullable()
    table.string('fileName').notNullable()
    table.integer('fileSize').nullable()
    table
      .string('uploadedBy', 10)
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('set null')
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable(FACILITY_DOCUMENTS, (table) => {
    table.index('projectId')
    table.index('facilityId')
    table.index('assetId')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(FACILITY_DOCUMENTS)
}
