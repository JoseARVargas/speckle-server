import type { Knex } from 'knex'

const ASSETS = 'assets'

/**
 * Rounds out the Asset (COBie "Component" sheet) with the per-instance
 * attributes the sheet defines beyond identity/linking - InstallationDate,
 * WarrantyStartDate, SerialNumber, BarCode - plus a JSON catch-all for
 * anything else (AssetIdentifier, ExtSystem, custom fields, ...), mirroring
 * AssetType.extendedAttributes.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(ASSETS, (table) => {
    table.date('installDate').nullable()
    table.date('warrantyStartDate').nullable()
    table.string('serialNumber').nullable()
    table.string('barCode').nullable()
    table.jsonb('extendedAttributes').notNullable().defaultTo('{}')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(ASSETS, (table) => {
    table.dropColumn('installDate')
    table.dropColumn('warrantyStartDate')
    table.dropColumn('serialNumber')
    table.dropColumn('barCode')
    table.dropColumn('extendedAttributes')
  })
}
