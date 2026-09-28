import type { Knex } from 'knex'

const FACILITIES = 'facilities'
const ASSET_CLASSES = 'asset_classes'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(FACILITIES, (table) => {
    table.jsonb('namingConfig').notNullable().defaultTo('{}')
  })
  await knex.schema.alterTable(ASSET_CLASSES, (table) => {
    table.jsonb('ifcClasses').notNullable().defaultTo('[]')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(ASSET_CLASSES, (table) => table.dropColumn('ifcClasses'))
  await knex.schema.alterTable(FACILITIES, (table) => table.dropColumn('namingConfig'))
}
