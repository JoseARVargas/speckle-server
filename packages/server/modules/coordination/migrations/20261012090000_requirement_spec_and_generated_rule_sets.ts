import type { Knex } from 'knex'

const REQUIREMENTS = 'coord_requirements'
const RULE_SETS = 'coord_rule_sets'

/**
 * Requirement -> verification (Fase 2c of
 * officio-bim-coordination/.ai/plans/2026-10-06-fase2-search-sets-bsdd-ids.md):
 * a requirement may carry a verifiable specification (IFC classes + the
 * WHERE/CHECK format of the Model Check), and "Gerar regras" writes them into
 * one managed rule set per project, marked by generatedFrom.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(REQUIREMENTS, (table) => {
    table.jsonb('spec').nullable()
  })
  await knex.schema.alterTable(RULE_SETS, (table) => {
    // 'requirements' = the rule set "Gerar regras" maintains; null = authored
    table.string('generatedFrom', 20).nullable()
  })
  await knex.raw(
    `CREATE UNIQUE INDEX coord_rule_sets_generated_unique
       ON ${RULE_SETS} ("projectId", "generatedFrom")
       WHERE "generatedFrom" IS NOT NULL`
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS coord_rule_sets_generated_unique')
  await knex.schema.alterTable(RULE_SETS, (table) => {
    table.dropColumn('generatedFrom')
  })
  await knex.schema.alterTable(REQUIREMENTS, (table) => {
    table.dropColumn('spec')
  })
}
