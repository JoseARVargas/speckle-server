import type { Knex } from 'knex'

const ASSET_CLASSES = 'asset_classes'
const ASSETS = 'assets'
const FACILITIES = 'facilities'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(ASSET_CLASSES, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table
      .string('facilityId', 10)
      .notNullable()
      .references('id')
      .inTable(FACILITIES)
      .onDelete('cascade')
    table.string('parentId', 10).nullable()
    table.string('code', 32).notNullable()
    table.string('name', 120).notNullable()
    table.string('level', 10).notNullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table.unique(['facilityId', 'id'])
    table.unique(['facilityId', 'code'])
    table
      .foreign(['facilityId', 'parentId'])
      .references(['facilityId', 'id'])
      .inTable(ASSET_CLASSES)
      .onDelete('restrict')
    table.index('projectId')
    table.index('parentId')
  })

  await knex.schema.alterTable(ASSETS, (table) => {
    // Nullable to preserve existing records; new catalog registrations send
    // an explicit class and lifecycle values through the GraphQL API.
    table.string('assetClassId', 10).nullable()
    table.string('state', 20).nullable()
    table.string('tenure', 20).nullable()
    table
      .foreign(['facilityId', 'assetClassId'])
      .references(['facilityId', 'id'])
      .inTable(ASSET_CLASSES)
      .onDelete('restrict')
    table.index('assetClassId')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(ASSETS, (table) => {
    table.dropForeign(['facilityId', 'assetClassId'])
    table.dropIndex('assetClassId')
    table.dropColumn('assetClassId')
    table.dropColumn('state')
    table.dropColumn('tenure')
  })
  await knex.schema.dropTableIfExists(ASSET_CLASSES)
}
