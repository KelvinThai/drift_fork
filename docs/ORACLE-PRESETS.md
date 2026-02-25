# Oracle & Funding Configuration Presets — Soccer Team Index Futures

> **Purpose:** Reference document for configuring oracle guard rails, staleness thresholds, and funding parameters for soccer team index perpetual futures on a Drift Protocol v2 fork.

## Table of Contents

1. [Background: Why Soccer Indices Need Custom Presets](#1-background)
2. [Complete Parameter Reference](#2-complete-parameter-reference)
3. [Critical Design Note: Oracle Heartbeats](#3-critical-design-note-oracle-heartbeats)
4. [Presets](#4-presets)
5. [Comparison Table](#5-comparison-table)
6. [How to Apply Presets via SDK](#6-how-to-apply-presets-via-sdk)
7. [Risk Considerations](#7-risk-considerations)

---

## 1. Background

Drift's defaults assume sub-second Pyth oracles. A soccer team index oracle updating every ~30 seconds creates two problems:

1. **Staleness blocks fills.** The default `slots_before_stale_for_amm` is 10 slots (~5 seconds). With a 30-second oracle cadence (~60 slots), the AMM would reject fills ~83% of the time.
2. **Event-driven volatility.** Goals, red cards, and match results cause discrete 5-10% index jumps — not the continuous drift crypto oracles exhibit. Default volatility guards (`too_volatile_ratio = 5`) are too tight if the TWAP lags a sudden jump, yet too loose for the long flat periods between events.

Each preset below tunes these parameters for different operational scenarios.

---

## 2. Complete Parameter Reference

### 2.1 Global Oracle Guard Rails

Set once via `updateOracleGuardRails` — applies to **all** markets.

**Rust struct:** `OracleGuardRails` in `programs/drift/src/state/state.rs:165`
**SDK type:** `OracleGuardRails` in `sdk/src/types.ts:1521`

#### 2.1.1 Price Divergence Guard Rails

| Parameter | Rust Field | Type | Drift Default | Precision | What It Does |
|---|---|---|---|---|---|
| Mark-Oracle % Divergence | `price_divergence.mark_oracle_percent_divergence` | `u64` | `100_000` (10%) | `PERCENTAGE_PRECISION` (1e6) | Max allowed divergence between mark (AMM reserve) price and oracle price. If exceeded, certain operations (funding updates) are blocked. |
| Oracle TWAP 5min % Divergence | `price_divergence.oracle_twap_5min_percent_divergence` | `u64` | `500_000` (50%) | `PERCENTAGE_PRECISION` (1e6) | Max allowed divergence between the current oracle price and its own 5-minute TWAP. Catches sudden oracle manipulation or feed errors. |

#### 2.1.2 Validity Guard Rails

| Parameter | Rust Field | Type | Drift Default | Precision | What It Does |
|---|---|---|---|---|---|
| Slots Before Stale (AMM) | `validity.slots_before_stale_for_amm` | `i64` | `10` (~5s) | Solana slots | Oracle delay beyond this blocks **low-risk** AMM fills. Most important parameter for slow oracles. |
| Slots Before Stale (Margin) | `validity.slots_before_stale_for_margin` | `i64` | `120` (~60s) | Solana slots | Oracle delay beyond this blocks **margin calculations** and can trigger account-level restrictions. |
| Confidence Interval Max Size | `validity.confidence_interval_max_size` | `u64` | `20_000` (2%) | `BID_ASK_SPREAD_PRECISION` (1e6) | Max oracle confidence interval as a fraction of price. Confidence exceeding `max_size * tier_multiplier` marks oracle as `TooUncertain`. |
| Too Volatile Ratio | `validity.too_volatile_ratio` | `i64` | `5` (5x) | Ratio (integer) | If `max(price, twap) / min(price, twap) > ratio`, oracle is marked `TooVolatile`. Default 5 = rejects >80% drops or >400% spikes relative to TWAP. |

### 2.2 Per-Market Oracle Slot Delay Overrides

Set per market via dedicated admin instructions. Override the global `slots_before_stale_for_amm` for a specific market.

**Rust fields:** In `AMM` struct, `programs/drift/src/state/perp_market.rs`

| Parameter | Rust Field | Type | Default | SDK Function | What It Does |
|---|---|---|---|---|---|
| Oracle Slot Delay Override | `amm.oracle_slot_delay_override` | `i8` | `-1` (no override) | `updatePerpMarketOracleSlotDelayOverride` | Overrides the **immediate** AMM fill staleness threshold. `-1` = disabled (all fills require "immediate" freshness check to fail). `0` = never stale for immediate. Positive value = custom slot threshold. |
| Oracle Low-Risk Slot Delay Override | `amm.oracle_low_risk_slot_delay_override` | `i8` | `0` | `updatePerpMarketOracleLowRiskSlotDelayOverride` | Overrides the **low-risk** AMM fill staleness threshold. `0` = falls back to global `slots_before_stale_for_amm`. Positive value = custom slot threshold. |

**How staleness checks work in practice:**

```
oracle_delay = current_slot - oracle_last_update_slot

Immediate fill check:
  if oracle_slot_delay_override != 0:
    stale = oracle_delay > oracle_slot_delay_override
  else:
    stale = true  (always stale for immediate; must pass low-risk instead)

Low-risk fill check:
  if oracle_low_risk_slot_delay_override != 0:
    stale = oracle_delay > oracle_low_risk_slot_delay_override
  else:
    stale = oracle_delay > global.slots_before_stale_for_amm
```

Both overrides are `i8` (max value 127 = ~63 seconds). For a 30-second oracle, you need at minimum 60+ slots for the low-risk override.

### 2.3 Per-Market Contract Tier (Confidence Multiplier)

**Rust:** `PerpMarket.contract_tier` in `programs/drift/src/state/perp_market.rs`
**SDK:** `updatePerpMarketContractTier(perpMarketIndex, contractTier)`

The contract tier determines the `max_confidence_interval_multiplier` applied to `confidence_interval_max_size`:

| Tier | Multiplier | Effective Max Confidence (with default 2% base) |
|---|---|---|
| A | 1x | 2% |
| B | 1x | 2% |
| C | 2x | 4% |
| Speculative | 10x | 20% |
| HighlySpeculative | 50x | 100% (effectively disabled) |
| Isolated | 50x | 100% (effectively disabled) |

**Recommendation for soccer indices:** `Speculative` or `HighlySpeculative` depending on oracle quality.

### 2.4 Funding Rate Parameters

**Rust fields:** In `AMM` struct, `programs/drift/src/state/perp_market.rs`
**Program instruction:** `update_perp_market_funding_period` in `programs/drift/src/lib.rs:1251`

| Parameter | Rust Field | Type | Drift Default | Precision | What It Does |
|---|---|---|---|---|---|
| Funding Period | `amm.funding_period` | `i64` | `3600` (1 hour) | Seconds | How often funding rates are settled. Shorter = more responsive to mark-oracle divergence. Longer = smoother, less noisy funding. |
| Last Funding Rate | `amm.last_funding_rate` | `i64` | `0` | `FUNDING_RATE_PRECISION` (1e9) | Most recent funding rate (read-only, computed). |
| Last Funding Rate Timestamp | `amm.last_funding_rate_ts` | `i64` | `0` | Unix timestamp | When funding was last updated. |
| Last 24h Avg Funding Rate | `amm.last_24h_avg_funding_rate` | `i64` | `0` | `QUOTE_PRECISION` (1e6) | Rolling 24-hour average funding rate (read-only). |
| Cumulative Funding Rate (Long) | `amm.cumulative_funding_rate_long` | `i128` | `0` | `FUNDING_RATE_PRECISION` | Accumulated funding for longs since market inception. |
| Cumulative Funding Rate (Short) | `amm.cumulative_funding_rate_short` | `i128` | `0` | `FUNDING_RATE_PRECISION` | Accumulated funding for shorts since market inception. |

**Funding rate constants** (in `programs/drift/src/math/constants.rs`):

| Constant | Value | Meaning |
|---|---|---|
| `FUNDING_RATE_PRECISION` | 1e9 | Base precision for funding rate values |
| `FUNDING_RATE_OFFSET_DENOMINATOR` | 5000 | Offset applied: `FUNDING_RATE_PRECISION / 5000 = 200_000`. For 1-hour periods, this yields ~7.3% annualized bias. |
| `DEFAULT_MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR` | 3 | Clamps each new TWAP data point to ±33% divergence from current TWAP. Prevents single oracle updates from dominating the TWAP. |

### 2.5 AMM Spread & Oracle-Derived Parameters

These interact with oracle freshness and affect effective trading costs.

| Parameter | Rust Field | SDK Function | What It Does |
|---|---|---|---|
| Base Spread | `amm.base_spread` | `updatePerpMarketBaseSpread` | Minimum bid-ask spread (BPS). Wider spread compensates for oracle uncertainty. |
| Max Spread | `amm.max_spread` | `updatePerpMarketMaxSpread` | Maximum allowed spread under stress conditions. |
| AMM Spread Adjustment | `amm.amm_spread_adjustment` | `updatePerpMarketAmmSpreadAdjustment` | Manual spread offset (admin tuning). |
| Curve Update Intensity | `amm.curve_update_intensity` | `updatePerpMarketCurveUpdateIntensity` | How aggressively AMM reprices toward oracle. 0 = no repricing, 100 = aggressive. |
| Oracle Std | `amm.oracle_std` | (computed) | Standard deviation of oracle price, used for dynamic spread widening. |
| Last Oracle Conf Pct | `amm.last_oracle_conf_pct` | (computed) | Oracle confidence as % of price, feeds into spread calculation. |

### 2.6 Oracle Validity States

**Rust enum:** `OracleValidity` in `programs/drift/src/math/oracle.rs:20`

| State | Meaning | Blocks |
|---|---|---|
| `Valid` | All checks pass | Nothing |
| `StaleForAMM { immediate, low_risk }` | Oracle delay exceeds AMM staleness threshold | AMM fills (immediate and/or low-risk) |
| `InsufficientDataPoints` | Oracle lacks publisher quorum | AMM immediate fills |
| `StaleForMargin` | Oracle delay exceeds margin staleness threshold | Margin calcs, liquidations rely on stale data |
| `TooUncertain` | Confidence interval exceeds max | AMM fills, order matching, margin calcs |
| `TooVolatile` | Price/TWAP ratio exceeds threshold | Almost everything except TWAP/curve updates |
| `NonPositive` | Oracle price ≤ 0 | Everything |

### 2.7 Action-to-Validity Matrix

Which oracle states allow which operations (from `is_oracle_valid_for_action`, `oracle.rs:147`):

| Action | Valid | StaleForAMM | InsufficientData | StaleForMargin | TooUncertain | TooVolatile | NonPositive |
|---|---|---|---|---|---|---|---|
| FillOrderAmmImmediate | Yes | No | No | No | No | No | No |
| FillOrderAmmLowRisk | Yes | Partial* | No | No | No | No | No |
| FillOrderMatch | Yes | Yes | Yes | Yes | No | No | No |
| UpdateFunding | Yes | Yes | Yes | Yes | No | No | No |
| OracleOrderPrice | Yes | Yes | Yes | No | No | No | No |
| MarginCalc | Yes | Yes | Yes | No | No | No | No |
| TriggerOrder | Yes | Yes | Yes | Yes | Yes | No | No |
| Liquidate | Yes | Yes | Yes | Yes | Yes | No | No |
| SettlePnl | Yes | Yes | Yes | Yes | No | No | No |
| UpdateTwap | Yes | Yes | Yes | Yes | Yes | Yes | No |

*Partial: allowed only if `low_risk = false` (i.e., stale for immediate but not yet stale for low-risk).

---

## 3. Critical Design Note: Oracle Heartbeats

### The Problem

During off-hours (no matches, overnight), a soccer index price may not change for hours. If the oracle stops sending updates when the price is unchanged, `oracle_delay` grows unboundedly and the oracle becomes `StaleForMargin` — **freezing all margin calculations, liquidations, and settlements** even though the price is perfectly valid.

### The Solution

**Always send oracle heartbeats**, even when the price has not changed. The oracle updater should:

1. Re-publish the same price with a fresh timestamp at least every `slots_before_stale_for_amm / 2` interval (~30 seconds with the presets below)
2. Set `confidence` to a small value reflecting actual uncertainty (e.g., 0.1-0.5% of price)
3. Set `has_sufficient_number_of_data_points = true`

### Why This Matters More Than Any Parameter Tuning

No combination of generous staleness thresholds can replace heartbeats. Even with `slots_before_stale_for_margin = 6000` (50 minutes), a 2-hour gap between oracle updates will freeze the protocol. Heartbeats are the single most important operational requirement.

### Recommended Heartbeat Cadence

| Scenario | Heartbeat Interval | Rationale |
|---|---|---|
| During matches | 30 seconds (or faster) | Price can change any second |
| Between matches (same day) | 30 seconds | Keeps fills active; news/transfers can move price |
| Off-hours / overnight | 60 seconds | Acceptable lag; saves compute |
| Oracle service degradation | Best-effort, emit last known price | Better stale-but-close than no update at all |

---

## 4. Presets

### 4.1 Match Day

**When to use:** Active match windows with reliable 30-second oracle updates. Prioritizes fill availability over conservatism.

| Category | Parameter | Drift Default | Match Day Value | Rationale |
|---|---|---|---|---|
| **Global Guard Rails** | | | | |
| Price Divergence | `mark_oracle_percent_divergence` | 100,000 (10%) | **150,000 (15%)** | Goals cause instant 5-10% index jumps; AMM reserve price lags slightly behind oracle during spikes. 15% gives breathing room. |
| Price Divergence | `oracle_twap_5min_percent_divergence` | 500,000 (50%) | **500,000 (50%)** | Keep default. 50% is already generous; a 50% divergence from 5min TWAP would indicate a catastrophic oracle error. |
| Validity | `slots_before_stale_for_amm` | 10 (~5s) | **75 (~37s)** | Must exceed the 30-second (~60 slot) oracle cadence. 75 slots gives 7.5 seconds of buffer for network jitter. |
| Validity | `slots_before_stale_for_margin` | 120 (~60s) | **600 (~5 min)** | Generous margin threshold. Even if oracle misses one update cycle, margin calcs continue. |
| Validity | `confidence_interval_max_size` | 20,000 (2%) | **50,000 (5%)** | Custom oracle won't have Pyth-level precision. 5% base × tier multiplier gives room. |
| Validity | `too_volatile_ratio` | 5 (5x) | **10 (10x)** | A major event (relegation, star transfer) could move an index 8-9x from a depressed TWAP. 10x prevents false `TooVolatile` rejections during legitimate spikes. |
| **Per-Market Overrides** | | | | |
| Slot Delay | `oracle_slot_delay_override` | -1 | **0** (disabled) | Disable the immediate freshness speed bump entirely. All AMM fills go through the low-risk path. |
| Slot Delay | `oracle_low_risk_slot_delay_override` | 0 (use global) | **75** | Match the global value. Explicit override per market avoids affecting other markets if globals change. |
| **Per-Market Tier** | | | | |
| Contract Tier | `contract_tier` | A | **Speculative** | 10x confidence multiplier → effective max confidence = 5% × 10 = 50%. Accommodates custom oracle uncertainty. |
| **Funding** | | | | |
| Funding Period | `amm.funding_period` | 3600 (1h) | **3600 (1h)** | During matches, 1-hour funding is appropriate. Prices move, funding should respond. |
| **AMM Spread** | | | | |
| Base Spread | `amm.base_spread` | varies | **200 (2%)** | Wider base spread compensates for 30s oracle latency. Takers pay for the stale-price risk. |
| Max Spread | `amm.max_spread` | varies | **2000 (20%)** | Goals can move price 5-10% instantly; max spread accommodates the AMM's need to protect itself during spikes. |
| Curve Update Intensity | `amm.curve_update_intensity` | varies | **100** | Aggressive repricing toward oracle. During matches, the oracle is authoritative and the AMM should track it closely. |

### 4.2 Standard (Recommended Default)

**When to use:** 24/7 operation. Balanced between fill availability and protection. **Start here.**

| Category | Parameter | Drift Default | Standard Value | Rationale |
|---|---|---|---|---|
| **Global Guard Rails** | | | | |
| Price Divergence | `mark_oracle_percent_divergence` | 100,000 (10%) | **150,000 (15%)** | Same as Match Day — structural need due to event-driven pricing. |
| Price Divergence | `oracle_twap_5min_percent_divergence` | 500,000 (50%) | **500,000 (50%)** | Keep default. |
| Validity | `slots_before_stale_for_amm` | 10 (~5s) | **75 (~37s)** | Same as Match Day — oracle cadence doesn't change. |
| Validity | `slots_before_stale_for_margin` | 120 (~60s) | **1200 (~10 min)** | More generous than Match Day. During quiet periods, a missed heartbeat shouldn't immediately freeze margin calcs. |
| Validity | `confidence_interval_max_size` | 20,000 (2%) | **50,000 (5%)** | Same as Match Day. |
| Validity | `too_volatile_ratio` | 5 (5x) | **10 (10x)** | Same as Match Day. |
| **Per-Market Overrides** | | | | |
| Slot Delay | `oracle_slot_delay_override` | -1 | **0** | Disable immediate speed bump. |
| Slot Delay | `oracle_low_risk_slot_delay_override` | 0 | **75** | Same as Match Day. |
| **Per-Market Tier** | | | | |
| Contract Tier | `contract_tier` | A | **Speculative** | Same as Match Day. |
| **Funding** | | | | |
| Funding Period | `amm.funding_period` | 3600 (1h) | **7200 (2h)** | Longer period smooths out noise during quiet hours. With event-driven pricing, a 1-hour period between matches would produce erratic near-zero funding rates that add gas cost without economic value. |
| **AMM Spread** | | | | |
| Base Spread | `amm.base_spread` | varies | **250 (2.5%)** | Slightly wider than Match Day to account for periods of lower oracle reliability. |
| Max Spread | `amm.max_spread` | varies | **2500 (25%)** | Wider max gives the AMM more room to self-protect during overnight oracle gaps. |
| Curve Update Intensity | `amm.curve_update_intensity` | varies | **75** | Less aggressive than Match Day. During quiet periods, the AMM shouldn't overreact to minor oracle jitter. |

### 4.3 Off-Season / Low Activity

**When to use:** Transfer windows, off-season, or indices with infrequent news. Price changes are rare but can be large (e.g., star player transfer).

| Category | Parameter | Drift Default | Off-Season Value | Rationale |
|---|---|---|---|---|
| **Global Guard Rails** | | | | |
| Price Divergence | `mark_oracle_percent_divergence` | 100,000 (10%) | **200,000 (20%)** | Wider tolerance. Off-season, the AMM's reserve price may drift from oracle due to low trading volume and infrequent repricing. |
| Price Divergence | `oracle_twap_5min_percent_divergence` | 500,000 (50%) | **500,000 (50%)** | Keep default. |
| Validity | `slots_before_stale_for_amm` | 10 (~5s) | **75 (~37s)** | Same — oracle cadence is structural. |
| Validity | `slots_before_stale_for_margin` | 120 (~60s) | **3000 (~25 min)** | Very generous. Off-season oracle may have intermittent delays. This prevents unnecessary margin freezes. |
| Validity | `confidence_interval_max_size` | 20,000 (2%) | **75,000 (7.5%)** | Off-season valuations are inherently less precise. Allow wider confidence bands. |
| Validity | `too_volatile_ratio` | 5 (5x) | **15 (15x)** | A blockbuster transfer can move an index dramatically relative to a stale TWAP. 15x prevents false rejections. |
| **Per-Market Overrides** | | | | |
| Slot Delay | `oracle_slot_delay_override` | -1 | **0** | Disable immediate speed bump. |
| Slot Delay | `oracle_low_risk_slot_delay_override` | 0 | **100 (~50s)** | Slightly more generous than other presets to accommodate potentially slower oracle updates. |
| **Per-Market Tier** | | | | |
| Contract Tier | `contract_tier` | A | **HighlySpeculative** | 50x confidence multiplier → effective max confidence = 7.5% × 50 = essentially unlimited. Off-season oracle quality is unpredictable. |
| **Funding** | | | | |
| Funding Period | `amm.funding_period` | 3600 (1h) | **14400 (4h)** | Very long period. Off-season prices barely move; frequent funding settlements would just be noise. 4 hours reduces operational overhead and gas. |
| **AMM Spread** | | | | |
| Base Spread | `amm.base_spread` | varies | **400 (4%)** | Wide spread reflects low liquidity and oracle uncertainty. |
| Max Spread | `amm.max_spread` | varies | **5000 (50%)** | Very wide max to handle rare but large price moves from transfer news. |
| Curve Update Intensity | `amm.curve_update_intensity` | varies | **50** | Conservative repricing. Don't overreact to sparse price updates. |

### 4.4 Experimental / New Index

**When to use:** Newly launched index with unproven oracle. Maximum tolerance. Use temporarily while validating oracle quality, then migrate to Standard.

| Category | Parameter | Drift Default | Experimental Value | Rationale |
|---|---|---|---|---|
| **Global Guard Rails** | | | | |
| Price Divergence | `mark_oracle_percent_divergence` | 100,000 (10%) | **250,000 (25%)** | Maximum tolerance for mark-oracle divergence during early calibration. |
| Price Divergence | `oracle_twap_5min_percent_divergence` | 500,000 (50%) | **750,000 (75%)** | Wider than default. New oracles may have bugs causing sudden corrections. |
| Validity | `slots_before_stale_for_amm` | 10 (~5s) | **75 (~37s)** | Same — structural requirement. |
| Validity | `slots_before_stale_for_margin` | 120 (~60s) | **6000 (~50 min)** | Extremely generous. Prevents margin freezes during oracle teething issues. |
| Validity | `confidence_interval_max_size` | 20,000 (2%) | **100,000 (10%)** | Very wide. New oracle may report high uncertainty initially. |
| Validity | `too_volatile_ratio` | 5 (5x) | **20 (20x)** | Maximum tolerance. Prevents `TooVolatile` rejections during oracle calibration. |
| **Per-Market Overrides** | | | | |
| Slot Delay | `oracle_slot_delay_override` | -1 | **0** | Disable immediate speed bump. |
| Slot Delay | `oracle_low_risk_slot_delay_override` | 0 | **120 (~60s)** | Very generous — nearly double the oracle cadence to handle startup jitter. |
| **Per-Market Tier** | | | | |
| Contract Tier | `contract_tier` | A | **HighlySpeculative** | 50x confidence multiplier. Maximum tolerance. |
| **Funding** | | | | |
| Funding Period | `amm.funding_period` | 3600 (1h) | **14400 (4h)** | Long period minimizes the impact of early oracle noise on funding rates. |
| **AMM Spread** | | | | |
| Base Spread | `amm.base_spread` | varies | **500 (5%)** | Very wide base spread. Takers pay a premium for the risk of trading against an unproven oracle. |
| Max Spread | `amm.max_spread` | varies | **5000 (50%)** | Same as Off-Season. |
| Curve Update Intensity | `amm.curve_update_intensity` | varies | **25** | Very conservative. Don't let an unproven oracle aggressively reprice the AMM. |

---

## 5. Comparison Table

All values are the **effective** values after applying precision.

| Parameter | Drift Default | Match Day | Standard | Off-Season | Experimental |
|---|---|---|---|---|---|
| **Global Guard Rails** | | | | | |
| Mark-Oracle Divergence | 10% | 15% | 15% | 20% | 25% |
| Oracle TWAP 5min Divergence | 50% | 50% | 50% | 50% | 75% |
| Slots Before Stale (AMM) | 10 (~5s) | 75 (~37s) | 75 (~37s) | 75 (~37s) | 75 (~37s) |
| Slots Before Stale (Margin) | 120 (~60s) | 600 (~5m) | 1200 (~10m) | 3000 (~25m) | 6000 (~50m) |
| Confidence Max Size | 2% | 5% | 5% | 7.5% | 10% |
| Too Volatile Ratio | 5x | 10x | 10x | 15x | 20x |
| **Per-Market** | | | | | |
| Oracle Slot Delay Override | -1 | 0 | 0 | 0 | 0 |
| Low-Risk Slot Delay Override | 0 (→10) | 75 | 75 | 100 | 120 |
| Contract Tier | A (1x) | Speculative (10x) | Speculative (10x) | HighlySpec (50x) | HighlySpec (50x) |
| **Funding** | | | | | |
| Funding Period | 1h | 1h | 2h | 4h | 4h |
| **AMM Spread** | | | | | |
| Base Spread | varies | 2% | 2.5% | 4% | 5% |
| Max Spread | varies | 20% | 25% | 50% | 50% |
| Curve Update Intensity | varies | 100 | 75 | 50 | 25 |

---

## 6. How to Apply Presets via SDK

### 6.1 Update Global Oracle Guard Rails

This is a **global** setting. Changing it affects all markets. If you run multiple market types (e.g., soccer + crypto), you may need to find a middle ground or rely on per-market overrides.

```typescript
import { BN } from '@coral-xyz/anchor';
import { AdminClient, OracleGuardRails } from '@drift-labs/sdk';

// Example: Standard preset
const standardGuardRails: OracleGuardRails = {
  priceDivergence: {
    markOraclePercentDivergence: new BN(150_000),       // 15%
    oracleTwap5MinPercentDivergence: new BN(500_000),   // 50%
  },
  validity: {
    slotsBeforeStaleForAmm: new BN(75),                 // ~37 seconds
    slotsBeforeStaleForMargin: new BN(1200),             // ~10 minutes
    confidenceIntervalMaxSize: new BN(50_000),           // 5%
    tooVolatileRatio: new BN(10),                        // 10x
  },
};

const txSig = await adminClient.updateOracleGuardRails(standardGuardRails);
console.log('Updated oracle guard rails:', txSig);
```

### 6.2 Update Per-Market Oracle Slot Delay Overrides

These override the global `slots_before_stale_for_amm` for a specific market. Use these when you have both crypto and soccer markets.

```typescript
const MARKET_INDEX = 0; // e.g., SOL-PERP or your soccer index market

// Disable immediate staleness speed bump (set to 0)
await adminClient.updatePerpMarketOracleSlotDelayOverride(
  MARKET_INDEX,
  0  // 0 = never stale for immediate fills
);

// Set low-risk staleness to 75 slots (~37 seconds)
await adminClient.updatePerpMarketOracleLowRiskSlotDelayOverride(
  MARKET_INDEX,
  75
);
```

### 6.3 Update Contract Tier

```typescript
import { ContractTier } from '@drift-labs/sdk';

const MARKET_INDEX = 0;

await adminClient.updatePerpMarketContractTier(
  MARKET_INDEX,
  ContractTier.SPECULATIVE  // 10x confidence multiplier
);
```

### 6.4 Update Funding Period

The `updatePerpMarketFundingPeriod` instruction exists in the program IDL but has no dedicated wrapper in `adminClient.ts`. Call it via the program instruction builder:

```typescript
import { getPerpMarketPublicKey } from '@drift-labs/sdk';

const MARKET_INDEX = 0;
const FUNDING_PERIOD = new BN(7200); // 2 hours in seconds

const ix = await adminClient.program.instruction.updatePerpMarketFundingPeriod(
  FUNDING_PERIOD,
  {
    accounts: {
      admin: adminClient.wallet.publicKey,
      state: await adminClient.getStatePublicKey(),
      perpMarket: await getPerpMarketPublicKey(
        adminClient.program.programId,
        MARKET_INDEX
      ),
    },
  }
);

const tx = await adminClient.buildTransaction(ix);
const { txSig } = await adminClient.sendTransaction(tx, [], adminClient.opts);
console.log('Updated funding period:', txSig);
```

### 6.5 Update AMM Spread Parameters

```typescript
const MARKET_INDEX = 0;

// Base spread: 250 = 2.5% (in BID_ASK_SPREAD_PRECISION / 10000 units)
await adminClient.updatePerpMarketBaseSpread(MARKET_INDEX, 250);

// Max spread: 2500 = 25%
await adminClient.updatePerpMarketMaxSpread(MARKET_INDEX, 2500);

// Curve update intensity: 0-100
await adminClient.updatePerpMarketCurveUpdateIntensity(MARKET_INDEX, 75);

// Manual spread adjustment (if needed)
await adminClient.updatePerpMarketAmmSpreadAdjustment(
  MARKET_INDEX,
  50,   // ammSpreadAdjustment
  25,   // ammInventorySpreadAdjustment
  0     // referencePriceOffset
);
```

### 6.6 Full Preset Application Script (Standard)

```typescript
import { BN } from '@coral-xyz/anchor';
import {
  AdminClient,
  ContractTier,
  OracleGuardRails,
  getPerpMarketPublicKey,
} from '@drift-labs/sdk';

async function applyStandardPreset(
  adminClient: AdminClient,
  marketIndex: number
) {
  // 1. Global oracle guard rails (affects ALL markets)
  const guardRails: OracleGuardRails = {
    priceDivergence: {
      markOraclePercentDivergence: new BN(150_000),
      oracleTwap5MinPercentDivergence: new BN(500_000),
    },
    validity: {
      slotsBeforeStaleForAmm: new BN(75),
      slotsBeforeStaleForMargin: new BN(1200),
      confidenceIntervalMaxSize: new BN(50_000),
      tooVolatileRatio: new BN(10),
    },
  };
  await adminClient.updateOracleGuardRails(guardRails);

  // 2. Per-market slot delay overrides
  await adminClient.updatePerpMarketOracleSlotDelayOverride(marketIndex, 0);
  await adminClient.updatePerpMarketOracleLowRiskSlotDelayOverride(marketIndex, 75);

  // 3. Contract tier
  await adminClient.updatePerpMarketContractTier(
    marketIndex,
    ContractTier.SPECULATIVE
  );

  // 4. Funding period (2 hours)
  const fundingIx = await adminClient.program.instruction.updatePerpMarketFundingPeriod(
    new BN(7200),
    {
      accounts: {
        admin: adminClient.wallet.publicKey,
        state: await adminClient.getStatePublicKey(),
        perpMarket: await getPerpMarketPublicKey(
          adminClient.program.programId,
          marketIndex
        ),
      },
    }
  );
  const fundingTx = await adminClient.buildTransaction(fundingIx);
  await adminClient.sendTransaction(fundingTx, [], adminClient.opts);

  // 5. AMM spread parameters
  await adminClient.updatePerpMarketBaseSpread(marketIndex, 250);
  await adminClient.updatePerpMarketMaxSpread(marketIndex, 2500);
  await adminClient.updatePerpMarketCurveUpdateIntensity(marketIndex, 75);

  console.log(`Standard preset applied to market ${marketIndex}`);
}
```

---

## 7. Risk Considerations

### 7.1 Global vs. Per-Market Tension

`OracleGuardRails` is a **global** setting. If you also run crypto perp markets with sub-second Pyth oracles, raising `slots_before_stale_for_amm` to 75 would loosen staleness checks for those markets too. **Mitigation:** Use per-market `oracle_low_risk_slot_delay_override` for soccer markets and keep globals tighter, or run soccer indices on a separate program deployment.

### 7.2 Slot Delay Override Limits

Both `oracle_slot_delay_override` and `oracle_low_risk_slot_delay_override` are `i8` fields — **max value 127** (~63 seconds). This is sufficient for a 30-second oracle but leaves no room if oracle cadence needs to slow to 60+ seconds. If you anticipate slower oracles, you must rely on the global `slots_before_stale_for_amm` (which is `i64`) instead.

### 7.3 Wider Confidence = Wider Effective Spread

When `confidence_interval_max_size` is raised and the oracle reports high confidence values, the AMM automatically widens its spread to account for uncertainty. This is working as designed but means **takers pay more** during uncertain periods.

### 7.4 Longer Funding Periods Reduce Capital Efficiency

A 4-hour funding period means mark-oracle divergence persists longer before being corrected by funding payments. This can attract basis traders but also means positions that should be funding-expensive are cheaper to hold, potentially leading to larger open interest imbalances.

### 7.5 `TooVolatile` Ratio and Oracle TWAP Lag

The `too_volatile_ratio` compares current price to `last_oracle_price_twap`. If the TWAP hasn't been updated recently (no trades, no cranking), a legitimate price move could hit the `TooVolatile` threshold. **Mitigation:** Ensure the keeper bot calls `updatePerpMarketAmmOracleTwap` regularly, especially around match times.

### 7.6 Stale Oracle During Matches = Maximum Risk

If the oracle goes down during an active match, the AMM will freeze (fills blocked). But existing positions remain open and unfunded. A keeper should monitor oracle liveness and alert operators immediately if `last_oracle_delay` exceeds `2 × expected_cadence`.

### 7.7 Experimental Preset: Time-Box It

The Experimental preset (`HighlySpeculative` tier, 20x volatility ratio, 50-minute margin staleness) is intentionally permissive. It should be used only during the first 1-2 weeks of a new index launch, then migrated to Standard. Running in Experimental long-term exposes the protocol to:
- Oracle manipulation (wide confidence tolerance)
- Stale-price exploitation (long margin staleness window)
- Excessive funding noise (if combined with short funding periods)

### 7.8 The 33% TWAP Clamp

`DEFAULT_MAX_TWAP_UPDATE_PRICE_BAND_DENOMINATOR = 3` means each new oracle data point can only move the TWAP by ±33% from its current value. For soccer indices, a single goal might move the index 5-10%, well within this band. But a series of rapid goals (e.g., 5-0 scoreline) could cause the TWAP to lag the true price by multiple update cycles. This is generally protective (prevents oracle manipulation) but can cause temporary mark-oracle divergence.

---

## Appendix: Precision Constants

| Constant | Value | Used For |
|---|---|---|
| `PRICE_PRECISION` | 1,000,000 (1e6) | Oracle prices, AMM prices |
| `PERCENTAGE_PRECISION` | 1,000,000 (1e6) | Percentages in guard rails |
| `BID_ASK_SPREAD_PRECISION` | 1,000,000 (1e6) | Spread and confidence values |
| `FUNDING_RATE_PRECISION` | 1,000,000,000 (1e9) | Funding rate values |
| `QUOTE_PRECISION` | 1,000,000 (1e6) | Quote asset (USDC) amounts |
| `MARGIN_PRECISION` | 10,000 (1e4) | Margin ratios, IMF factors |
