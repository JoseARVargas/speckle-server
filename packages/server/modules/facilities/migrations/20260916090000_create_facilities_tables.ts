import type { Knex } from 'knex'

const FACILITIES = 'facilities'
const FLOORS = 'floors'
const SPACES = 'spaces'
const ASSET_TYPES = 'asset_types'
const ASSET_SYSTEMS = 'asset_systems'
const ASSETS = 'assets'
const ASSET_SYSTEM_MEMBERS = 'asset_system_members'

/**
 * COBie-inspired asset registry: Facility (1:1 Speckle project) -> Floor ->
 * Space, plus AssetType (a global, server-wide catalog - not project scoped)
 * and AssetSystem, with Asset (the COBie "Component") tying them together.
 *
 * `projectId` is a plain indexed column, not a foreign key to `streams` -
 * matching the rest of the codebase's convention (file_uploads.streamId is
 * the same), since project data can live in a different regional database
 * than this module's tables.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(FACILITIES, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table.unique('projectId')
    table.string('name').notNullable()
    table.string('tagSourceProperty').notNullable().defaultTo('IfcTag')
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })

  await knex.schema.createTable(FLOORS, (table) => {
    table.string('id', 10).primary()
    // Denormalized from facilities.projectId: every table a resolver might
    // query directly (not just walk down from Facility) needs projectId of
    // its own, since getProjectDbClient(projectId) is what picks the right
    // regional database to even run the query against - facilityId alone
    // can't answer that without a query you can't yet make.
    table.string('projectId', 10).notNullable()
    table
      .string('facilityId', 10)
      .notNullable()
      .references('id')
      .inTable(FACILITIES)
      .onDelete('cascade')
    table.string('name').notNullable()
    table.double('elevationZ').nullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable(FLOORS, (table) => {
    table.index('projectId')
  })

  await knex.schema.createTable(SPACES, (table) => {
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
      .nullable()
      .references('id')
      .inTable(FLOORS)
      .onDelete('set null')
    table.string('name').notNullable()
    table.double('elevationZ').nullable()
    table.string('speckleObjectId').nullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable(SPACES, (table) => {
    table.index('projectId')
    table.index('facilityId')
    table.index('floorId')
  })

  // Global catalog, shared across all facilities - not project scoped.
  // Only server admins can write to it (enforced at the GraphQL layer).
  await knex.schema.createTable(ASSET_TYPES, (table) => {
    table.string('id', 10).primary()
    table.string('name').notNullable()
    table.string('category').nullable()
    table.string('manufacturer').nullable()
    table.string('modelNumber').nullable()
    table.string('nature').nullable() // 'fixed' | 'movable' (COBie's AssetType field)
    table.text('description').nullable()
    table.integer('expectedLifeYears').nullable()
    table.jsonb('extendedAttributes').notNullable().defaultTo('{}')
    table
      .string('createdBy', 10)
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

  await knex.schema.createTable(ASSET_SYSTEMS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table
      .string('facilityId', 10)
      .notNullable()
      .references('id')
      .inTable(FACILITIES)
      .onDelete('cascade')
    table.string('name').notNullable()
    table.text('description').nullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable(ASSET_SYSTEMS, (table) => {
    table.index('projectId')
    table.index('facilityId')
  })

  await knex.schema.createTable(ASSETS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table
      .string('facilityId', 10)
      .notNullable()
      .references('id')
      .inTable(FACILITIES)
      .onDelete('cascade')
    table.string('tagNumber').notNullable()
    table.string('name').nullable()
    table
      .string('assetTypeId', 10)
      .nullable()
      .references('id')
      .inTable(ASSET_TYPES)
      .onDelete('set null')
    table
      .string('spaceId', 10)
      .nullable()
      .references('id')
      .inTable(SPACES)
      .onDelete('set null')
    // Cache of the asset's current resolved position in the live model -
    // tagNumber (read from the element's IFC property, e.g. IfcTag) is the
    // durable identity; object ids change on every re-import and are only
    // useful as a "where is this right now" pointer, refreshed on reconciliation.
    table.string('currentObjectId').nullable()
    table.string('currentVersionId').nullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table.unique(['facilityId', 'tagNumber'])
  })
  await knex.schema.alterTable(ASSETS, (table) => {
    table.index('projectId')
    table.index('spaceId')
    table.index('assetTypeId')
  })

  await knex.schema.createTable(ASSET_SYSTEM_MEMBERS, (table) => {
    table
      .string('assetId', 10)
      .notNullable()
      .references('id')
      .inTable(ASSETS)
      .onDelete('cascade')
    table
      .string('systemId', 10)
      .notNullable()
      .references('id')
      .inTable(ASSET_SYSTEMS)
      .onDelete('cascade')
    table.primary(['assetId', 'systemId'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(ASSET_SYSTEM_MEMBERS)
  await knex.schema.dropTableIfExists(ASSETS)
  await knex.schema.dropTableIfExists(ASSET_SYSTEMS)
  await knex.schema.dropTableIfExists(ASSET_TYPES)
  await knex.schema.dropTableIfExists(SPACES)
  await knex.schema.dropTableIfExists(FLOORS)
  await knex.schema.dropTableIfExists(FACILITIES)
}
