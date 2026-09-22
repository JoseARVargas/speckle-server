import type { Knex } from 'knex'

const DEVICE_STATES = 'device_states'
const TELEMETRY_READINGS = 'telemetry_readings'

/**
 * Splits out the compressor duty fraction (previously only implicit in how
 * much of nominalPowerKw was drawn) and adds simulated amperage, so the
 * telemetry shape matches what a real PZEM-004T + ESP32 would report -
 * see the ac-twin-sim spec this mirrors.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DEVICE_STATES, (table) => {
    table.double('compressorDuty').notNullable().defaultTo(0)
    table.double('currentA').notNullable().defaultTo(0)
  })
  await knex.schema.alterTable(TELEMETRY_READINGS, (table) => {
    table.double('compressorDuty').notNullable().defaultTo(0)
    table.double('currentA').notNullable().defaultTo(0)
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(TELEMETRY_READINGS, (table) => {
    table.dropColumn('compressorDuty')
    table.dropColumn('currentA')
  })
  await knex.schema.alterTable(DEVICE_STATES, (table) => {
    table.dropColumn('compressorDuty')
    table.dropColumn('currentA')
  })
}
