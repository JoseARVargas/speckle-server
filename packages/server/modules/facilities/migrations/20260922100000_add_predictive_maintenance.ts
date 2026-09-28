import type { Knex } from 'knex'

const DEVICE_STATES = 'device_states'
const DEVICE_HEALTH_SIGNALS = 'device_health_signals'
const MAINTENANCE_REPORTS = 'maintenance_reports'
const ASSETS = 'assets'
const FACILITIES = 'facilities'
const USERS = 'users'

/**
 * Predictive maintenance on top of the device simulator (see ac-twin-sim
 * spec section 9): fault-injection knobs on the device state, a rolling
 * statistical detection pass over telemetry (device_health_signals), and
 * AI-generated reports (maintenance_reports) that summarize the *signals*,
 * never raw telemetry.
 */
export async function up(knex: Knex): Promise<void> {
  // compressorDuty/currentA already exist (see
  // 20260922090000_add_compressor_duty_and_current.ts) - this migration
  // only adds the fault-injection knobs.
  await knex.schema.alterTable(DEVICE_STATES, (table) => {
    table.double('degradationRate').notNullable().defaultTo(0)
    table.double('startupCurrentDecay').notNullable().defaultTo(0)
    table.double('noiseAmplification').notNullable().defaultTo(1)
    table.timestamp('poweredOnAt', { precision: 3 }).nullable()
  })

  await knex.schema.createTable(DEVICE_HEALTH_SIGNALS, (table) => {
    table.string('id', 10).primary()
    table
      .string('assetId', 10)
      .notNullable()
      .references('id')
      .inTable(ASSETS)
      .onDelete('cascade')
    table.string('projectId', 10).notNullable()
    table.string('metric').notNullable() // 'currentA' | 'powerKw' | 'compressorDuty'
    table.string('trend').notNullable() // 'rising' | 'falling' | 'stable'
    table.string('severity').notNullable() // 'info' | 'warning' | 'critical'
    table.double('zScore').notNullable()
    table.timestamp('since', { precision: 3 }).notNullable()
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable(DEVICE_HEALTH_SIGNALS, (table) => {
    table.unique(['assetId', 'metric'])
    table.index('projectId')
  })

  await knex.schema.createTable(MAINTENANCE_REPORTS, (table) => {
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
    table.text('summary').notNullable()
    table.text('recommendation').notNullable()
    table.string('severity').notNullable()
    // The structured signals (never raw telemetry) the report was generated
    // from - kept for audit/traceability of what the AI actually saw.
    table.jsonb('signalsSnapshot').notNullable()
    table
      .timestamp('generatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .string('generatedBy', 10)
      .nullable()
      .references('id')
      .inTable(USERS)
      .onDelete('set null')
  })
  await knex.schema.alterTable(MAINTENANCE_REPORTS, (table) => {
    table.index(['facilityId', 'generatedAt'])
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(MAINTENANCE_REPORTS)
  await knex.schema.dropTableIfExists(DEVICE_HEALTH_SIGNALS)
  await knex.schema.alterTable(DEVICE_STATES, (table) => {
    table.dropColumn('degradationRate')
    table.dropColumn('startupCurrentDecay')
    table.dropColumn('noiseAmplification')
    table.dropColumn('poweredOnAt')
  })
}
