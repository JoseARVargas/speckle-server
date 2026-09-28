import type { Knex } from 'knex'

const FACILITIES = 'facilities'
const ASSETS = 'assets'
const DEVICE_STATES = 'device_states'
const DEVICE_COMMANDS = 'device_commands'
const TELEMETRY_READINGS = 'telemetry_readings'
const ENERGY_READINGS = 'energy_readings'

/**
 * Simulation layer on top of the Fatia 1 asset registry: an Asset can be
 * "turned on" (lazily creating its device_states row with sensible
 * defaults), and a periodic in-process worker (see modules/facilities/
 * services/simulation.ts) evolves its temperature toward the setpoint (or
 * toward the ambient temperature when off) and logs telemetry + energy/cost
 * readings. There's no per-asset nominal power catalog yet (that belongs on
 * AssetType eventually) - nominalPowerKw is captured per device_states row
 * with a fixed sane default, editable later without a schema change.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(FACILITIES, (table) => {
    table.double('energyTariffPerKwh').notNullable().defaultTo(0.75)
  })

  await knex.schema.createTable(DEVICE_STATES, (table) => {
    table
      .string('assetId', 10)
      .primary()
      .references('id')
      .inTable(ASSETS)
      .onDelete('cascade')
    table.string('projectId', 10).notNullable()
    table.string('powerState').notNullable().defaultTo('off') // 'on' | 'off'
    table.double('setpoint').notNullable().defaultTo(22)
    table.double('currentTemperature').notNullable().defaultTo(28)
    table.double('ambientTemperature').notNullable().defaultTo(28)
    table.double('nominalPowerKw').notNullable().defaultTo(1.2)
    table.double('cumulativeKwh').notNullable().defaultTo(0)
    table.double('cumulativeCost').notNullable().defaultTo(0)
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable(DEVICE_STATES, (table) => {
    table.index('projectId')
  })

  await knex.schema.createTable(DEVICE_COMMANDS, (table) => {
    table.string('id', 10).primary()
    table
      .string('assetId', 10)
      .notNullable()
      .references('id')
      .inTable(ASSETS)
      .onDelete('cascade')
    table.string('projectId', 10).notNullable()
    table.string('commandType').notNullable() // 'power_on' | 'power_off' | 'set_temperature'
    table.double('value').nullable()
    table
      .string('issuedBy', 10)
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('set null')
    table.timestamp('issuedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable(DEVICE_COMMANDS, (table) => {
    table.index(['assetId', 'issuedAt'])
  })

  // Time-series tables: an app-generated short id isn't useful here (nothing
  // ever looks a single reading up by id) and would just be dead weight on
  // every insert - a plain auto-incrementing key fits this shape better,
  // unlike the rest of this module's tables.
  await knex.schema.createTable(TELEMETRY_READINGS, (table) => {
    table.bigIncrements('id').primary()
    table
      .string('assetId', 10)
      .notNullable()
      .references('id')
      .inTable(ASSETS)
      .onDelete('cascade')
    table.string('projectId', 10).notNullable()
    table.timestamp('ts', { precision: 3 }).notNullable().defaultTo(knex.fn.now())
    table.double('temperature').notNullable()
    table.string('powerState').notNullable()
  })
  await knex.schema.alterTable(TELEMETRY_READINGS, (table) => {
    table.index(['assetId', 'ts'])
  })

  await knex.schema.createTable(ENERGY_READINGS, (table) => {
    table.bigIncrements('id').primary()
    table
      .string('assetId', 10)
      .notNullable()
      .references('id')
      .inTable(ASSETS)
      .onDelete('cascade')
    table.string('projectId', 10).notNullable()
    table.timestamp('ts', { precision: 3 }).notNullable().defaultTo(knex.fn.now())
    table.double('powerKw').notNullable()
    table.double('energyKwhInterval').notNullable()
    table.double('cumulativeKwh').notNullable()
    table.double('costInterval').notNullable()
    table.double('cumulativeCost').notNullable()
  })
  await knex.schema.alterTable(ENERGY_READINGS, (table) => {
    table.index(['assetId', 'ts'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(ENERGY_READINGS)
  await knex.schema.dropTableIfExists(TELEMETRY_READINGS)
  await knex.schema.dropTableIfExists(DEVICE_COMMANDS)
  await knex.schema.dropTableIfExists(DEVICE_STATES)
  await knex.schema.alterTable(FACILITIES, (table) => {
    table.dropColumn('energyTariffPerKwh')
  })
}
