import type { Knex } from 'knex'

const ASSET_TYPES = 'asset_types'

/**
 * Not every registered asset is a controllable device (e.g. furniture,
 * structural elements) - the simulation module shouldn't offer power/
 * temperature controls for those. Adds an optional IFC-class label to the
 * shared Type catalog (a soft classification base, not an enforced IFC
 * schema - any free-text value is accepted) plus the actual gate used by
 * the simulation: isControllableDevice, nullable and treated as true when
 * unset so existing types keep their current (simulatable) behaviour.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(ASSET_TYPES, (table) => {
    table.string('ifcClass').nullable()
    table.boolean('isControllableDevice').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(ASSET_TYPES, (table) => {
    table.dropColumn('ifcClass')
    table.dropColumn('isControllableDevice')
  })
}
