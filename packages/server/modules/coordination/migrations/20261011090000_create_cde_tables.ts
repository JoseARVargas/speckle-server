import type { Knex } from 'knex'

const CDE_CONFIGS = 'coord_cde_configs'
const PROJECT_APPROVERS = 'coord_project_approvers'
const VERSION_STATES = 'coord_version_states'

/**
 * BIM coordination - ISO 19650 CDE states per model version (WIP, Shared,
 * Published, Archived), the project's approvers and its CDE configuration
 * (states, suitability codes, revision scheme, Model Check criteria). See
 * officio-bim-coordination/.ai/plans/2026-10-07-upload-midp-cde.md.
 *
 * coord_version_states is append-only: every transition adds a row, the
 * version's current state is its latest row, the rest is the history.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(CDE_CONFIGS, (table) => {
    table.string('projectId', 10).primary()
    table.jsonb('config').notNullable()
    table.string('updatedBy', 10).nullable()
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })

  await knex.schema.createTable(PROJECT_APPROVERS, (table) => {
    table.string('projectId', 10).notNullable()
    table.string('userId', 10).notNullable()
    table.string('createdBy', 10).nullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table.primary(['projectId', 'userId'])
  })

  await knex.schema.createTable(VERSION_STATES, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table.string('modelId', 10).notNullable()
    table.string('versionId', 10).notNullable()
    table
      .string('deliverableId', 10)
      .nullable()
      .references('id')
      .inTable('coord_deliverables')
      .onDelete('set null')
    // ISO stage of the state: wip | shared | published | archived
    table.string('stage', 10).notNullable()
    // the project's state code and label at the time (configs can change)
    table.string('stateCode', 20).notNullable()
    table.string('stateLabel', 60).notNullable()
    table.string('suitability', 6).nullable()
    table.string('revision', 12).nullable()
    // created | advanced | shared | published | rejected | archived
    table.string('action', 10).notNullable()
    // manual | automatic | exception | system
    table.string('kind', 10).notNullable()
    table.text('comment').nullable()
    table.string('changedBy', 10).nullable()
    table
      .timestamp('changedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table.index(['projectId', 'modelId', 'changedAt'])
    table.index(['versionId', 'changedAt'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(VERSION_STATES)
  await knex.schema.dropTableIfExists(PROJECT_APPROVERS)
  await knex.schema.dropTableIfExists(CDE_CONFIGS)
}
