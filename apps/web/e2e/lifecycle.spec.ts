// One campaign through every feature, in a real browser with keypair wallets, against the app running
// on localnet (the mainnet DBC, DAMM v2, Metaplex and Locker programs). Every step is a real on-chain
// transaction. e2e/run-localnet.sh seeds the wallets and starts the app with a seconds-long vesting
// schedule (VESTING_SCHEDULE_OVERRIDE) and a tier-A trust fixture for the maker.
// E2E_SHOTS=<dir> also saves the screenshots in docs/walkthrough.md along the way.
import fs from "fs";
import path from "path";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Keypair } from "@solana/web3.js";
import { attachWallet, type TestWallet } from "./wallet";

const ROOT = process.env.PREORDER_ROOT ?? "";
const keypair = (role: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, "keys", "localnet", `${role}.json`), "utf8")) as number[]));

type Actor = { context: BrowserContext; page: Page; wallet: TestWallet; pageErrors: string[] };

async function actor(browser: Browser, role: string, mobile = false): Promise<Actor> {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {});
  const wallet = await attachWallet(context, keypair(role), { rpc: process.env.LOCALNET_RPC_URL || "http://127.0.0.1:8899" });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  return { context, page, wallet, pageErrors };
}

// Sonner marks a settled toast with data-type=success|error.
const succeeded = (page: Page, text: RegExp) =>
  expect(page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: text }).last()).toBeVisible({ timeout: 120_000 });
const noErrorToasts = async (page: Page) => expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
const backButton = (page: Page) => page.getByRole("button", { name: /^Back (the last )?[\d.]+ ·/ });

// A full-page screenshot for the walkthrough, without toasts, once the page has settled.
const SHOTS = process.env.E2E_SHOTS;
async function shot(page: Page, name: string, { fullPage = true } = {}) {
  if (!SHOTS) return;
  await page.waitForLoadState("networkidle");
  // Full-page captures paint the sticky header where the page is scrolled to, and keep focus rings.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage, animations: "disabled", style: "[data-sonner-toaster] { display: none !important; }" });
}

test.describe.configure({ mode: "serial" });

let pool = "";
let graduatedAt = 0;
const actors: Record<string, Actor> = {};

test.beforeAll(async ({ browser }) => {
  if (!ROOT) throw new Error("PREORDER_ROOT is not set: run e2e/run-localnet.sh");
  for (const role of ["maker", "backer1", "backer2", "backer3", "referrer"]) actors[role] = await actor(browser, role);
});

test.afterAll(async () => {
  for (const a of Object.values(actors)) await a.context.close();
});

test("a wallet with nothing gets test USDC from the faucet", async () => {
  const { page } = actors.referrer;
  await page.goto("/");
  await page.getByRole("button", { name: /test USDC/i }).first().click();
  await succeeded(page, /USDC/);
});

test("the maker steps through the create form, sees the DBC config, then launches", async () => {
  const { page, wallet } = actors.maker;
  const next = () => page.getByRole("button", { name: /^Continue/ }).click();
  await page.goto("/create");
  // Step 1: the product.
  await page.fill("#name", "E2E Hoodie");
  await page.fill("#makerName", "E2E Studio");
  await page.fill("#description", "Browser test campaign.");
  await next();
  // Step 2: the price tiers.
  await page.fill("#units-0", "3");
  await page.fill("#price-0", "4");
  if (!(await page.locator("#units-1").count())) await page.getByRole("button", { name: /Add tier/ }).click();
  await page.fill("#units-1", "4");
  await page.fill("#price-1", "5");
  await page.fill("#final", "6");
  await next();
  // Step 3: the payout, the maker's trust level and the advanced settings.
  await expect(page.getByText(/^Level A · up to/).first()).toBeVisible();
  await page.getByText(/^Advanced settings/).click();
  await page.fill("#symbol", "E2EH");
  await page.fill("#royalty", "5");
  await next();
  // Step 4: the review, with the exact DBC mapping (the server's preview is debounced).
  await page.getByText(/how this becomes an on-chain contract/).click();
  await expect(page.locator("li").filter({ hasText: "migrationQuoteThreshold" })).toContainText("$35.33");
  await expect(page.locator("li").filter({ hasText: "migratedPoolFee" })).toContainText("5%");
  await expect(page.getByText("creatorLiquidityVestingInfo")).toBeVisible();
  await shot(page, "01-create");

  await page.getByRole("button", { name: /^Launch campaign/ }).click();
  await page.waitForURL(/\/c\/[1-9A-HJ-NP-Za-km-z]{32,44}/, { timeout: 120_000 });
  pool = new URL(page.url()).pathname.split("/c/")[1];
  expect(wallet.log.filter((l) => l === "signTransaction").length).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole("heading", { name: "E2E Hoodie" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "On-chain" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Pre-order price curve/ })).toBeVisible();
  await expect(page.getByText("E2E Studio").first()).toBeVisible();
  await noErrorToasts(page);
  await shot(page, "02-launched");
});

test("a backer opens a referral link and backs whole units", async () => {
  const { page } = actors.backer1;
  await page.goto(`/c/${pool}?ref=${actors.backer2.wallet.address}`);
  await page.fill("#units", "2");
  await expect(page.getByRole("button", { name: /^Back 2 ·/ })).toBeVisible();
  await page.getByRole("button", { name: /^Back 2 ·/ }).click();
  await succeeded(page, /Back 2 units/);
  await expect(page.getByText("Your vouchers")).toBeVisible();
  await expect(page.locator('dt:has-text("Pre-orders sold") + dd')).toContainText("2 / 7", { timeout: 15_000 });
  await shot(page, "03-back-units");
});

test("a backer exits part of a position at the curve price", async () => {
  const { page } = actors.backer1;
  await page.fill("#exit-amount", "0.5");
  await page.getByRole("button", { name: /^Exit$/ }).click();
  await succeeded(page, /Exit 0\.5 vouchers/);
  await expect(page.getByText(/of a voucher, not redeemable alone/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Top up to 2/ })).toBeVisible();
  await shot(page, "04-exit-and-top-up");
});

test("the campaign's Blink backs a unit from the connected wallet", async () => {
  const { page } = actors.backer2;
  await page.goto(`/c/${pool}`);
  await page.getByRole("link", { name: "See it as a Blink" }).click();
  await expect(page.getByText("Back E2E Hoodie", { exact: true })).toBeVisible();
  await expect(page.getByText(/has not yet been registered/)).toBeVisible(); // until Dialect's registry lists the domain
  await page.getByRole("button", { name: /^Back 1 ·/ }).click();
  await expect(page.getByText(/Backed 1 unit of E2E Hoodie/)).toBeVisible({ timeout: 120_000 });
  await shot(page, "05b-blink");
});

test("the stepper stops at the units left, and the last buy completes the goal", async () => {
  const { page } = actors.backer3;
  await page.goto(`/c/${pool}`);
  const more = page.getByRole("button", { name: "One unit more" });
  for (let i = 0; i < 10 && !(await more.isDisabled()); i++) await more.click();
  await expect(page.locator("#units")).toHaveValue("4"); // 4.5 left: whole units cap at 4
  await expect(backButton(page)).toBeVisible();
  await backButton(page).click();
  await succeeded(page, /Back/);
  await expect(page.getByRole("button", { name: "Close funding & open resale" })).toBeVisible({ timeout: 30_000 });
  await shot(page, "05-goal-reached");
});

test("anyone closes funding, graduating the campaign into the DAMM v2 resale market", async () => {
  const { page } = actors.backer3;
  await page.getByRole("button", { name: "Close funding & open resale" }).click();
  await succeeded(page, /Close funding/);
  graduatedAt = Date.now();
  await expect(page.getByRole("heading", { name: "Resale market" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("DAMM v2 resale pool", { exact: true })).toBeVisible();
});

test("vouchers trade on the resale market", async () => {
  const { page } = actors.backer1;
  await page.goto(`/c/${pool}`);
  await page.fill("#resale-amount", "3");
  await page.getByRole("button", { name: /^(Confirm )?Buy$/ }).click();
  // A thin pool can ask for a second press on a large trade.
  if (await page.getByRole("button", { name: /^Confirm Buy$/ }).isVisible()) await page.getByRole("button", { name: /^Confirm Buy$/ }).click();
  await succeeded(page, /Buy on resale/);
  await page.getByRole("radio", { name: "sell" }).click();
  await page.fill("#resale-amount", "0.2");
  await page.getByRole("button", { name: /^(Confirm )?Sell$/ }).click();
  if (await page.getByRole("button", { name: /^Confirm Sell$/ }).isVisible()) await page.getByRole("button", { name: /^Confirm Sell$/ }).click();
  await succeeded(page, /Sell on resale/);
  await shot(page, "06-resale");
});

test("the maker withdraws the budget, claims fees and unlocks production funds after the cliff", async () => {
  const { page } = actors.maker;
  await page.goto(`/c/${pool}`);
  await page.getByRole("button", { name: /Withdraw .* budget/ }).click();
  await succeeded(page, /Withdraw production budget/);
  await page.reload();
  await expect(page.getByRole("button", { name: /Claim .* fees/ })).toBeVisible();
  await shot(page, "07-maker-earnings"); // budget withdrawn, fees and royalties waiting to be claimed
  await page.getByRole("button", { name: /Claim .* fees/ }).click();
  await succeeded(page, /Claim fees/);
  // The localnet schedule's cliff is 30 s after graduation.
  await page.waitForTimeout(Math.max(0, graduatedAt + 35_000 - Date.now()));
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("button", { name: /Unlock .* production funds/ })).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 90_000 });
  await page.getByRole("button", { name: /Unlock .* production funds/ }).click();
  await succeeded(page, /Unlock production funds/);
  await page.reload();
  await shot(page, "08-unlocked");
});

test("a backer redeems a voucher, and the maker sees and ships the order", async () => {
  const backer = actors.backer3.page;
  await backer.goto(`/c/${pool}`);
  await backer.getByRole("button", { name: /Redeem 1 for the item/ }).click();
  await backer.fill("#ship-name", "Ada Obi");
  await backer.fill("#ship-email", "ada@example.com");
  await backer.fill("#ship-address", "12 Admiralty Way, Lagos");
  await backer.fill("#ship-country", "Nigeria");
  await backer.getByRole("button", { name: /Burn 1 voucher and place order/ }).click();
  await expect(backer.getByRole("heading", { name: "Order placed" })).toBeVisible({ timeout: 120_000 });
  await shot(backer, "09-redeem");

  const maker = actors.maker.page;
  await maker.goto(`/c/${pool}/orders`);
  await maker.getByRole("button", { name: /Sign in to view orders/ }).click();
  await expect(maker.getByText("Ada Obi").first()).toBeVisible();
  await maker.getByRole("button", { name: /Mark shipped/ }).first().click();
  await expect(maker.getByText(/Details deleted after shipping/)).toBeVisible();
  await shot(maker, "10-orders", { fullPage: false });
});

test("stats, link previews and the Blink describe the campaign", async ({ request, page }) => {
  const image = await request.get(`/c/${pool}/opengraph-image`);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toContain("image/png");

  const html = await (await request.get(`/c/${pool}`)).text();
  expect(html).toContain('property="og:title" content="E2E Hoodie');

  const blink = await request.get(`/api/actions/back/${pool}`);
  expect(blink.status()).toBe(200);
  const action = await blink.json();
  expect(action.title).toBe("Back E2E Hoodie");
  expect(action.disabled).toBe(true); // reselling: the Blink points to the resale market

  await page.goto("/stats");
  await expect(page.getByRole("link", { name: "E2E Hoodie" })).toBeVisible();

  await page.goto("/platform");
  await expect(page.getByRole("heading", { name: "Platform earnings" })).toBeVisible();
  await shot(page, "11-platform");
});

test("phones never scroll sideways", async ({ browser }) => {
  const phone = await actor(browser, "backer2", true);
  for (const route of ["/", "/create", `/c/${pool}`, "/stats", "/platform"]) {
    await phone.page.goto(route);
    await phone.page.waitForLoadState("networkidle");
    expect(await phone.page.evaluate(() => document.documentElement.scrollWidth), route).toBeLessThanOrEqual(390);
    if (route === `/c/${pool}`) await shot(phone.page, "12-mobile");
  }
  await phone.context.close();
});

test("no page threw an uncaught error", async () => {
  for (const [role, a] of Object.entries(actors)) expect(a.pageErrors, role).toEqual([]);
});
