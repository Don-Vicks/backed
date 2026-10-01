// Messages a wallet signs. Dependency-free so the browser builds the exact same string.
import { BRAND } from './brand'

export function ordersMessage(pool: string, issuedAt: string) {
  return `${BRAND}: view orders for campaign ${pool}\nIssued at: ${issuedAt}`
}
