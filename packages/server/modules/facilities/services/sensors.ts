import bcrypt from 'bcrypt'
import cryptoRandomString from 'crypto-random-string'

/**
 * Same approach as Personal Access Tokens (modules/core/services/tokens.ts):
 * a random secret, bcrypt-hashed for storage - the raw value is only ever
 * returned once, at generation time.
 */
export const generateSensorApiKey = async () => {
  const apiKey = cryptoRandomString({ length: 32 })
  const apiKeyHash = await bcrypt.hash(apiKey, 10)
  return { apiKey, apiKeyHash }
}
