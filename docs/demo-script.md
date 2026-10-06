# Demo script: Superteam Earn, "Best use of Meteora's Dynamic Bonding Curve (DBC)"

Target: a **3:00 Loom**, recorded against the live devnet app (https://backed.up.railway.app) with Phantom on devnet. About 420 spoken words. Read the **Say** lines as written; they are plain on purpose.

## What the judges score, and where this script shows it

| Listing criterion | Where you show it |
|---|---|
| Deep, meaningful Meteora stack integration | 0:20 to 2:00: DBC curve, migration fee, fee scheduler, partner fees, DAMM v2, customizable fee, permanent lock, liquidity vesting |
| Code quality and architecture | 0:55 ("no custom program") and 2:30 (CI against the real mainnet binaries) |
| Originality and long-term viability | 0:00 to 0:20: pre-orders for real products, not another meme or stock launchpad |
| Scalability and market impact | 2:30: any maker, any product, resale royalty is a new income line |
| Mainnet with active users | **You don't have this yet.** Say "devnet" out loud, and say what mainnet needs. Don't hide it. |

The listing also asks for "end-to-end launch flows integrating the full Meteora stack" and "novel curve or fee configurations". Those two phrases are your strongest hooks, so use them.

## Before you hit record

1. Two browser profiles, each with Phantom set to **devnet**: one is the **maker**, one is the **backer**. (One wallet can do both if you are short on time, but two looks better.)
2. In **each** wallet, connect on the site and press **Get test USDC** (50 test USDC plus a little SOL).
3. Use a **tiny campaign** so one backer can fill the goal with 50 USDC: tier 1 = **3 items at $4**, tier 2 = **4 items at $5**, final price **$6** (goal about **$35**). Product: "Hackathon Hoodie".
4. Pick the **1 minute** launch-rush window so you aren't waiting. Early buys cost an extra fee that falls to 1%, which is itself a nice talking point.
5. Do one full dry run first. Devnet can be slow, so keep a second campaign already launched as a fallback take.
6. Close other tabs, set the browser zoom to 110%, and hide the bookmarks bar.

## The script

### 0:00 to 0:20. The problem and the idea (screen: home page)

**Say:**
"A thirty-dollar hoodie drop sells out in a minute. Resellers flip it for three hundred, and the maker earns nothing. Kickstarter funds makers but ignores resale. Backed fixes both on one Meteora Dynamic Bonding Curve: early fans pay less, the maker gets funded, and the maker earns on every resale."

**Do:** slowly scroll the home page past the three steps, then click **Start a campaign**.

### 0:20 to 0:55. The maker creates a campaign (screen: /create)

**Do:** Step 1: name "Hackathon Hoodie", brand "Your Studio". Step 2: enter the two tiers and the $6 final price. Step 3: point at the payout card. Step 4: **Launch campaign**, approve in Phantom.

**Say:**
"I'm the maker. I name the product and set two early-bird tiers: three at four dollars, four at five. The price climbs the curve as items sell. This payout card shows ten percent at the goal, and the rest unlocking after my promised ship date, so I can't walk away with everything. I sign once, and the platform never signs anything for me."

### 0:55 to 1:15. What that really is (screen: the new campaign page, scroll to the **On-chain** card)

**Say:**
"Here's what matters for the track. There is no custom program. Every tier is a DBC curve segment. The funding goal is the migration threshold. The maker's upfront budget is the migration fee. The launch-rush fee is DBC's fee scheduler. Every rule is Meteora config, and nobody, including me, can change it after launch."

**Do:** let the On-chain card sit on screen while you speak. Point at the curve chart on the way up.

### 1:15 to 1:40. Backers pay less when they are early (screen: backer profile)

**Do:** open the campaign link as the backer. Back **1 item**, then back **the rest** until the goal bar fills. The last buy stops exactly at the goal.

**Say:**
"As a backer I buy whole items, with a slippage limit. The first backers pay four dollars, later ones more. Before the goal I could sell back at the curve price. The last buy stops exactly at the goal, so nobody overpays."

### 1:40 to 2:10. Goal reached, so the resale market opens (screen: campaign page)

**Do:** click **Close funding & open resale**, approve. Show the resale panel (royalty, locked share, "backer floor").

**Say:**
"Goal reached. One click migrates the pool to a DAMM v2 pool, using the Customizable fee so the maker sets a resale royalty. Twenty percent of that liquidity is locked forever, so a voucher always has a buyer. The maker's other eighty percent unlocks on the ship schedule through DBC's liquidity vesting. The maker earns on every resale."

### 2:10 to 2:30. Redeem and ship (screen: backer, then maker)

**Do:** as the backer, redeem 1 voucher with a shipping address. Switch to the maker, sign in to **Orders**, mark it shipped.

**Say:**
"To get the hoodie, the backer burns a voucher. The burn carries a memo tying it to their encrypted address, and only the maker can read it. Shipped, and the address is deleted."

### 2:30 to 3:00. Close (screen: back to the campaign page, or the repo README)

**Say:**
"That's the full Meteora stack: DBC curve and fees, migration, DAMM v2, permanent lock and liquidity vesting, with no custom program. It's tested end to end in CI against the real mainnet DBC and DAMM v2 binaries, and clicked through in a real browser. Today it runs on devnet; the next step is a first mainnet campaign with a real maker. Backed turns pre-orders into a new kind of asset, where makers get funded and fans share the upside."

## Say this, not that

| Instead of | Say |
|---|---|
| "token launchpad" | "pre-orders" or "pre-order voucher" |
| "bonding curve" (first time) | "a price that rises as more people join" |
| "migrate" or "graduate" | "close funding and open resale" |
| "drop-bot fee" | "launch-rush fee" |
| "LP vesting" | "the maker's money unlocks after the ship date" |

Use the Meteora terms only in the 0:55 beat, where the judges want to hear them.

## If a judge asks

- **Why a curve and not a fixed price?** It rewards early fans and prices demand automatically, so the maker doesn't have to guess.
- **What stops a maker from taking the money and not shipping?** Only a small share is paid at the goal, capped by a trust tier from wallet history. The rest unlocks on a ship-date schedule.
- **Why not Kickstarter?** Fixed price, no way out, and resellers keep the upside. Here the maker earns a royalty on every resale.
- **Is it live on mainnet?** Not yet. Devnet with test USDC. CI runs the full lifecycle against the real mainnet Meteora binaries on a local validator, and a first mainnet campaign is the next step.
- **Who is it for?** Small brands, designers and indie hardware makers who can't front production cost.

## If something goes wrong while recording

- **A transaction fails or hangs:** wait 10 seconds, then retry once. Devnet can lag. If it fails twice, stop, and switch to your fallback campaign.
- **Wallet shows the wrong network:** Phantom, then Settings, then Developer Settings, then Testnet Mode, then Solana Devnet.
- **Out of test USDC:** press **Get test USDC** again (it is rate limited), or use the other wallet.
- **You run over 3:00:** cut the 2:10 to 2:30 beat to one sentence. Don't cut the 0:55 beat.

## Fields for the submission form

Pitch video: the Loom link. The submission text is already in [`submission.md`](submission.md). The Colosseum question still needs a yes or no answer, and you should paste the Colosseum project and profile links if you also submit there.
