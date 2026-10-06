import type { Knex } from 'knex'

const ASSETS = 'assets'

/**
 * Renames the asset identity code prefix from PHD- to NXT- (NexTwin) on
 * already-issued codes. Only the 4-char prefix changes: the sequential
 * payload and its Luhn check digit (computed over the payload alone) stay
 * the same, so every code keeps its number and remains unique.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `UPDATE "${ASSETS}" SET "identityCode" = 'NXT-' || substring("identityCode" from 5) WHERE "identityCode" LIKE 'PHD-%'`
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    `UPDATE "${ASSETS}" SET "identityCode" = 'PHD-' || substring("identityCode" from 5) WHERE "identityCode" LIKE 'NXT-%'`
  )
}
