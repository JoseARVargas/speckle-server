import type { Knex } from 'knex'

const TABLE_NAME = 'file_uploads'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(TABLE_NAME, (table) => {
    table.string('discipline').nullable().defaultTo(null)
    table.string('suitabilityStatus').nullable().defaultTo(null)
    table.string('revision').nullable().defaultTo(null)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(TABLE_NAME, (table) => {
    table.dropColumn('discipline')
    table.dropColumn('suitabilityStatus')
    table.dropColumn('revision')
  })
}
