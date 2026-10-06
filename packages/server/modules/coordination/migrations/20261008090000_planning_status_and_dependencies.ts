import type { Knex } from 'knex'

const DELIVERABLES = 'coord_deliverables'
const DEPENDENCIES = 'coord_deliverable_dependencies'

/** Phase 1 statuses -> MIDP traffic light tied to the ISO 19650 CDE states. */
const STATUS_MAP: [string, string][] = [
  ['planned', 'not_started'],
  ['delivered', 'in_review'],
  ['accepted', 'published'],
  ['rejected', 'blocked']
]

/**
 * Information delivery planning, phase 1b (see
 * officio-bim-coordination/.ai/plans/2026-10-06-planejamento-iso19650.md):
 * deliverable status becomes the MIDP traffic light (not_started,
 * in_progress, in_review, published, blocked; "late" is derived, never
 * stored) and deliverables can depend on others of the same project.
 */
export async function up(knex: Knex): Promise<void> {
  for (const [from, to] of STATUS_MAP) {
    await knex(DELIVERABLES).where({ status: from }).update({ status: to })
  }
  await knex.schema.alterTable(DELIVERABLES, (table) => {
    table.string('status', 12).notNullable().defaultTo('not_started').alter()
  })

  await knex.schema.createTable(DEPENDENCIES, (table) => {
    table
      .string('deliverableId', 10)
      .notNullable()
      .references('id')
      .inTable(DELIVERABLES)
      .onDelete('cascade')
    table
      .string('dependsOnId', 10)
      .notNullable()
      .references('id')
      .inTable(DELIVERABLES)
      .onDelete('cascade')
    table.primary(['deliverableId', 'dependsOnId'])
    table.index('dependsOnId')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(DEPENDENCIES)
  await knex.schema.alterTable(DELIVERABLES, (table) => {
    table.string('status', 12).notNullable().defaultTo('planned').alter()
  })
  for (const [from, to] of STATUS_MAP) {
    await knex(DELIVERABLES).where({ status: to }).update({ status: from })
  }
}
