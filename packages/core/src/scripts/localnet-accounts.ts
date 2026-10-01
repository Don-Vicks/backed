// Prints what scripts/localnet/*.sh clone from mainnet, one `<kind> <address>` per line:
// program <id> | account <address> | pool-authority <address>
import { DBC_POOL_AUTHORITY, LOCALNET_ACCOUNTS, LOCALNET_PROGRAMS } from '../localnet'

const lines = [
  ...Object.values(LOCALNET_PROGRAMS).map((p) => `program ${p.toBase58()}`),
  ...LOCALNET_ACCOUNTS.map((a) => `account ${a.toBase58()}`),
  `pool-authority ${DBC_POOL_AUTHORITY.toBase58()}`,
]
console.log(lines.join('\n'))
