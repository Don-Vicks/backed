> Real devnet transactions for a full campaign lifecycle.

[← Back to the README](../README.md)

# Proof on devnet

**Live app (devnet): <https://backed.up.railway.app>.** Connect Phantom, Solflare or Backpack on devnet and press **Get test USDC**. One campaign below ran its whole lifecycle through the deployed app's API (`packages/core/src/scripts/api-smoke.ts` with `WEB_URL` set to the live URL): [campaign page](https://backed.up.railway.app/c/35VWhx5hzBSqNWzoF6GNHjG2678Dnh7JNuSuYzmRjgwk) · [DBC pool](https://solscan.io/account/35VWhx5hzBSqNWzoF6GNHjG2678Dnh7JNuSuYzmRjgwk?cluster=devnet) · [config](https://solscan.io/account/HErqhdimKwb3spkjEmfdMvxWtHAsuifu8uUgV4L88SS5?cluster=devnet) · [DAMM v2 resale pool](https://solscan.io/account/EoTKorP57G4C3jjr8Y5KXXHvZVSATCTFBRaTXgAMoffP?cluster=devnet).

| Step | Transaction |
|---|---|
| Maker signs and pays for the campaign (`createConfigAndPool`; the platform never signs) | [tx](https://solscan.io/tx/Nx3xsCcaMMFir5CqgLS8pHbPy5rijZY4bvttSuJNYhMHUF3rmz9R867Bp4UUZCv9JD7TeYs2HTGLYzzWsz5rS5R?cluster=devnet) |
| Maker publishes the on-chain listing (DBC pool metadata) | [tx](https://solscan.io/tx/2CbKu6dB9z8s8VdQWBF4nJo6NedVLmwjZvAJRWxqEHL9Q4ei9Sqb6Mxx94p4923HTEhG8uTh5zdqoh8rpyE8hght?cluster=devnet) |
| Backer backs 3 USDC with a referral, then exits part of it at the curve price | [buy](https://solscan.io/tx/5ZF2XtawFo4Whc8tjYVxZuqctDB7zEBc7c5cVJxwhijD22boP1AD7gy7zGhs2FZGaRBgvJmwkuQh79FbShyTYW12?cluster=devnet) · [exit](https://solscan.io/tx/5quRXvPrZvoPNjBCds5TgsPmqQmYFQS2wSG8zNCAPw6c1BszSfGMbSwU3YzHL45vCKDphEbwt9JphtohgjLzVKCp?cluster=devnet) |
| Backer buys exactly 1 whole unit (`ExactOut`) with a referral | [tx](https://solscan.io/tx/4swRaB5HyYgACSHbYh5zZHGVBV5NpYfZiYiVCUQLat1BThp2yxj5rAq34tCJabqwdKkUxg6xNsRA62XMF8EMfiKg?cluster=devnet) |
| Backers fill to the goal (the last buy stops exactly at it) | [tx](https://solscan.io/tx/5aRDWSATZ2xRqM4kbt5SzY3Jp2JKhD5F6ua9xU1T2TKQUB6YgcqWpJVwZ7Hh8tThyHTmcAXXGKfxqY2BuQqdPaXk?cluster=devnet) · [tx](https://solscan.io/tx/2fFewZopt66nDpHfdPhLvyqM4468aYbu9DeHM6sNrdUX2EUBxXX8Cr7B4eHU6YavDF1VqT1HKifXqPXZg8Sxs3tJ?cluster=devnet) · [tx](https://solscan.io/tx/5pRXSyrAP8JdANh1bjFk4vEgxcAtkBuT4XftLc6a82nKhKj3fwtY7eTyXhBgVa2x1zizSh3vMNHEdYz6bs6M59LW?cluster=devnet) · [tx](https://solscan.io/tx/5FhzbeHDu3NeWhMoNzEjyPGJKD6rwWpwHUKXk57PTWFrmMJMDZkCyVpedpadwxNw9sLMsgP5MqvnJFB7PFzsRLLK?cluster=devnet) |
| A backer pays for graduation to DAMM v2 (Customizable royalty pool, vesting written into the maker's position) | [tx](https://solscan.io/tx/XFs5eg8uvorHBSg1eajf1spitdxovMkBqTuovSgR8DMS6iUJvVJX7qPtvXDGxGnT6c9hY8BotKvCk8as2CuNWKu?cluster=devnet) |
| Maker withdraws the upfront budget | [tx](https://solscan.io/tx/5fJK97ZNXT7KLdpcSvxmZqanHDQUrn2VjmByq1uV3MxXoGaYuFzqUcZqAfYJcjagFBCa6RcPG6dqCtwgh1HP1ypU?cluster=devnet) |
| Backer redeems 1 voucher; the burn carries the order memo `backed:redeem:…` | [tx](https://solscan.io/tx/4SHCDnqoPD21j5bVs7B2CZLpXpj6rfe3tfXd1DxK3hj6uetPE5TdGEgkYf3SsSj9NCnR2cfsoiyeW9J1dSp5RT8p?cluster=devnet) |

## Earlier devnet run

An earlier run of the whole lifecycle through the web API (`API Smoke Mug`), made before maker-paid creation, liquidity vesting and the Customizable resale pool. The current version is exercised end to end in CI and in the [walkthrough](walkthrough.md) against the mainnet program binaries:

| Step | Transaction / account |
|---|---|
| Campaign created (that version: maker signs, platform co-signs) | [tx](https://solscan.io/tx/5DSXxnDJuDu6WQEenQGmj6gEWLd9DEbejMoU6fnqMxXV1R1PEuatAv5jqfRmo3JpQJMtCuRPSVVAQP4QbE6DJzhf?cluster=devnet) · [pool](https://solscan.io/account/22EnU5dJp5FHABW99GkeZLAPVZEQgBq5yhscV6yvQrEY?cluster=devnet) · [config](https://solscan.io/account/7RqrUL2YwvkfkXGHrKX1fv1pZPkckCtXn4cvzfWgJRfR?cluster=devnet) |
| Graduated to DAMM v2 | [tx](https://solscan.io/tx/2QyHs2isMNUeJMBy6VfXtDtqHHtn6Mhw1hXgtaouRjfdDTudpxfwkrUxsZsx8ZEAxeJTZo4NGgf4B79VP7JMpq7z?cluster=devnet) · [resale pool](https://solscan.io/account/Pnq7QAbJ69pRkLurDwLaWgN7xSC58tqvKVD1CqEibHz?cluster=devnet) |
| Resale buy | [tx](https://solscan.io/tx/4hdTNWT7kHojtv8DuujDrcGRqBassnKPEStqAKHULJSdmwYnXrNzH2Y1Y5gKfFXLZswi3f2cUweqQhdkqscA46uV?cluster=devnet) |
| Maker claims curve fees + resale royalties in one tx | [tx](https://solscan.io/tx/3NjgNoxu1MDzYwTZHeK45yP9oHs69ns3nvFCTzVNxzWXABieMocTYnjJY5yCnfekGR1veoSstTQHZ89CN6rNvf4B?cluster=devnet) |

Also measured on devnet: the drop-bot fee on a 2 USDC buy was **40% at launch and 0.8% after the window**, and the maker's budget withdrawal was exactly the configured share of the goal.
