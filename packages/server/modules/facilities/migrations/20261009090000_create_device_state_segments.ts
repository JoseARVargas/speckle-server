import type { Knex } from 'knex'

const DEVICE_STATE_SEGMENTS = 'device_state_segments'
const DEVICE_STATES = 'device_states'
const FACILITIES = 'facilities'
const ASSETS = 'assets'

/**
 * The simulation stops ticking: each event (power, setpoint, fault profile,
 * tariff) appends a segment and every reading is computed from segments on
 * demand (modules/facilities/services/simulationModel.ts). Backfills one
 * segment per existing device_states row, starting now from its current
 * values. telemetry_readings, energy_readings and device_health_signals are
 * left untouched (no longer written) so the previous image still works on a
 * rollback; dropping them is a separate, later migration.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(DEVICE_STATE_SEGMENTS, (table) => {
    // Orders segments that start in the same millisecond
    table.bigIncrements('id').primary()
    table
      .string('assetId', 10)
      .notNullable()
      .references('id')
      .inTable(ASSETS)
      .onDelete('cascade')
    table.string('projectId', 10).notNullable()
    table.timestamp('startsAt', { precision: 3, useTz: true }).notNullable()
    table.string('powerState').notNullable() // 'on' | 'off'
    table.double('setpoint').notNullable()
    table.double('ambientTemperature').notNullable()
    table.double('nominalPowerKw').notNullable()
    table.double('degradationRate').notNullable()
    table.double('startupCurrentDecay').notNullable()
    table.double('noiseAmplification').notNullable()
    table.double('tariffPerKwh').notNullable()
    table.double('temperatureAtStart').notNullable()
    table.double('cumulativeKwhAtStart').notNullable()
    table.double('cumulativeCostAtStart').notNullable()
    table.timestamp('poweredOnAt', { precision: 3, useTz: true }).nullable()
    table
      .timestamp('createdAt', { precision: 3, useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable(DEVICE_STATE_SEGMENTS, (table) => {
    table.index(['assetId', 'startsAt'])
    table.index(['projectId', 'startsAt'])
  })

  await knex.raw(
    `INSERT INTO "${DEVICE_STATE_SEGMENTS}" (
       "assetId", "projectId", "startsAt", "powerState", "setpoint",
       "ambientTemperature", "nominalPowerKw", "degradationRate",
       "startupCurrentDecay", "noiseAmplification", "tariffPerKwh",
       "temperatureAtStart", "cumulativeKwhAtStart", "cumulativeCostAtStart",
       "poweredOnAt"
     )
     SELECT ds."assetId", ds."projectId", now(), ds."powerState", ds."setpoint",
       ds."ambientTemperature", ds."nominalPowerKw", ds."degradationRate",
       ds."startupCurrentDecay", ds."noiseAmplification",
       COALESCE(f."energyTariffPerKwh", 0.75),
       ds."currentTemperature", ds."cumulativeKwh", ds."cumulativeCost",
       ds."poweredOnAt"
     FROM "${DEVICE_STATES}" ds
     JOIN "${ASSETS}" a ON a."id" = ds."assetId"
     LEFT JOIN "${FACILITIES}" f ON f."id" = a."facilityId"`
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(DEVICE_STATE_SEGMENTS)
}
