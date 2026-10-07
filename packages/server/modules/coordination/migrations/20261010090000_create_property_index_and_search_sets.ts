import type { Knex } from 'knex'

const PROPERTY_INDEX = 'coord_property_index'
const SEARCH_SETS = 'coord_search_sets'

/**
 * BIM coordination, phase 2a (see
 * officio-bim-coordination/.ai/plans/2026-10-06-fase2-search-sets-bsdd-ids.md):
 * - coord_property_index: property paths present in a model version (counts,
 *   samples, IFC classes), computed once per version - versions are
 *   immutable. Feeds autocomplete and the bSDD conformity report.
 * - coord_search_sets: named, reusable element selections (conditions),
 *   used by clash groups and copied into Model Check rules.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(PROPERTY_INDEX, (table) => {
    table.string('versionId', 10).primary()
    table.string('projectId', 10).notNullable().index()
    table.string('modelId', 10).notNullable()
    table.integer('elementCount').notNullable()
    /** true when the element or path caps were reached */
    table.boolean('truncated').notNullable().defaultTo(false)
    /** [{ path, count, samples[] }], most frequent first */
    table.jsonb('paths').notNullable()
    /** [{ type, count }] */
    table.jsonb('ifcTypes').notNullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })

  await knex.schema.createTable(SEARCH_SETS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table.string('name', 200).notNullable()
    table.text('description').nullable()
    /** optional: the set only applies to this model */
    table.string('modelId', 10).nullable()
    table.jsonb('where').notNullable()
    table.string('createdBy', 10).nullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table.unique(['projectId', 'name'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(SEARCH_SETS)
  await knex.schema.dropTableIfExists(PROPERTY_INDEX)
}
