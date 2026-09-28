import type { Knex } from 'knex'

const FACILITIES = 'facilities'
const ASSETS = 'assets'
const MAINTENANCE_ORDERS = 'maintenance_orders'

/**
 * A single work-order model covers both what was going to be two separate
 * modules ("Chamados" and "Manutenção") - a corrective order (something
 * broke, someone opened a ticket) and a preventive order (scheduled upkeep)
 * differ only in `type`, not in shape, so splitting them into different
 * tables/screens would just be duplicated CRUD for no real gain.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable(MAINTENANCE_ORDERS, (table) => {
    table.string('id', 10).primary()
    // Same reasoning as every other facilities table - a direct projectId
    // column is what getProjectDbClient(projectId) needs to pick the right
    // regional database before any query, facilityId alone can't answer
    // that.
    table.string('projectId', 10).notNullable()
    table
      .string('facilityId', 10)
      .notNullable()
      .references('id')
      .inTable(FACILITIES)
      .onDelete('cascade')
    // Nullable - a work order can be facility-wide (e.g. "check the rooftop
    // condensers") rather than tied to one registered Asset.
    table
      .string('assetId', 10)
      .nullable()
      .references('id')
      .inTable(ASSETS)
      .onDelete('set null')
    table.string('title').notNullable()
    table.text('description').nullable()
    table.string('type').notNullable() // 'corrective' | 'preventive'
    table.string('status').notNullable().defaultTo('open') // 'open' | 'in_progress' | 'done' | 'cancelled'
    table.string('priority').nullable() // 'low' | 'medium' | 'high' | 'urgent'
    table
      .string('reportedBy', 10)
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('set null')
    // Free text for now - there's no team/assignee directory in this app
    // yet, just a name to write on the work order.
    table.string('assignedTo').nullable()
    table.timestamp('dueDate', { precision: 3 }).nullable()
    table.timestamp('completedAt', { precision: 3 }).nullable()
    table
      .timestamp('createdAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
    table
      .timestamp('updatedAt', { precision: 3 })
      .notNullable()
      .defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable(MAINTENANCE_ORDERS, (table) => {
    table.index('projectId')
    table.index(['facilityId', 'status'])
    table.index('assetId')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(MAINTENANCE_ORDERS)
}
