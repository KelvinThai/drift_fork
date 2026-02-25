# Drift Protocol v2 - Admin Operations Guide

> Reference guide for operating a custom perp DEX built on Drift Protocol v2.
> All SDK methods are on `AdminClient` (`sdk/src/adminClient.ts`).
> On-chain handlers live in `programs/drift/src/instructions/admin.rs`.

---

## Table of Contents

1. [Market Initialization](#1-market-initialization)
2. [Oracle Management](#2-oracle-management)
3. [AMM Price Management](#3-amm-price-management)
4. [Spread & Fee Management](#4-spread--fee-management)
5. [TWAP Management](#5-twap-management)
6. [Market Parameters](#6-market-parameters)
7. [Guard Rails & Safety](#7-guard-rails--safety)
8. [Market Lifecycle](#8-market-lifecycle)
9. [State & Protocol Management](#9-state--protocol-management)
10. [Operational Scenarios](#10-operational-scenarios)

---

## 1. Market Initialization

### `initializePerpMarket`

Creates a new perpetual futures market on-chain.

```ts
adminClient.initializePerpMarket(
  marketIndex: number,
  priceOracle: PublicKey,
  baseAssetReserve: BN,        // must equal quoteAssetReserve
  quoteAssetReserve: BN,       // must equal baseAssetReserve
  periodicity: BN,             // funding period in seconds (e.g. 3600)
  pegMultiplier: BN,           // initial price anchor (PEG_PRECISION = 1e3)
  oracleSource: OracleSource,
  contractTier: ContractTier,
  marginRatioInitial: number,  // bps, e.g. 2000 = 20% = 5x leverage
  marginRatioMaintenance: number, // bps, e.g. 500 = 5%
  liquidatorFee: number,
  ifLiquidatorFee: number,
  imfFactor: number,
  activeStatus: boolean,
  baseSpread: number,          // minimum spread (1e6 precision)
  maxSpread: number,           // maximum spread (1e6 precision)
  maxOpenInterest: BN,
  maxRevenueWithdrawPerPeriod: BN,
  quoteMaxInsurance: BN,
  orderStepSize: BN,           // min order size increment
  orderTickSize: BN,           // min price increment
  minOrderSize: BN,
  concentrationCoefScale: BN,
  curveUpdateIntensity: number, // 0-200
  ammJitIntensity: number,      // 0-200
  name: string,
)
```

**On-chain behavior:**
- Validates `baseAssetReserve == quoteAssetReserve` (initial price is fully determined by peg)
- Reads oracle to confirm it's valid
- Sets initial TWAPs (`last_mark_price_twap`, `last_mark_price_twap_5min`) to the initial reserve price
- Increments `state.number_of_markets`

**Key parameter notes:**
- `pegMultiplier`: For SOL at ~$150, set to `new BN(150 * 1e6)` (PRICE_PRECISION). The crank uses PRICE_PRECISION, not PEG_PRECISION.
- `baseAssetReserve`/`quoteAssetReserve`: Larger = deeper AMM book. Typical: `new BN(1000).mul(BASE_PRECISION)`
- `curveUpdateIntensity`: 0 = flat spread only (base_spread/2 each side). 1-100 = dynamic spread based on inventory/oracle. 101-200 = enables reference price offset.
- `ammJitIntensity`: 0 = off. Higher = AMM more aggressively fills taker orders via JIT.

---

### `initializeSpotMarket`

Creates a new spot market. The first spot market (index 0) must be USDC.

```ts
adminClient.initializeSpotMarket(
  mint: PublicKey,
  optimalUtilization: number,  // borrow rate curve
  optimalRate: number,
  maxRate: number,
  oracle: PublicKey,            // PublicKey.default for quote asset
  oracleSource: OracleSource,  // OracleSource.QUOTE_ASSET for USDC
  initialAssetWeight: number,  // SPOT_WEIGHT_PRECISION (1e4), e.g. 10000 = 1.0
  maintenanceAssetWeight: number,
  initialLiabilityWeight: number,
  maintenanceLiabilityWeight: number,
  ...
)
```

**On-chain behavior:**
- Creates PDA vault accounts via CPI
- Validates borrow rate curve
- Validates margin weight ordering (initial <= maintenance for assets)
- Initializes cumulative interest at `SPOT_CUMULATIVE_INTEREST_PRECISION`

---

### `deleteInitializedPerpMarket` / `deleteInitializedSpotMarket`

Removes markets that are in `Initialized` status (not yet active). Useful for fixing bad params.

```ts
adminClient.deleteInitializedPerpMarket(marketIndex)
adminClient.deleteInitializedSpotMarket(marketIndex)
```

**Constraint:** Markets must be in `MarketStatus.INITIALIZED` status. Must delete in reverse index order.

---

## 2. Oracle Management

### `updatePerpMarketOracle`

Switches the oracle feed for a perp market.

```ts
adminClient.updatePerpMarketOracle(
  perpMarketIndex: number,
  oracle: PublicKey,          // new oracle account
  oracleSource: OracleSource, // e.g. PYTH_PULL, Prelaunch
  skipInvariantCheck: boolean  // skip 10% divergence check
)
```

**On-chain behavior:**
- Validates new oracle is readable
- Unless `skipInvariantCheck=true`, rejects if new vs old oracle price diverges > 10%
- Updates `perp_market.amm.oracle` and `perp_market.amm.oracle_source`

**When to use `skipInvariantCheck=true`:**
- Switching between fundamentally different oracle sources (Prelaunch -> PYTH_PULL or vice versa)
- When the old oracle is stale and returning a price that may differ from the new oracle

---

### `initializePrelaunchOracle` / `updatePrelaunchOracleParams` / `deletePrelaunchOracle`

Admin-controlled oracle feeds for markets without external price feeds.

```ts
adminClient.initializePrelaunchOracle(perpMarketIndex, price?, maxPrice?)
adminClient.updatePrelaunchOracleParams(perpMarketIndex, price?, maxPrice?)
adminClient.deletePrelaunchOracle(perpMarketIndex)
```

**Key behavior of `updatePrelaunchOracleParams`:**
- Sets oracle price directly
- **Also resets** `last_mark_price_twap`, `last_mark_price_twap_5min`, and their timestamps to the new price
- This is the **only** admin method that directly resets the mark price TWAP for non-trade operations

---

### `initializePythPullOracle`

Creates a PDA-based Pyth pull oracle account. Must be called before using `PYTH_PULL` oracle source.

```ts
adminClient.initializePythPullOracle(feedId: string) // hex Pyth feed ID
```

---

### `updateSpotMarketOracle`

Same as `updatePerpMarketOracle` but for spot markets.

```ts
adminClient.updateSpotMarketOracle(spotMarketIndex, oracle, oracleSource, skipInvariantCheck?)
```

---

## 3. AMM Price Management

### `recenterPerpMarketAmmCrank` (Recommended)

The simplest way to realign the AMM to the oracle price. Reads the oracle on-chain and sets peg = oracle_price automatically.

```ts
adminClient.recenterPerpMarketAmmCrank(
  perpMarketIndex: number,
  depth?: BN  // optional: target quote depth for liquidity sizing
)
```

**On-chain behavior:**
1. Reads oracle price directly via `get_oracle_price()`
2. Sets `peg_multiplier = oracle_price` (in PRICE_PRECISION, 1e6)
3. Rebalances reserves so `base_asset_reserve == quote_asset_reserve == sqrtK`
4. If `depth` is provided, adjusts `sqrtK` proportionally to target that quote depth
5. **Does NOT reset** `last_mark_price_twap` or `last_mark_price_twap_5min`

**When to use:** Routine recentering when the AMM has drifted from oracle. This is the go-to method for keeping markets healthy.

---

### `recenterPerpMarketAmm`

Manual version of recentering where you specify peg and sqrtK directly.

```ts
adminClient.recenterPerpMarketAmm(
  perpMarketIndex: number,
  pegMultiplier: BN,  // new peg in PRICE_PRECISION (1e6)
  sqrtK: BN           // new liquidity depth
)
```

**On-chain behavior:**
- Sets new peg, makes `base == quote == sqrtK`
- Recalculates terminal reserves, bid/ask bounds
- **Does NOT reset TWAPs**

**When to use:** When you need fine control over both the peg and liquidity depth, or when the crank fails.

**Common mistake:** The peg is in PRICE_PRECISION (1e6), NOT PEG_PRECISION (1e3). For SOL at $81.30: `new BN(81_300_000)`.

---

### `moveAmmToPrice`

Slides AMM reserves along the existing curve to reach a target price. Keeps k and peg constant.

```ts
adminClient.moveAmmToPrice(
  perpMarketIndex: number,
  targetPrice: BN  // in PRICE_PRECISION (1e6)
)
```

**On-chain behavior (via `controller::amm::move_price`):**
1. SDK calls `calculateTargetPriceTrade()` to figure out the "virtual trade" needed
2. SDK calls `calculateAmmReservesAfterSwap()` to compute new reserves
3. On-chain: validates k invariant (within +/-100), recalculates terminal reserves, bid/ask bounds, and spreads

**When to use:** Fine-tuning the AMM price after a `recenterPerpMarketAmm` call, or nudging the price to exactly match oracle.

---

### `moveAmmPrice`

Low-level: directly sets AMM base/quote reserves.

```ts
adminClient.moveAmmPrice(
  perpMarketIndex: number,
  baseAssetReserve: BN,
  quoteAssetReserve: BN,
  sqrtK?: BN
)
```

**When to use:** Rarely. Prefer `moveAmmToPrice` or `recenterPerpMarketAmmCrank`.

---

### `repegAmmCurve`

Changes the AMM peg multiplier while keeping reserves asymmetric. The cost must be covered by accumulated fees.

```ts
adminClient.repegAmmCurve(
  newPeg: BN,
  perpMarketIndex: number
)
```

**On-chain behavior:**
- Calculates cost of the repeg
- Validates cost is affordable from `total_fee_minus_distributions`
- Emits a `CurveRecord` event

**When to use:** Organic peg adjustment driven by market dynamics. Unlike `recenterPerpMarketAmm` which resets reserves to equal, this keeps the current reserve asymmetry.

---

### `updateK`

Changes AMM liquidity depth (k = base * quote).

```ts
adminClient.updateK(
  perpMarketIndex: number,
  sqrtK: BN
)
```

**On-chain behavior:**
- Increasing k: cost must be <= fee surplus, new `sqrtK < MAX_SQRT_K`
- Decreasing k: must yield non-negative profit
- Price change from k adjustment capped at `MAX_UPDATE_K_PRICE_CHANGE`
- Updates `total_fee_minus_distributions`

**When to use:** Adjusting AMM liquidity depth. Deeper k = tighter spreads and less slippage but more capital at risk.

---

## 4. Spread & Fee Management

### `updatePerpMarketMaxSpread`

Sets the maximum allowable bid/ask spread.

```ts
adminClient.updatePerpMarketMaxSpread(perpMarketIndex, maxSpread: number)
```

**Precision:** 1e6. Examples: 2000 = 0.2% (20 bps), 50000 = 5%, 142500 = 14.25%.

**On-chain validation:** `maxSpread >= base_spread` and `maxSpread <= margin_ratio_initial * 100`.

**When to use:** After initialization (default is often too wide), or when spreads blow out due to TWAP divergence.

---

### `updatePerpMarketBaseSpread`

Sets the minimum bid/ask spread.

```ts
adminClient.updatePerpMarketBaseSpread(perpMarketIndex, baseSpread: number)
```

**On-chain behavior:** Sets `amm.base_spread`, `amm.long_spread = baseSpread/2`, `amm.short_spread = baseSpread/2`.

**Precision:** 1e6. Example: 1000 = 0.1% (10 bps, 5 bps each side).

---

### `updateAmmJitIntensity`

Controls how aggressively the AMM participates as a JIT (just-in-time) liquidity provider.

```ts
adminClient.updateAmmJitIntensity(perpMarketIndex, ammJitIntensity: number)
```

**Range:** 0 (off) to 200 (max aggressiveness).

---

### `updatePerpMarketAmmSpreadAdjustment`

Fine-tunes spread via signed adjustments. Can be called by hot wallet admin.

```ts
adminClient.updatePerpMarketAmmSpreadAdjustment(
  perpMarketIndex: number,
  ammSpreadAdjustment: number,           // i8: percentage adjustment to calculated spread
  ammInventorySpreadAdjustment: number,  // i8: adjustment to inventory-based spread
  referencePriceOffset: number           // i32: shifts reference price for marking
)
```

**When to use:** Manual market-making adjustments for specific market conditions.

---

### `updatePerpMarketFeeAdjustment`

Adjusts the fee for a specific perp market.

```ts
adminClient.updatePerpMarketFeeAdjustment(perpMarketIndex, feeAdjustment: number) // signed i16
```

---

### `updatePerpFeeStructure` / `updateSpotFeeStructure`

Replaces the entire fee structure (tiers, maker/taker fees, referral rebates) at the state level.

```ts
adminClient.updatePerpFeeStructure(feeStructure: FeeStructure)
adminClient.updateSpotFeeStructure(feeStructure: FeeStructure)
```

---

## 5. TWAP Management

Understanding TWAPs is critical for operations. The AMM maintains several TWAPs:

| Field | What it is | Updated by |
|-------|------------|------------|
| `last_mark_price_twap` | Mark price TWAP (1hr) | Trades, funding rate updates |
| `last_mark_price_twap_5min` | Mark price TWAP (5min) | Trades, funding rate updates |
| `last_bid_price_twap` | Bid TWAP | Trades, funding rate updates |
| `last_ask_price_twap` | Ask TWAP | Trades, funding rate updates |
| `historical_oracle_data.last_oracle_price_twap` | Oracle TWAP | Oracle updates, admin methods |

The **mark price** shown on the frontend = midpoint of L2 bid/ask from the DLOB server. The L2 bid/ask comes from the AMM's spread calculation, which uses TWAPs. So stale TWAPs cause wide spreads, which cause wrong mark prices.

### `updatePerpMarketAmmOracleTwap`

Updates the stored oracle TWAP to reduce the mark-oracle TWAP gap.

```ts
adminClient.updatePerpMarketAmmOracleTwap(perpMarketIndex)
```

**On-chain behavior:**
- Reads oracle's own TWAP
- If oracle-mark gap would flip sign: sets oracle TWAP = mark TWAP (zeroes gap)
- If gap shrinks: updates oracle TWAP to new value
- If gap grows: returns `PriceBandsBreached` error
- **Requires non-stale oracle** (fails with `OracleStaleForAMMUpdate` / 0x1787 if oracle is stale)

**When to use:** When oracle TWAP has drifted and you want to nudge it closer to mark price. Reduces extreme funding rates.

---

### `resetPerpMarketAmmOracleTwap`

Emergency admin failsafe. Forces `oracle_price_twap = mark_price_twap`.

```ts
adminClient.resetPerpMarketAmmOracleTwap(perpMarketIndex)
```

**On-chain behavior:**
- Unconditionally sets `last_oracle_price_twap = last_mark_price_twap`
- Syncs timestamps
- **Does NOT modify `last_mark_price_twap`** itself
- **Does NOT require a non-stale oracle**

**When to use:** Emergency — when oracle TWAP is corrupted or wildly divergent from mark TWAP.

---

### How TWAPs Naturally Update

TWAPs are updated during trades and funding rate cranks via `update_mark_twap()`:

```
new_twap = weighted_average(current_price, old_twap, time_since_last, remaining_period)
```

When `time_since_last >= funding_period` (typically 3600s), the weight is almost entirely on the current price, so the TWAP essentially resets. This means **executing a single trade after an hour of inactivity will reset the TWAP**.

The funding rate updater keeper bot also calls `update_mark_twap_crank()` which updates the mark TWAP using AMM bid/ask prices.

---

## 6. Market Parameters

### `updatePerpMarketMarginRatio`

Sets leverage limits.

```ts
adminClient.updatePerpMarketMarginRatio(
  perpMarketIndex,
  marginRatioInitial: number,      // bps. 2000 = 20% = 5x leverage
  marginRatioMaintenance: number   // bps. 500 = 5%
)
```

**Validation:** initial > maintenance, compatible with high leverage mode and liquidator fee.

---

### `updatePerpMarketContractTier`

Changes risk tier which determines insurance fund caps and settlement limits.

```ts
adminClient.updatePerpMarketContractTier(perpMarketIndex, contractTier: ContractTier)
```

**Tiers (from most to least protected):** `A` > `B` > `C` > `Speculative` > `HighlySpeculative` > `Isolated`

**When to use:** During E2E testing, use `Speculative` for more lenient settlement divergence limits. For production, use `A` or `B`.

---

### `updatePerpMarketConcentrationScale`

Adjusts how concentrated AMM liquidity is around the current price.

```ts
adminClient.updatePerpMarketConcentrationScale(perpMarketIndex, concentrationScale: BN)
```

Higher = more concentrated (tighter spread but less range). Recalculates `min_base_asset_reserve` and `max_base_asset_reserve`.

---

### `updatePerpMarketCurveUpdateIntensity`

Controls how aggressively the AMM adjusts its curve in response to oracle changes.

```ts
adminClient.updatePerpMarketCurveUpdateIntensity(perpMarketIndex, curveUpdateIntensity: number)
```

**Range:**
- 0: Flat spread only (`base_spread/2` each side), no dynamic adjustment
- 1-100: Dynamic spread based on inventory, oracle divergence, revenue, etc.
- 101-200: Also enables reference price offset (mark can diverge from reserve price)

---

### `updatePerpMarketMaxImbalances`

Sets insurance and revenue withdrawal limits per market.

```ts
adminClient.updatePerpMarketMaxImbalances(
  perpMarketIndex,
  unrealizedMaxImbalance: BN,         // max PnL imbalance
  maxRevenueWithdrawPerPeriod: BN,    // max tokens withdrawable per period
  quoteMaxInsurance: BN               // max insurance payout
)
```

---

### `updatePerpMarketMaxOpenInterest`

Caps total open interest.

```ts
adminClient.updatePerpMarketMaxOpenInterest(perpMarketIndex, maxOpenInterest: BN)
```

---

### `updatePerpMarketImfFactor`

Size-based margin scaling. Higher IMF = larger positions need more margin.

```ts
adminClient.updatePerpMarketImfFactor(perpMarketIndex, imfFactor, unrealizedPnlImfFactor)
```

---

### `updatePerpMarketStepSizeAndTickSize`

Sets minimum order increments.

```ts
adminClient.updatePerpMarketStepSizeAndTickSize(perpMarketIndex, stepSize: BN, tickSize: BN)
```

---

### `updatePerpMarketMinOrderSize`

```ts
adminClient.updatePerpMarketMinOrderSize(perpMarketIndex, orderSize: BN)
```

---

### `updatePerpMarketLiquidationFee`

Sets fee split between liquidator and insurance fund.

```ts
adminClient.updatePerpMarketLiquidationFee(perpMarketIndex, liquidatorFee, ifLiquidationFee)
```

---

## 7. Guard Rails & Safety

### `updateOracleGuardRails`

Sets oracle validity parameters at the protocol level.

```ts
adminClient.updateOracleGuardRails(oracleGuardRails: OracleGuardRails)
```

**Key fields:**
- `priceDivergence`: Thresholds for oracle-mark price divergence
- `validity`: Max confidence interval, max delay slots, etc.

**When to use:** When using synthetic/prelaunch oracles with wide confidence intervals, widen the guard rails. For production with Pyth, use strict defaults.

---

### `updateExchangeStatus`

Enables/disables exchange-wide operations using bit flags.

```ts
adminClient.updateExchangeStatus(exchangeStatus: ExchangeStatus)
```

Can pause: trading, deposits, withdrawals, liquidations, settlements, etc.

---

### `updatePerpMarketPausedOperations`

Pauses specific operations for a single market.

```ts
adminClient.updatePerpMarketPausedOperations(perpMarketIndex, pausedOperations: number)
```

Uses `PerpOperation` bit flags (fill, AMM fill, liquidation, etc.).

---

## 8. Market Lifecycle

### Status Flow

```
Initialized -> Active -> [FundingPaused|AmmPaused|FillPaused|ReduceOnly] -> Settlement -> Delisted
```

### `updatePerpMarketStatus`

```ts
adminClient.updatePerpMarketStatus(perpMarketIndex, marketStatus: MarketStatus)
```

### `updatePerpMarketExpiry`

Sets an expiry timestamp. After expiry + settlement duration, market can be settled.

```ts
adminClient.updatePerpMarketExpiry(perpMarketIndex, expiryTs: BN)
```

### Pool Management

```ts
adminClient.depositIntoPerpMarketFeePool(perpMarketIndex, amount, sourceVault)
adminClient.updatePerpMarketPnlPool(perpMarketIndex, amount)
adminClient.depositIntoSpotMarketVault(spotMarketIndex, amount, sourceVault)
```

### `updatePerpMarketAmmSummaryStats`

Recalculates or overrides AMM accounting stats.

```ts
adminClient.updatePerpMarketAmmSummaryStats(
  perpMarketIndex,
  updateAmmSummaryStats?: boolean,      // if true, recalculates total_fee_minus_distributions
  quoteAssetAmountWithUnsettledLp?: BN, // override
  netUnsettledFundingPnl?: BN,          // override
  excludeTotalLiqFee?: boolean
)
```

**When to use:** Correcting accounting discrepancies, updating after LP settlement.

---

## 9. State & Protocol Management

### `updateAdmin`
```ts
adminClient.updateAdmin(newAdmin: PublicKey) // transfer admin role
```

### `updatePerpAuctionDuration`
```ts
adminClient.updatePerpAuctionDuration(minDuration: number) // JIT auction window in slots
```

### `updateStateMaxNumberOfSubAccounts`
```ts
adminClient.updateStateMaxNumberOfSubAccounts(max: number)
```

### Liquidation Config
```ts
adminClient.updateInitialPctToLiquidate(pct: number)
adminClient.updateLiquidationDuration(duration: number)
adminClient.updateLiquidationMarginBufferRatio(ratio: number)
```

### Naming
```ts
adminClient.updatePerpMarketName(perpMarketIndex, name: string)
adminClient.updateSpotMarketName(spotMarketIndex, name: string)
```

---

## 10. Operational Scenarios

### Scenario 1: Initial Protocol Setup (Day 0)

**When:** After deploying the program for the first time.

**Script:** `scripts/admin/initialize-protocol.ts`

**Steps:**
1. `adminClient.initialize(usdcMint, true)` -- create protocol state
2. `adminClient.initializeSpotMarket(...)` -- create USDC spot market (index 0)
3. `adminClient.initializePerpMarket(...)` -- create each perp market
4. `adminClient.updatePerpAuctionDuration(10)` -- set auction window

**Key decisions:**
- Peg multiplier: approximate market price in PRICE_PRECISION
- Margin ratios: 1000/500 = 10x leverage, 2000/500 = 5x leverage
- Oracle source: `PYTH_PULL` for live, `Prelaunch` for admin-controlled
- AMM reserves: larger = deeper book but more capital at risk

---

### Scenario 2: Switching Oracle Sources

**When:** Pyth feeds go stale on devnet, or transitioning from admin-controlled to live pricing.

#### Live -> Admin-Controlled (`scripts/admin/fix-oracles.ts`)

```ts
adminClient.initializePrelaunchOracle(marketIndex, price)
adminClient.updatePerpMarketOracle(marketIndex, oraclePda, OracleSource.Prelaunch, true)
```

#### Admin-Controlled -> Live (`scripts/admin/switch-to-pyth.ts`)

```ts
// Verify Pyth account exists and has recent data first
adminClient.updatePerpMarketOracle(marketIndex, pythOracle, OracleSource.PYTH_PULL, true)
```

**Always use `skipInvariantCheck=true`** when switching between fundamentally different oracle types.

---

### Scenario 3: Fixing Misaligned AMM Prices

**When:** After oracle switch, after long inactivity, or when `PriceBandsBreached` errors appear.

**Symptoms:** Mark price on frontend differs significantly from oracle price. Wide bid/ask spread.

#### Quick Fix (single command)

```ts
adminClient.recenterPerpMarketAmmCrank(marketIndex)
```

#### Precise Fix (two steps)

```ts
// 1. Recenter with oracle-derived peg
const oracleData = adminClient.getOracleDataForPerpMarket(marketIndex);
const newPeg = oracleData.price; // already in PRICE_PRECISION
adminClient.recenterPerpMarketAmm(marketIndex, newPeg, currentSqrtK);

// 2. Fine-tune to exact oracle price
adminClient.moveAmmToPrice(marketIndex, oracleData.price);
```

**Script:** `scripts/admin/recenter-crank.ts`

---

### Scenario 4: Fixing Wide Spreads

**When:** AMM bid/ask spread is unreasonably wide (e.g., 50%+), making trading impractical.

**Root causes:**
- `maxSpread` set too high at initialization (default 50000 = 5%)
- `lastMarkPriceTwap` diverged from oracle, inflating dynamic spread calculation
- `curveUpdateIntensity > 0` with stale state amplifies spread

**Fix:**

```ts
// Cap the spread at a reasonable level (2000 = 20 bps = 0.2%)
adminClient.updatePerpMarketMaxSpread(marketIndex, 2000);
```

**Script:** `scripts/admin/fix-spreads.ts`

**For diagnostic info, read these AMM fields:**
- `baseSpread`, `maxSpread`, `longSpread`, `shortSpread`
- `lastMarkPriceTwap`, `lastMarkPriceTwap5min`
- `lastBidPriceTwap`, `lastAskPriceTwap`
- `curveUpdateIntensity`

---

### Scenario 5: Handling Stale Oracles on Devnet

**When:** Pyth devnet oracles stop updating, causing `OracleStaleForAMMUpdate` (0x1787) errors.

**Affected operations:**
- `updatePerpMarketAmmOracleTwap` fails
- Keeper bots can't update funding rates
- DLOB publisher removes vAMM orders (empty orderbook)
- Fills may fail

**Fix options (from least to most disruptive):**

1. **DLOB publisher:** Set `STALE_ORACLE_REMOVE_VAMM_THRESHOLD=999999` env var to keep vAMM orders despite stale oracle
2. **Reset oracle TWAP:** `adminClient.resetPerpMarketAmmOracleTwap(marketIndex)` -- doesn't need fresh oracle
3. **Switch to Prelaunch:** `adminClient.updatePerpMarketOracle(marketIndex, prelaunchOracle, OracleSource.Prelaunch, true)` then manually set price
4. **Set up Pyth price pusher:** Run a service that pushes Pyth prices to keep oracle accounts fresh

---

### Scenario 6: E2E Test Market Setup

**When:** Running automated tests that need specific oracle prices and clean AMM state.

**Script:** `scripts/e2e/setup/oracle.ts`

```ts
// 1. Set oracle to desired price (prelaunch oracles only)
adminClient.updatePrelaunchOracleParams(marketIndex, price);

// 2. Move AMM to match
adminClient.moveAmmToPrice(marketIndex, price);

// 3. Reset oracle TWAP to eliminate divergence
adminClient.resetPerpMarketAmmOracleTwap(marketIndex);

// 4. Loosen guard rails for testing
adminClient.updatePerpMarketContractTier(marketIndex, ContractTier.SPECULATIVE);
adminClient.updateOracleGuardRails({ ... }); // widen confidence to 50%
```

---

### Scenario 7: Full Protocol Reset (Nuclear Option)

**When:** Protocol state is corrupted, need to switch USDC mints, or need a clean slate.

**Script:** `scripts/admin/reset-with-mock-usdc.ts`

**Steps (order matters!):**
1. Delete admin user account: `adminClient.deleteUser(0)`
2. Set all perp markets to INITIALIZED (reverse order): `adminClient.updatePerpMarketStatus(i, MarketStatus.INITIALIZED)`
3. Delete all perp markets (reverse order): `adminClient.deleteInitializedPerpMarket(i)`
4. Set all spot markets to INITIALIZED (reverse order)
5. Delete all spot markets (reverse order)
6. Create new mock USDC mint (standard SPL token, not an admin method)
7. Re-initialize everything from scratch

**After reset:** Update USDC mint in `sdk/src/constants/spotMarkets.ts`, rebuild SDK, reinstall in all downstream projects (frontend, keeper bots, DLOB server).

---

### Scenario 8: Routine Maintenance Checklist

Run periodically to keep markets healthy:

```ts
// For each market:
const perp = adminClient.getPerpMarketAccount(i);
const oracle = adminClient.getOracleDataForPerpMarket(i);
const oraclePrice = Number(oracle.price) / 1e6;
const reservePrice = /* compute from reserves */;
const divergence = Math.abs(reservePrice - oraclePrice) / oraclePrice;

// 1. Recenter if AMM has drifted > 1% from oracle
if (divergence > 0.01) {
  await adminClient.recenterPerpMarketAmmCrank(i);
}

// 2. Check spread health
if (perp.amm.maxSpread > 5000) {
  await adminClient.updatePerpMarketMaxSpread(i, 2000);
}

// 3. Reset oracle TWAP if divergent
await adminClient.resetPerpMarketAmmOracleTwap(i);
```

---

## Access Control Notes

Most admin methods require the `state.admin` key to sign. Some methods support **hot wallet** signing (either `admin_hot_wallet` or `amm_spread_adjust_wallet`):

| Hot Wallet Methods |
|---|
| `recenterPerpMarketAmmCrank` |
| `updatePerpMarketCurveUpdateIntensity` |
| `updateAmmJitIntensity` |
| `updatePerpMarketMaxSpread` |
| `updatePerpMarketAmmSpreadAdjustment` |
| `updatePerpMarketAmmSummaryStats` |
| `depositIntoSpotMarketVault` |

Set `adminClient.useHotWalletAdmin = true` to use hot wallet signing.

---

## Quick Reference: Function -> Scenario Mapping

| I need to... | Use this function |
|---|---|
| Create a new perp market | `initializePerpMarket` |
| Create a new spot market | `initializeSpotMarket` |
| Switch oracle feed | `updatePerpMarketOracle` (with `skipInvariantCheck=true` for source changes) |
| Set oracle price manually | `updatePrelaunchOracleParams` |
| Align AMM to oracle (simple) | `recenterPerpMarketAmmCrank` |
| Align AMM to oracle (precise) | `recenterPerpMarketAmm` + `moveAmmToPrice` |
| Fix wide spreads | `updatePerpMarketMaxSpread` |
| Fix stale TWAP | `resetPerpMarketAmmOracleTwap` |
| Update funding-related TWAP | `updatePerpMarketAmmOracleTwap` |
| Change leverage limits | `updatePerpMarketMarginRatio` |
| Change risk tier | `updatePerpMarketContractTier` |
| Adjust AMM liquidity depth | `updateK` |
| Pause a market | `updatePerpMarketStatus` or `updatePerpMarketPausedOperations` |
| Delete a market | Set to `INITIALIZED` status, then `deleteInitializedPerpMarket` |
| Emergency pause everything | `updateExchangeStatus` |
| Loosen oracle checks | `updateOracleGuardRails` |
| Reset the whole protocol | See Scenario 7 |
