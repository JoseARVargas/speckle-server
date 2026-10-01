import type { Knex } from 'knex'

const FACILITIES = 'facilities'
const FLOORS = 'floors'
const SPACES = 'spaces'
const ZONES = 'zones'

/**
 * Optional spatial level between Floor and Space (Pavimento -> Zona -> Espaço),
 * per the Gêmeo Digital spec's 4.1 hierarchy. A Zone always belongs to one
 * Floor (unlike Space.floorId, which stays nullable); a Space's zoneId stays
 * nullable since a Zone is optional for any given Space.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(ZONES, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table
      .string('facilityId', 10)
      .notNullable()
      .references('id')
      .inTable(FACILITIES)
      .onDelete('cascade')
    table
      .string('floorId', 10)
      .notNullable()
      .references('id')
      .inTable(FLOORS)
      .onDelete('cascade')
    table.string('name').notNullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table.unique(['floorId', 'name'])
  })
  await knex.schema.alterTable(ZONES, (table) => {
    table.index('projectId')
    table.index('facilityId')
  })

  await knex.schema.alterTable(SPACES, (table) => {
    table
      .string('zoneId', 10)
      .nullable()
      .references('id')
      .inTable(ZONES)
      .onDelete('set null')
  })
  await knex.schema.alterTable(SPACES, (table) => {
    table.index('zoneId')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(SPACES, (table) => table.dropColumn('zoneId'))
  await knex.schema.dropTableIfExists(ZONES)
}
