import type { Knex } from 'knex'

const NAMING_CODES = 'coord_naming_codes'
const DELIVERABLES = 'coord_deliverables'
const DELIVERABLE_REQUIREMENTS = 'coord_deliverable_requirements'

/**
 * BIM coordination - information delivery planning (ISO 19650 MIDP/TIDP).
 * See officio-bim-coordination/.ai/plans/2026-10-06-planejamento-iso19650.md.
 *
 * One table of deliverables is the MIDP; a TIDP is the same table filtered
 * by originator (task team). Container names follow ISO 19650-2 fields
 * (Project-Originator-Volume-Level-Type-Role-Number) with codes from
 * per-project lists.
 */
export async function up(knex: Knex): Promise<void> {
  const timestamps = (table: Knex.CreateTableBuilder) => {
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  }

  await knex.schema.createTable(NAMING_CODES, (table) => {
    table.string('projectId', 10).notNullable()
    // project | originator | volume | level | type | role
    table.string('field', 12).notNullable()
    table.string('code', 6).notNullable()
    table.string('description').nullable()
    table.integer('position').notNullable().defaultTo(0)
    table.primary(['projectId', 'field', 'code'])
  })

  await knex.schema.createTable(DELIVERABLES, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table.text('containerName').notNullable()
    table.string('title', 300).notNullable()
    // model | drawing | document | schedule | other
    table.string('kind', 10).notNullable()
    table.string('project', 6).notNullable()
    table.string('originator', 6).notNullable()
    table.string('volume', 6).notNullable()
    table.string('level', 6).notNullable()
    table.string('type', 6).notNullable()
    table.string('role', 6).notNullable()
    table.integer('number').notNullable()
    table
      .string('milestoneId', 10)
      .nullable()
      .references('id')
      .inTable('coord_milestones')
      .onDelete('set null')
    table.string('responsibleUserId', 10).nullable()
    table.string('modelId', 10).nullable()
    table.timestamp('dueDate', { precision: 3 }).nullable()
    // planned | in_progress | delivered | accepted | rejected
    table.string('status', 12).notNullable().defaultTo('planned')
    table.text('notes').nullable()
    table.string('createdBy', 10).nullable()
    timestamps(table)
    table.unique(['projectId', 'containerName'])
    table.index(['projectId', 'originator'])
    table.index(['projectId', 'milestoneId'])
  })

  await knex.schema.createTable(DELIVERABLE_REQUIREMENTS, (table) => {
    table
      .string('deliverableId', 10)
      .notNullable()
      .references('id')
      .inTable(DELIVERABLES)
      .onDelete('cascade')
    table
      .string('requirementId', 10)
      .notNullable()
      .references('id')
      .inTable('coord_requirements')
      .onDelete('cascade')
    table.primary(['deliverableId', 'requirementId'])
    table.index('requirementId')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(DELIVERABLE_REQUIREMENTS)
  await knex.schema.dropTableIfExists(DELIVERABLES)
  await knex.schema.dropTableIfExists(NAMING_CODES)
}
