import type { Knex } from 'knex'

const REVISIONS = 'coord_document_revisions'
const VERSION_STATES = 'coord_version_states'

/**
 * Document deliverables (drawings, documents, schedules): every uploaded file
 * is a revision that goes through the same ISO 19650 CDE flow as a model
 * version. See speckle-digitaltwin-console/.ai/plans/
 * 2026-10-08-documentos-entregaveis-coordenacao.md (part B).
 *
 * coord_version_states now has two kinds of subject: a model version
 * (modelId + versionId) or a document revision (documentRevisionId) - exactly
 * one of them, enforced by a CHECK.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(REVISIONS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table
      .string('deliverableId', 10)
      .notNullable()
      .references('id')
      .inTable('coord_deliverables')
      .onDelete('cascade')
    // Speckle blob storage (modules/blobstorage), project's database/storage
    table.string('blobId', 10).notNullable()
    table.string('fileName').notNullable()
    table.bigInteger('fileSize').notNullable()
    // detected from the file's first bytes, not from the client
    table.string('contentType', 100).notNullable()
    table.string('extension', 10).notNullable()
    table.string('sha256', 64).notNullable()
    table.string('createdBy', 10).nullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table.unique(['deliverableId', 'sha256'])
    table.index(['projectId', 'deliverableId', 'createdAt'])
    table.index(['blobId'])
  })

  await knex.schema.alterTable(VERSION_STATES, (table) => {
    table.string('modelId', 10).nullable().alter()
    table.string('versionId', 10).nullable().alter()
    table
      .string('documentRevisionId', 10)
      .nullable()
      .references('id')
      .inTable(REVISIONS)
      .onDelete('cascade')
    table.index(['documentRevisionId', 'changedAt'])
    table.index(['projectId', 'deliverableId', 'changedAt'])
  })
  await knex.raw(
    `ALTER TABLE ${VERSION_STATES} ADD CONSTRAINT coord_version_states_one_subject
       CHECK (("versionId" IS NOT NULL AND "modelId" IS NOT NULL) <> ("documentRevisionId" IS NOT NULL))`
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE ${VERSION_STATES} DROP CONSTRAINT IF EXISTS coord_version_states_one_subject`
  )
  await knex(VERSION_STATES).whereNotNull('documentRevisionId').delete()
  await knex.schema.alterTable(VERSION_STATES, (table) => {
    table.dropIndex(['documentRevisionId', 'changedAt'])
    table.dropIndex(['projectId', 'deliverableId', 'changedAt'])
    table.dropColumn('documentRevisionId')
    table.string('modelId', 10).notNullable().alter()
    table.string('versionId', 10).notNullable().alter()
  })
  await knex.schema.dropTableIfExists(REVISIONS)
}
