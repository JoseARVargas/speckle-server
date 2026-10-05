import type { Knex } from 'knex'

const CLASH_TESTS = 'coord_clash_tests'
const CLASH_RUNS = 'coord_clash_runs'
const CLASH_RUN_ELEMENTS = 'coord_clash_run_elements'
const CLASH_RAW = 'coord_clash_raw'
const CLASHES = 'coord_clashes'

/**
 * BIM coordination - clash detection between discipline models (IFC). See
 * officio-bim-coordination/.ai/plans/2026-10-05-clash.md.
 *
 * Pipeline (same queue-in-a-table pattern as the IDS runs):
 * queued (Node selects elements) -> geometry -> geometry_running (Python
 * worker, IfcOpenShell) -> geometry_done -> processing (Node: ignore rules,
 * fingerprints, status carry-over) -> succeeded | failed.
 * Clashes are keyed by the elements' GlobalIds (= Speckle applicationId).
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

  await knex.schema.createTable(CLASH_TESTS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable().index()
    table.string('name').notNullable()
    table.string('type', 10).notNullable() // hard | clearance
    table.double('toleranceMm').notNullable().defaultTo(5)
    table.double('clearanceMm').nullable()
    table.jsonb('groupA').notNullable() // { modelId, where[] }
    table.jsonb('groupB').nullable() // null = A x A
    table.jsonb('ignore').notNullable() // { sameElement, hosted, connected, sameSystem, plannedOpening }
    table.boolean('autoRun').notNullable().defaultTo(false)
    table.string('createdBy', 10).nullable()
    timestamps(table)
    table.unique(['projectId', 'name'])
  })

  await knex.schema.createTable(CLASH_RUNS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table
      .string('testId', 10)
      .notNullable()
      .references('id')
      .inTable(CLASH_TESTS)
      .onDelete('cascade')
    table.string('modelIdA', 10).notNullable()
    table.string('versionIdA', 10).notNullable()
    table.text('objectKeyA').notNullable()
    table.string('modelIdB', 10).notNullable()
    table.string('versionIdB', 10).notNullable()
    table.text('objectKeyB').notNullable()
    table.string('trigger', 20).notNullable() // manual | version_created
    table.string('status', 20).notNullable()
    table.integer('attempt').notNullable().defaultTo(0)
    table.string('createdBy', 10).nullable()
    // test settings frozen at enqueue time, so edits don't change a run in flight
    table.jsonb('settings').notNullable()
    table.timestamp('queuedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('startedAt', { precision: 3 }).nullable()
    table.timestamp('finishedAt', { precision: 3 }).nullable()
    table.text('error').nullable()
    table.integer('countA').notNullable().defaultTo(0)
    table.integer('countB').notNullable().defaultTo(0)
    table.integer('rawCount').notNullable().defaultTo(0)
    table.integer('ignoredCount').notNullable().defaultTo(0)
    table.integer('clashCount').notNullable().defaultTo(0)
    table.double('geometrySeconds').nullable()
    table.integer('peakRssMb').nullable()
    table.index(['projectId', 'testId', 'queuedAt'])
    table.index(['status', 'queuedAt'])
  })

  await knex.schema.createTable(CLASH_RUN_ELEMENTS, (table) => {
    table
      .string('runId', 10)
      .notNullable()
      .references('id')
      .inTable(CLASH_RUNS)
      .onDelete('cascade')
    table.string('side', 1).notNullable() // a | b
    table.text('elementKey').notNullable() // IFC GlobalId
    table.text('speckleObjectId').nullable()
    // element matches the test's "planned opening" condition -> its clashes are ignored
    table.boolean('plannedOpening').notNullable().defaultTo(false)
    table.primary(['runId', 'side', 'elementKey'])
  })

  await knex.schema.createTable(CLASH_RAW, (table) => {
    table
      .string('runId', 10)
      .notNullable()
      .references('id')
      .inTable(CLASH_RUNS)
      .onDelete('cascade')
      .index()
    table.text('keyA').notNullable()
    table.text('keyB').notNullable()
    table.double('distanceMm').notNullable()
    table.specificType('point', 'double precision[]').nullable()
    table.string('clashType', 20).notNullable()
    table.string('relation', 20).nullable() // hosted | connected | same_system
  })

  await knex.schema.createTable(CLASHES, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table
      .string('runId', 10)
      .notNullable()
      .references('id')
      .inTable(CLASH_RUNS)
      .onDelete('cascade')
    table.string('testId', 10).notNullable()
    table.string('fingerprint', 40).notNullable()
    table.text('keyA').notNullable()
    table.text('keyB').notNullable()
    table.text('speckleObjectIdA').nullable()
    table.text('speckleObjectIdB').nullable()
    table.double('distanceMm').notNullable()
    table.specificType('point', 'double precision[]').nullable()
    table.string('clashType', 20).notNullable()
    table.string('status', 20).notNullable().defaultTo('new')
    table.string('assignee', 10).nullable()
    table.text('comment').nullable()
    timestamps(table)
    table.unique(['runId', 'fingerprint'])
    table.index(['projectId', 'testId'])
    table.index(['runId', 'status'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(CLASHES)
  await knex.schema.dropTableIfExists(CLASH_RAW)
  await knex.schema.dropTableIfExists(CLASH_RUN_ELEMENTS)
  await knex.schema.dropTableIfExists(CLASH_RUNS)
  await knex.schema.dropTableIfExists(CLASH_TESTS)
}
