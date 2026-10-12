> Design note: closing the "maker never ships" gap. Not built; it needs decisions listed at the end.

[← Back to the README](../README.md)

# Delivery-conditioned payout (design)

## The gap

Backed has no custom program, so the maker's production money unlocks on a **date** (`creatorLiquidityVestingInfo`), not on delivery. A maker who takes the upfront share and never ships leaves backers a permanent 20% market floor and no refund. DBC and DAMM v2 cannot release liquidity on an event.

## What can and cannot be done without a program

| Option | Protects backers | Needs a program | Notes |
|---|---|---|---|
| A. Smaller, later payout (tune existing knobs) | Partly | No | Lower the upfront share and push vesting past the ship date. Already in place per trust tier; the cheapest lever and it costs the maker cash flow. |
| B. Backer-confirmed receipt gates a slice | Yes, for the slice | Yes (or a trusted signer) | The slice sits in a vault released when enough backers confirm, or returned pro rata after a deadline. |
| C. Attested delivery (carrier or marketplace proof) | Yes | Yes plus an oracle | Strongest, and the hardest to make honest: a tracking number is not proof the right item arrived. |
| D. Platform-held escrow multisig | Yes | No | Fast to ship, but then Backed is custodial for that slice: legal, key-management and trust costs the product currently avoids. |

## Recommended shape: B, as a small separate program

Keep DBC and DAMM v2 exactly as they are and add one vault per campaign that holds a **maker-chosen slice** (for example 30%) of the funds the maker would otherwise get at graduation:

1. At graduation the slice goes to the vault instead of the maker (the maker's wallet is the DBC `creator`/migration-fee recipient today; the slice is routed by pointing that recipient at the vault's PDA, so the DBC config still fixes the split).
2. Each redeemed order (a memo-bound voucher burn, already verified on-chain) can be **confirmed received** by its backer with a signed message. Confirmations are counted on-chain.
3. The vault releases to the maker when confirmations reach a threshold (for example 60% of burned units), or after the ship window plus a grace period if the maker marked everything shipped and no backer disputes it.
4. If the ship window plus grace passes without the threshold, backers may **claim a pro-rata refund** of the slice against their burned units, and the remainder returns to the maker only when no claims are outstanding.

Why a program is worth it here: the rules are small (one vault, a counter, three transitions), are audit-sized, and keep Backed non-custodial: no one, including the platform, can move the slice outside those rules.

## Off-chain pieces that already exist

- Orders and burns are recorded with the burn signature and memo, so confirmations can key on them.
- The maker orders page already marks orders shipped; that becomes the maker's claim that starts the confirmation window.
- Sign-in sessions (single-use nonces) and sealed shipping details are unaffected.

## Decisions needed before building

1. **Custody stance.** Is a non-custodial program acceptable (it needs an audit), or is a short-term platform multisig (option D) the stopgap?
2. **Slice size and who sets it.** Fixed by trust tier, or chosen by the maker within a cap? A bigger slice protects backers and costs the maker cash flow.
3. **Threshold and deadlines.** Confirmation percentage, grace period, and what happens to unconfirmed orders (silence counts as consent after N days?).
4. **Disputes.** Is a flag-and-freeze enough, or is there a human arbiter?
5. **Legal.** Whether pro-rata refunds change how the vouchers are treated in the jurisdictions you launch in.

Until these are decided, the README's "Known limits" stay accurate: trust-minimized, not trustless.
