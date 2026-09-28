import type { Knex } from 'knex'

const FACILITY_DOCUMENTS = 'facility_documents'

/**
 * Status/revision metadata for the document naming convention spec (ISO
 * 19650-inspired) - mirrors DigitalTwinAssetSuitabilityStatus's 4 states so
 * documents and models speak the same status vocabulary. Revision is a
 * free-text code (e.g. "P01" while work_in_progress, "C02" once shared),
 * not a plain integer, since the convention switches prefix letter on
 * status transitions.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(FACILITY_DOCUMENTS, (table) => {
    table.string('status').notNullable().defaultTo('work_in_progress')
    table.string('revision').nullable().defaultTo('P01')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(FACILITY_DOCUMENTS, (table) => {
    table.dropColumn('status')
    table.dropColumn('revision')
  })
}
