// Messages a wallet signs. Dependency-free so the browser builds the exact same string.
import { BRAND } from './brand'

// The maker's sign-in to the orders page. It names the site's host, so a signature collected by any
// other site does not work here: the server rebuilds this exact text for its own host and accepts
// nothing else (verifyWalletMessage).
export function ordersMessage(pool: string, issuedAt: string, domain: string) {
  return `${domain} asks you to sign in to ${BRAND}.\nView orders for campaign ${pool}\nIssued at: ${issuedAt}`
}
