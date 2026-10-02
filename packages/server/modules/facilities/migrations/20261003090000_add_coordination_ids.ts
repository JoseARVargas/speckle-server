import type { Knex } from 'knex'

const RULE_SET_VERSIONS = 'coord_rule_set_versions'
const CHECK_RUNS = 'coord_check_runs'

/**
 * IDS (buildingSMART Information Delivery Specification) rule sets: the IDS
 * XML is kept verbatim on the rule set version, and IDS runs are validated
 * by the Python coord-worker (IfcTester) against the version's original IFC
 * before the Node worker aggregates them like native runs.
 * See speckle-digitaltwin-console/.ai/plans/2026-10-01-coordenacao-bim-ids.md.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(RULE_SET_VERSIONS, (table) => {
    table.text('idsXml').nullable()
  })
  await knex.schema.alterTable(CHECK_RUNS, (table) => {
    // native: Node rule engine | ids: Python IfcTester, then Node aggregation
    table.string('engine', 10).notNullable().defaultTo('native')
    // MinIO object key of the version's original IFC (ids runs only)
    table.text('ifcObjectKey').nullable()
    table.index(['status', 'engine', 'queuedAt'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(CHECK_RUNS, (table) => {
    table.dropIndex(['status', 'engine', 'queuedAt'])
    table.dropColumn('ifcObjectKey')
    table.dropColumn('engine')
  })
  await knex.schema.alterTable(RULE_SET_VERSIONS, (table) => {
    table.dropColumn('idsXml')
  })
}
