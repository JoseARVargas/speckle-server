import type { Knex } from 'knex'

const REQUIREMENT_SOURCES = 'coord_requirement_sources'
const MILESTONES = 'coord_milestones'
const REQUIREMENTS = 'coord_requirements'
const RULE_SETS = 'coord_rule_sets'
const RULE_SET_VERSIONS = 'coord_rule_set_versions'
const RULES = 'coord_rules'
const RULE_SET_BINDINGS = 'coord_rule_set_bindings'
const CHECK_RUNS = 'coord_check_runs'
const CHECK_RESULTS = 'coord_check_results'
const ELEMENT_SCORES = 'coord_element_scores'
const REQUIREMENT_STATS = 'coord_requirement_stats'
const RULE_STATS = 'coord_rule_stats'
const AUDIT_EVENTS = 'coord_audit_events'

/**
 * BIM coordination - "model check" (ISO 19650 information requirement
 * compliance) over the objects of a Speckle version. See
 * speckle-digitaltwin-console/.ai/plans/2026-10-01-coordenacao-bim-model-check.md.
 *
 * Every result is keyed by the element's stable key (its applicationId -
 * Revit UniqueId / IFC GlobalId), never by the Speckle object hash, which
 * changes with every published version. `projectId` is a plain indexed
 * column (not an FK to streams), like the rest of this module.
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

  await knex.schema.createTable(REQUIREMENT_SOURCES, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable().index()
    table.string('kind', 3).notNullable() // OIR | AIR | PIR | EIR
    table.string('title').notNullable()
    table.string('document').nullable()
    table.string('revision').nullable()
    table.string('clause').nullable()
    table
      .string('parentId', 10)
      .nullable()
      .references('id')
      .inTable(REQUIREMENT_SOURCES)
      .onDelete('set null')
    timestamps(table)
  })

  await knex.schema.createTable(MILESTONES, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable().index()
    table.string('name').notNullable()
    table.timestamp('dueDate', { precision: 3 }).nullable()
    table.string('discipline').nullable()
    timestamps(table)
    table.unique(['projectId', 'name'])
  })

  await knex.schema.createTable(REQUIREMENTS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable().index()
    table
      .string('sourceId', 10)
      .notNullable()
      .references('id')
      .inTable(REQUIREMENT_SOURCES)
      .onDelete('restrict')
    table
      .string('milestoneId', 10)
      .nullable()
      .references('id')
      .inTable(MILESTONES)
      .onDelete('set null')
    table.string('code').notNullable()
    table.string('title').notNullable()
    table.string('discipline').nullable()
    table.string('purpose').nullable()
    table.double('targetPct').notNullable().defaultTo(95)
    timestamps(table)
    table.unique(['projectId', 'code'])
  })

  await knex.schema.createTable(RULE_SETS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable().index()
    table.string('name').notNullable()
    table.string('format', 10).notNullable().defaultTo('native') // native | ids (phase 2)
    table
      .string('milestoneId', 10)
      .nullable()
      .references('id')
      .inTable(MILESTONES)
      .onDelete('set null')
    table.string('purpose').nullable()
    table.string('createdBy', 10).nullable()
    timestamps(table)
  })

  await knex.schema.createTable(RULE_SET_VERSIONS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable().index()
    table
      .string('ruleSetId', 10)
      .notNullable()
      .references('id')
      .inTable(RULE_SETS)
      .onDelete('cascade')
    table.integer('version').notNullable()
    table.string('status', 10).notNullable() // draft | published
    table.timestamp('publishedAt', { precision: 3 }).nullable()
    table.string('publishedBy', 10).nullable()
    timestamps(table)
    table.unique(['ruleSetId', 'version'])
  })
  // At most one editable draft per rule set
  await knex.raw(
    `CREATE UNIQUE INDEX coord_rule_set_versions_one_draft ON ${RULE_SET_VERSIONS} ("ruleSetId") WHERE status = 'draft'`
  )

  await knex.schema.createTable(RULES, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable().index()
    table
      .string('ruleSetVersionId', 10)
      .notNullable()
      .references('id')
      .inTable(RULE_SET_VERSIONS)
      .onDelete('cascade')
    table.string('code').notNullable()
    table.string('name').notNullable()
    table
      .string('requirementId', 10)
      .nullable()
      .references('id')
      .inTable(REQUIREMENTS)
      .onDelete('set null')
    table.string('severity', 10).notNullable() // error | warning
    table.double('weight').notNullable().defaultTo(1)
    table.jsonb('definition').notNullable() // { where: [...], check: [...] }
    table.integer('position').notNullable().defaultTo(0)
    timestamps(table)
    table.unique(['ruleSetVersionId', 'code'])
  })

  await knex.schema.createTable(RULE_SET_BINDINGS, (table) => {
    table.string('projectId', 10).notNullable().index()
    table
      .string('ruleSetId', 10)
      .notNullable()
      .references('id')
      .inTable(RULE_SETS)
      .onDelete('cascade')
    table.string('modelId', 10).notNullable()
    table.boolean('autoRun').notNullable().defaultTo(false)
    table.double('unkeyedBlockPct').notNullable().defaultTo(2)
    timestamps(table)
    table.primary(['ruleSetId', 'modelId'])
    table.index('modelId')
  })

  await knex.schema.createTable(CHECK_RUNS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table.string('ruleSetId', 10).notNullable()
    table
      .string('ruleSetVersionId', 10)
      .notNullable()
      .references('id')
      .inTable(RULE_SET_VERSIONS)
      .onDelete('cascade')
    table.string('modelId', 10).notNullable()
    table.string('versionId', 10).notNullable()
    table.string('trigger', 20).notNullable() // manual | version_created | preview
    table.string('status', 20).notNullable() // queued | running | succeeded | failed | blocked
    table.integer('attempt').notNullable().defaultTo(0)
    table.string('createdBy', 10).nullable()
    table.double('unkeyedBlockPct').notNullable().defaultTo(2)
    table.timestamp('queuedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('startedAt', { precision: 3 }).nullable()
    table.timestamp('finishedAt', { precision: 3 }).nullable()
    table.text('error').nullable()
    table.integer('elementCount').notNullable().defaultTo(0)
    table.integer('applicableCount').notNullable().defaultTo(0)
    table.integer('passCount').notNullable().defaultTo(0)
    table.integer('warnCount').notNullable().defaultTo(0)
    table.integer('failCount').notNullable().defaultTo(0)
    table.integer('naCount').notNullable().defaultTo(0)
    table.integer('unkeyedCount').notNullable().defaultTo(0)
    table.double('adherence').nullable()
    table.jsonb('unkeyedSample').notNullable().defaultTo('[]')
    table.index(['status', 'queuedAt'])
    table.index(['projectId', 'ruleSetId', 'modelId', 'queuedAt'])
  })

  await knex.schema.createTable(CHECK_RESULTS, (table) => {
    table
      .string('runId', 10)
      .notNullable()
      .references('id')
      .inTable(CHECK_RUNS)
      .onDelete('cascade')
    table
      .string('ruleId', 10)
      .notNullable()
      .references('id')
      .inTable(RULES)
      .onDelete('cascade')
    table.text('elementKey').notNullable()
    table.text('speckleObjectId').nullable()
    table.string('status', 10).notNullable() // pass | warn | fail
    table.jsonb('actualValue').nullable()
    table.text('message').nullable()
    table.primary(['runId', 'ruleId', 'elementKey'])
    table.index(['runId', 'elementKey'])
  })

  await knex.schema.createTable(ELEMENT_SCORES, (table) => {
    table
      .string('runId', 10)
      .notNullable()
      .references('id')
      .inTable(CHECK_RUNS)
      .onDelete('cascade')
    table.text('elementKey').notNullable()
    table.text('speckleObjectId').nullable()
    table.string('status', 10).notNullable() // pass | warn | fail | na
    table.double('score').nullable()
    table.primary(['runId', 'elementKey'])
    table.index(['runId', 'status'])
  })

  await knex.schema.createTable(REQUIREMENT_STATS, (table) => {
    table
      .string('runId', 10)
      .notNullable()
      .references('id')
      .inTable(CHECK_RUNS)
      .onDelete('cascade')
    table
      .string('requirementId', 10)
      .notNullable()
      .references('id')
      .inTable(REQUIREMENTS)
      .onDelete('cascade')
    table.integer('applicableCount').notNullable()
    table.integer('passCount').notNullable()
    table.primary(['runId', 'requirementId'])
  })

  await knex.schema.createTable(RULE_STATS, (table) => {
    table
      .string('runId', 10)
      .notNullable()
      .references('id')
      .inTable(CHECK_RUNS)
      .onDelete('cascade')
    table
      .string('ruleId', 10)
      .notNullable()
      .references('id')
      .inTable(RULES)
      .onDelete('cascade')
    table.integer('applicableCount').notNullable()
    table.integer('passCount').notNullable()
    table.integer('warnCount').notNullable()
    table.integer('failCount').notNullable()
    table.primary(['runId', 'ruleId'])
  })

  await knex.schema.createTable(AUDIT_EVENTS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable().index()
    table.string('actorId', 10).nullable()
    table.string('action').notNullable()
    table.string('entityType').notNullable()
    table.string('entityId').notNullable()
    table.jsonb('data').nullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [
    AUDIT_EVENTS,
    RULE_STATS,
    REQUIREMENT_STATS,
    ELEMENT_SCORES,
    CHECK_RESULTS,
    CHECK_RUNS,
    RULE_SET_BINDINGS,
    RULES,
    RULE_SET_VERSIONS,
    RULE_SETS,
    REQUIREMENTS,
    MILESTONES,
    REQUIREMENT_SOURCES
  ]) {
    await knex.schema.dropTableIfExists(table)
  }
}
