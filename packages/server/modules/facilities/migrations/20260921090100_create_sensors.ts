import type { Knex } from 'knex'

const FACILITIES = 'facilities'
const ASSETS = 'assets'
const SPACES = 'spaces'
const SENSORS = 'sensors'
const SENSOR_READINGS = 'sensor_readings'

/**
 * Sensors are registered independently of Assets (a sensor might monitor a
 * whole Space, or nothing in particular yet) but can optionally be linked
 * to one. Each sensor gets its own bcrypt-hashed API key (same hashing
 * approach as Personal Access Tokens - see modules/core/services/tokens.ts)
 * so a physical device/gateway can push readings via a plain REST endpoint
 * without a Speckle user session.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(SENSORS, (table) => {
    table.string('id', 10).primary()
    table.string('projectId', 10).notNullable()
    table
      .string('facilityId', 10)
      .notNullable()
      .references('id')
      .inTable(FACILITIES)
      .onDelete('cascade')
    table
      .string('assetId', 10)
      .nullable()
      .references('id')
      .inTable(ASSETS)
      .onDelete('set null')
    table
      .string('spaceId', 10)
      .nullable()
      .references('id')
      .inTable(SPACES)
      .onDelete('set null')
    table.string('name').notNullable()
    table.string('type').notNullable() // 'temperature' | 'humidity' | 'co2' | 'occupancy' | 'power' | 'pressure' | 'other'
    table.string('unit').nullable()
    table.string('manufacturer').nullable()
    table.string('model').nullable()
    table.string('serialNumber').nullable()
    table.string('status').notNullable().defaultTo('active') // 'active' | 'inactive'
    table.string('apiKeyHash').notNullable()
    // Denormalized latest reading, so the UI can show a current value
    // without a join into sensor_readings on every list render.
    table.double('lastReadingValue').nullable()
    table.timestamp('lastReadingAt', { precision: 3 }).nullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable(SENSORS, (table) => {
    table.index('projectId')
    table.index('facilityId')
    table.index('assetId')
  })

  // Time-series table - same bigIncrements-id convention as
  // telemetry_readings/energy_readings (see 20260917090000), for the same
  // reason: nothing ever looks a single reading up by id.
  await knex.schema.createTable(SENSOR_READINGS, (table) => {
    table.bigIncrements('id').primary()
    table
      .string('sensorId', 10)
      .notNullable()
      .references('id')
      .inTable(SENSORS)
      .onDelete('cascade')
    table.string('projectId', 10).notNullable()
    table.timestamp('ts', { precision: 3 }).notNullable().defaultTo(knex.fn.now())
    table.double('value').notNullable()
  })
  await knex.schema.alterTable(SENSOR_READINGS, (table) => {
    table.index(['sensorId', 'ts'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(SENSOR_READINGS)
  await knex.schema.dropTableIfExists(SENSORS)
}
