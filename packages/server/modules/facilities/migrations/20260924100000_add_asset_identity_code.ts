import type { Knex } from 'knex'

const ASSETS = 'assets'
const SEQUENCE = 'asset_identity_seq'

/**
 * Same Luhn implementation as services/identity.ts, duplicated here since
 * migrations must not import application code (they need to keep working
 * unchanged even after that module is refactored later).
 */
function luhnCheckDigit(payload: string): number {
  const digits = payload.split('').map(Number).reverse()
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = digits[i]
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return (10 - (sum % 10)) % 10
}

function formatIdentityCode(n: number): string {
  const payload = String(n).padStart(6, '0')
  return `PHD-${payload}-${luhnCheckDigit(payload)}`
}

/**
 * Adds the PHD-NNNNNN-C system-generated asset identity code (see
 * services/identity.ts) as its own field, kept separate from tagNumber -
 * tagNumber still matches the BIM model's own tag property for
 * reconciliation and must not be repurposed for this.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS ${SEQUENCE}`)

  await knex.schema.alterTable(ASSETS, (table) => {
    table.string('identityCode').nullable()
  })

  // Backfill existing assets in creation order so older assets get lower
  // sequence numbers, same as if they'd been created under this scheme.
  const existing = await knex(ASSETS).select('id').orderBy('createdAt', 'asc')
  for (const row of existing) {
    const result = await knex.raw(`SELECT nextval('${SEQUENCE}') AS n`)
    const n = Number(result.rows[0].n)
    await knex(ASSETS)
      .where({ id: row.id })
      .update({ identityCode: formatIdentityCode(n) })
  }

  await knex.raw(`ALTER TABLE "${ASSETS}" ALTER COLUMN "identityCode" SET NOT NULL`)
  await knex.raw(
    `ALTER TABLE "${ASSETS}" ADD CONSTRAINT assets_identity_code_unique UNIQUE ("identityCode")`
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(ASSETS, (table) => {
    table.dropColumn('identityCode')
  })
  await knex.raw(`DROP SEQUENCE IF EXISTS ${SEQUENCE}`)
}
