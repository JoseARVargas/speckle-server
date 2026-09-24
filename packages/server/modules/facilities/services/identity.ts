import type { Knex } from 'knex'

const SEQUENCE = 'asset_identity_seq'

/**
 * Standard Luhn (mod 10) check digit: doubles every second digit counting
 * from the right, subtracts 9 from any doubled result over 9, then takes
 * the ten's complement of the digit sum mod 10. Verified against the
 * standard Luhn test vector "7992739871" -> check digit 3.
 */
export function luhnCheckDigit(payload: string): number {
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

/**
 * Generates the next PHD-NNNNNN-C asset identity code: a global sequential
 * number (6 digits, zero-padded) plus a Luhn check digit - never reused,
 * never edited after creation. Per the "Princípios da codificação" spec
 * (ISO/IEC 81346-style separation of identity/location/function), this
 * code is deliberately meaningless - location, discipline etc. stay as
 * their own separate, mutable fields (tagNumber, spaceId, assetTypeId),
 * not encoded into this string.
 *
 * The sequence lives in whichever database this call is routed to - for a
 * genuinely multi-region deployment this would need to be centralized in
 * one authoritative region rather than per-region, but this deployment is
 * single-region today.
 */
export const generateAssetIdentityCodeFactory =
  (deps: { db: Knex }) => async (): Promise<string> => {
    const result = await deps.db.raw(`SELECT nextval('${SEQUENCE}') AS n`)
    const n = Number(result.rows[0].n)
    const payload = String(n).padStart(6, '0')
    return `PHD-${payload}-${luhnCheckDigit(payload)}`
  }
