# Drift Protocol v2 — Comprehensive Parameter Configuration Reference

> Operational reference for configuring and launching a Drift Protocol v2 fork DEX.
> Cross-references: [ORACLE-PRESETS.md](./ORACLE-PRESETS.md)

---

## Table of Contents

1. [Precision Constants](#1-precision-constants)
2. [Global State Parameters](#2-global-state-parameters)
3. [Perp Market Parameters](#3-perp-market-parameters)
4. [AMM Parameters](#4-amm-parameters)
5. [Spot Market Parameters](#5-spot-market-parameters)
6. [SDK Admin Function Quick Reference](#6-sdk-admin-function-quick-reference)

---

## 1. Precision Constants

All on-chain values are stored as integers. Divide by the precision constant to get human-readable values.

| Constant | Value | Exponent | Usage |
|---|---|---|---|
| `PRICE_PRECISION` | 1,000,000 | 10^-6 | Oracle prices, mark prices, peg multiplier |
| `BASE_PRECISION` / `AMM_RESERVE_PRECISION` | 1,000,000,000 | 10^-9 | Base asset amounts, AMM reserves, sqrt_k |
| `QUOTE_PRECISION` | 1,000,000 | 10^-6 | Quote amounts (USDC), fees, PnL |
| `PEG_PRECISION` | 1,000,000 | 10^-6 | AMM peg multiplier |
| `MARGIN_PRECISION` | 10,000 | 10^-4 | Margin ratios (e.g., 1000 = 10%) |
| `SPOT_WEIGHT_PRECISION` | 10,000 | 10^-4 | Asset/liability weights (e.g., 8000 = 0.8) |
| `PERCENTAGE_PRECISION` | 1,000,000 | 10^-6 | Generic percentages (1,000,000 = 100%) |
| `BID_ASK_SPREAD_PRECISION` | 1,000,000 | 10^-6 | AMM spread values |
| `FUNDING_RATE_PRECISION` | 1,000,000,000 | 10^-9 | Funding rates (PRICE * BUFFER) |
| `FUNDING_RATE_BUFFER` | 1,000 | 10^-3 | Funding rate scaling buffer |
| `SPOT_BALANCE_PRECISION` | 1,000,000,000 | 10^-9 | Scaled spot balances |
| `SPOT_CUMULATIVE_INTEREST_PRECISION` | 10,000,000,000 | 10^-10 | Cumulative interest tracking |
| `SPOT_UTILIZATION_PRECISION` | 1,000,000 | 10^-6 | Utilization ratios |
| `SPOT_RATE_PRECISION` | 1,000,000 | 10^-6 | Interest rate values |
| `LIQUIDATION_FEE_PRECISION` | 1,000,000 | 10^-6 | Liquidation fee values |
| `LIQUIDATION_PCT_PRECISION` | 10,000 | 10^-4 | Liquidation percentage |
| `CONCENTRATION_PRECISION` | 1,000,000 | 10^-6 | AMM concentration coefficient |
| `IF_FACTOR_PRECISION` | 1,000,000 | 10^-6 | Insurance fund factors |

### Key Conversion Ratios

| Ratio | Value | Meaning |
|---|---|---|
| `AMM_TO_QUOTE_PRECISION_RATIO` | 1,000 | BASE (10^9) / QUOTE (10^6) |
| `PRICE_TO_PEG_PRECISION_RATIO` | 1 | Both are 10^6 |
| `LIQUIDATION_FEE_TO_MARGIN_PRECISION_RATIO` | 100 | LIQ_FEE (10^6) / MARGIN (10^4) |
| `FEE_DENOMINATOR` | 100,000 | Fee tier denominator (10 * 10,000) |
| `FEE_PERCENTAGE_DENOMINATOR` | 100 | Referrer/referee fee denominator |

### Important Limits

| Constant | Value | Human |
|---|---|---|
| `MAX_MARGIN_RATIO` | 10,000 | 1x leverage |
| `MIN_MARGIN_RATIO` | 125 | 80x leverage |
| `HIGH_LEVERAGE_MIN_MARGIN_RATIO` | 50 | 200x leverage |
| `MAX_CONCENTRATION_COEFFICIENT` | 1,414,200 | ~1.41x (√2) |
| `MAX_SQRT_K` | 10^21 | Max AMM liquidity depth |
| `FEE_ADJUSTMENT_MAX` | 100 | ±100% fee adjustment |
| `MAX_OPEN_ORDERS` | 32 | Per user |
| `MAX_PERP_POSITIONS` | 8 | Per user |
| `MAX_SPOT_POSITIONS` | 8 | Per user |

---

## 2. Global State Parameters

Stored in the `State` account (PDA). Updated via admin instructions on `AdminClient`.

### Admin & Infrastructure

| Rust Field | SDK Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|---|
| `admin` | `admin` | `Pubkey` | (set at init) | Admin authority for all config changes | `updateAdmin(admin)` |
| `signer` | `signer` | `Pubkey` | (PDA) | Program signer PDA — derived, not configurable | — |
| `signer_nonce` | `signerNonce` | `u8` | (PDA) | PDA bump seed — derived, not configurable | — |
| `whitelist_mint` | `whitelistMint` | `Pubkey` | `Pubkey::default()` | Token mint required to create accounts (0 = disabled) | `updateWhitelistMint(mint?)` |
| `discount_mint` | `discountMint` | `Pubkey` | `Pubkey::default()` | Token mint for fee discounts (0 = disabled) | `updateDiscountMint(mint)` |
| `srm_vault` | `srmVault` | `Pubkey` | `Pubkey::default()` | Serum vault address (legacy) | `updateSerumVault(vault)` |
| `exchange_status` | `exchangeStatus` | `u8` | `0` (Active) | Bitmask of paused exchange operations | `updateExchangeStatus(status)` |
| `number_of_markets` | `numberOfMarkets` | `u16` | 0 | Counter — auto-incremented on market init | — |
| `number_of_spot_markets` | `numberOfSpotMarkets` | `u16` | 0 | Counter — auto-incremented on market init | — |
| `number_of_authorities` | `numberOfAuthorities` | `u64` | 0 | Counter — auto-incremented | — |
| `number_of_sub_accounts` | `numberOfSubAccounts` | `u64` | 0 | Counter — auto-incremented | — |

#### Exchange Status Bit Flags

| Flag | Bit | Effect |
|---|---|---|
| Active | `0b00000000` | All operations enabled |
| `DepositPaused` | `0b00000001` | Deposits disabled |
| `WithdrawPaused` | `0b00000010` | Withdrawals disabled |
| `AmmPaused` | `0b00000100` | AMM trading disabled |
| `FillPaused` | `0b00001000` | Order fills disabled |
| `LiqPaused` | `0b00010000` | Liquidations disabled |
| `FundingPaused` | `0b00100000` | Funding rate updates disabled |
| `SettlePnlPaused` | `0b01000000` | PnL settlement disabled |
| `AmmImmediateFillPaused` | `0b10000000` | AMM immediate fills disabled |

### Feature Bit Flags

| Rust Field | SDK Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|---|
| `feature_bit_flags` | `featureBitFlags` | `u8` | `0` | Enables optional features (see below) | `updateFeatureBitFlags*()` |
| `lp_pool_feature_bit_flags` | `lpPoolFeatureBitFlags` | `u8` | `0` | LP pool feature flags | `updateFeatureBitFlags*LpPool()` |

| Feature Flag | Bit | SDK Function |
|---|---|---|
| `MmOracleUpdate` | `0b00000001` | `updateFeatureBitFlagsMMOracle()` |
| `MedianTriggerPrice` | `0b00000010` | `updateFeatureBitFlagsMedianTriggerPrice()` |
| `BuilderCodes` | `0b00000100` | `updateFeatureBitFlagsBuilderCodes()` |
| `BuilderReferral` | `0b00001000` | `updateFeatureBitFlagsBuilderReferral()` |
| `SettleLpPool` | `0b00000001` (LP) | `updateFeatureBitFlagsSettleLpPool()` |
| `SwapLpPool` | `0b00000010` (LP) | `updateFeatureBitFlagsSwapLpPool()` |
| `MintRedeemLpPool` | `0b00000100` (LP) | `updateFeatureBitFlagsMintRedeemLpPool()` |

### Oracle Guard Rails

See [ORACLE-PRESETS.md](./ORACLE-PRESETS.md) for recommended configurations.

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `oracle_guard_rails.price_divergence.mark_oracle_percent_divergence` | `u64` | `100,000` (10%) | Max mark-oracle price divergence before AMM is paused | `updateOracleGuardRails(rails)` |
| `oracle_guard_rails.price_divergence.oracle_twap_5min_percent_divergence` | `u64` | `500,000` (50%) | Max oracle 5min TWAP divergence | `updateOracleGuardRails(rails)` |
| `oracle_guard_rails.validity.slots_before_stale_for_amm` | `i64` | `10` (~5s) | Oracle slots before stale for AMM fills | `updateOracleGuardRails(rails)` |
| `oracle_guard_rails.validity.slots_before_stale_for_margin` | `i64` | `120` (~60s) | Oracle slots before stale for margin calcs | `updateOracleGuardRails(rails)` |
| `oracle_guard_rails.validity.confidence_interval_max_size` | `u64` | `20,000` (2%) | Max oracle confidence as % of price | `updateOracleGuardRails(rails)` |
| `oracle_guard_rails.validity.too_volatile_ratio` | `i64` | `5` | Max oracle/twap ratio (5x = 80% drop) | `updateOracleGuardRails(rails)` |

### Fee Structure

Both `perp_fee_structure` and `spot_fee_structure` share the same schema.

| Rust Field | Type | Description | SDK Function |
|---|---|---|---|
| `fee_tiers[0..9]` | `FeeTier[10]` | Tiered fee schedule (see below) | `updatePerpFeeStructure(fs)` / `updateSpotFeeStructure(fs)` |
| `filler_reward_structure.reward_numerator` | `u32` | Filler reward as % of fee (default 10) | (part of FeeStructure) |
| `filler_reward_structure.reward_denominator` | `u32` | Denominator (default 100) | (part of FeeStructure) |
| `filler_reward_structure.time_based_reward_lower_bound` | `u128` | Min filler reward (default 10,000 = $0.01) | (part of FeeStructure) |
| `flat_filler_fee` | `u64` | Flat filler fee in QUOTE (default 10,000 = $0.01) | (part of FeeStructure) |
| `referrer_reward_epoch_upper_bound` | `u64` | Max referrer reward per epoch (default $150,000) | (part of FeeStructure) |

#### Default Perp Fee Tiers

| Tier | Taker Fee | Maker Rebate | Referrer Reward | Referee Discount |
|---|---|---|---|---|
| 0 | 5.0 bps | -2.0 bps | 15% of taker fee | 5% |
| 1 | 4.5 bps | -2.0 bps | 15% | 5% |
| 2 | 4.0 bps | -2.0 bps | 15% | 5% |
| 3 | 3.5 bps | -2.0 bps | 15% | 5% |
| 4 | 3.0 bps | -2.0 bps | 15% | 5% |
| 5 | 2.5 bps | -2.0 bps | 15% | 5% |

#### Default Spot Fee Tiers

| Tier | Taker Fee | Maker Rebate | Referrer | Referee |
|---|---|---|---|---|
| 0 | 5.0 bps | -2.0 bps | 0% | 0% |

### Liquidation

| Rust Field | SDK Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|---|
| `liquidation_margin_buffer_ratio` | `liquidationMarginBufferRatio` | `u32` | `200` (2%) | Buffer above maintenance margin before liquidation starts. Precision: MARGIN_PRECISION | `updateLiquidationMarginBufferRatio(ratio)` |
| `liquidation_duration` | `liquidationDuration` | `u8` | `0` | Number of slots over which liquidation is spread (0 = instant) | `updateLiquidationDuration(duration)` |
| `initial_pct_to_liquidate` | `initialPctToLiquidate` | `u16` | `0` | Initial % of position to liquidate. Precision: LIQUIDATION_PCT_PRECISION. 0 = full liquidation | `updateInitialPctToLiquidate(pct)` |

### Auction & Settlement

| Rust Field | SDK Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|---|
| `min_perp_auction_duration` | `minPerpAuctionDuration` | `u8` | `0` | Min slots for perp order auction before fill | `updatePerpAuctionDuration(min)` |
| `default_spot_auction_duration` | `defaultSpotAuctionDuration` | `u8` | `0` | Default slots for spot order auction | `updateSpotAuctionDuration(duration)` |
| `default_market_order_time_in_force` | `defaultMarketOrderTimeInForce` | `u8` | `0` | Default TIF for market orders (slots) | — |
| `settlement_duration` | `settlementDuration` | `u16` | `0` | Duration for settlement operations (slots) | `updateStateSettlementDuration(duration)` |

### Account Limits

| Rust Field | SDK Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|---|
| `max_number_of_sub_accounts` | `maxNumberOfSubAccounts` | `u16` | `0` | Max sub-accounts (if >5, multiplied by 100) | `updateStateMaxNumberOfSubAccounts(max)` |
| `max_initialize_user_fee` | `maxInitializeUserFee` | `u16` | `0` | Max fee for account init (SOL/100 units). Scales with utilization above 80%. | `updateStateMaxInitializeUserFee(fee)` |
| `lp_cooldown_time` | `lpCooldownTime` | `u64` | `0` | Cooldown time (seconds) before LP can withdraw | `updateLpCooldownTime(time)` |

---

## 3. Perp Market Parameters

Stored in `PerpMarket` accounts (one per market). Set during `initializePerpMarket` and modifiable via update instructions.

### Identity & Status

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `name` | `[u8; 32]` | `[0; 32]` | UTF-8 encoded market name (e.g., "SOL-PERP") | `updatePerpMarketName(idx, name)` |
| `market_index` | `u16` | (set at init) | Unique market identifier | — |
| `status` | `MarketStatus` | `Initialized` | Market lifecycle state | `updatePerpMarketStatus(idx, status)` |
| `contract_type` | `ContractType` | `Perpetual` | `Perpetual`, `Future`, or `Prediction` | (set at init) |
| `contract_tier` | `ContractTier` | `HighlySpeculative` | Risk tier — affects insurance, liquidation priority, oracle tolerance | `updatePerpMarketContractTier(idx, tier)` |
| `expiry_ts` | `i64` | `0` | Unix timestamp when market expires (0 = no expiry) | `updatePerpMarketExpiry(idx, ts)` |
| `expiry_price` | `i64` | `0` | Settlement price. Precision: PRICE_PRECISION. Set when entering Settlement status. | — |
| `quote_spot_market_index` | `u16` | `0` | Spot market index for PnL settlement (typically USDC = 0) | — |
| `pool_id` | `u8` | `0` | Pool grouping identifier | — |
| `lp_pool_id` | `u8` | `0` | LP pool grouping identifier | `updatePerpMarketLpPoolId(idx, id)` |

#### MarketStatus Values

| Status | Description |
|---|---|
| `Initialized` | Warm-up period; fills paused |
| `Active` | All operations allowed |
| `ReduceOnly` | Only position-reducing fills |
| `Settlement` | Positions must be settled at `expiry_price` |
| `Delisted` | No remaining participants |

#### ContractTier Values

| Tier | Insurance Cap | Confidence Multiplier | Notes |
|---|---|---|---|
| `A` | $100M | 1x (2%) | Safest; liquidated first |
| `B` | $1M | 1x (2%) | |
| `C` | $100K | 2x (4%) | |
| `Speculative` | $0 | 10x (20%) | |
| `HighlySpeculative` | $0 | 50x (100%) | Default |
| `Isolated` | $0 | 50x (100%) | Single position only |

### Margin & Risk

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `margin_ratio_initial` | `u32` | `0` | Initial margin ratio. Precision: MARGIN_PRECISION. E.g., 1000 = 10% = 10x leverage. | `updatePerpMarketMarginRatio(idx, init, maint)` |
| `margin_ratio_maintenance` | `u32` | `0` | Maintenance margin ratio. E.g., 500 = 5% = 20x leverage. | `updatePerpMarketMarginRatio(idx, init, maint)` |
| `high_leverage_margin_ratio_initial` | `u16` | `0` | High-leverage mode initial margin (0 = disabled). Enables up to 200x. | `updatePerpMarketHighLeverageMarginRatio(idx, init, maint)` |
| `high_leverage_margin_ratio_maintenance` | `u16` | `0` | High-leverage mode maintenance margin. | `updatePerpMarketHighLeverageMarginRatio(idx, init, maint)` |
| `imf_factor` | `u32` | `0` | Initial margin fraction factor. Increases margin for large positions. Precision: MARGIN_PRECISION. Typical: 1000-3000. | `updatePerpMarketImfFactor(idx, imf, upnlImf)` |
| `unrealized_pnl_initial_asset_weight` | `u32` | `0` | Asset weight for positive unrealized PnL (initial). Precision: SPOT_WEIGHT_PRECISION. | `updatePerpMarketUnrealizedAssetWeight(idx, init, maint)` |
| `unrealized_pnl_maintenance_asset_weight` | `u32` | `0` | Asset weight for positive unrealized PnL (maintenance). | `updatePerpMarketUnrealizedAssetWeight(idx, init, maint)` |
| `unrealized_pnl_imf_factor` | `u32` | `0` | IMF factor for discounting unrealized PnL asset weight for large positions. | `updatePerpMarketImfFactor(idx, imf, upnlImf)` |
| `unrealized_pnl_max_imbalance` | `u64` | `0` | Max net PnL imbalance before positive PnL is discounted. Precision: QUOTE_PRECISION. | `updatePerpMarketMaxImbalances(idx, maxImbalance, maxRevWithdraw, maxInsurance)` |

### Liquidation

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `liquidator_fee` | `u32` | `0` | Fee paid to liquidator. Precision: LIQUIDATION_FEE_PRECISION. E.g., 10000 = 1%. | `updatePerpMarketLiquidationFee(idx, liqFee, ifFee)` |
| `if_liquidation_fee` | `u32` | `0` | Fee to insurance fund from liquidation. Precision: LIQUIDATION_FEE_PRECISION. | `updatePerpMarketLiquidationFee(idx, liqFee, ifFee)` |

### Insurance Claim

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `insurance_claim.max_revenue_withdraw_per_period` | `u64` | `0` | Max revenue that can flow out of market per period. Precision: QUOTE_PRECISION. | `updatePerpMarketMaxImbalances(idx, maxImbalance, maxRevWithdraw, maxInsurance)` |
| `insurance_claim.quote_max_insurance` | `u64` | `0` | Max insurance payout for this market. Precision: QUOTE_PRECISION. | `updatePerpMarketMaxImbalances(idx, maxImbalance, maxRevWithdraw, maxInsurance)` |

### Fees & Incentives

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `fee_adjustment` | `i16` | `0` | Scales market fees by -100 to +100 %. E.g., -50 = halve fees, +50 = 1.5x fees. | `updatePerpMarketFeeAdjustment(idx, adj)` |
| `fuel_boost_position` | `u8` | `0` | Fuel multiplier for holding positions. Precision: /10. | `updatePerpMarketFuel(idx, taker?, maker?, position?)` |
| `fuel_boost_taker` | `u8` | `0` | Fuel multiplier for taker volume. Precision: /10. | `updatePerpMarketFuel(idx, taker?, maker?, position?)` |
| `fuel_boost_maker` | `u8` | `0` | Fuel multiplier for maker volume. Precision: /10. | `updatePerpMarketFuel(idx, taker?, maker?, position?)` |

### Operations

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `paused_operations` | `u8` | `0` | Bitmask of paused perp operations (see below) | `updatePerpMarketPausedOperations(idx, ops)` |
| `lp_status` | `u8` | `0` (Uncollateralized) | LP pool status: Uncollateralized, Active, Decommissioning | `updatePerpMarketLpPoolStatus(idx, status)` |
| `lp_paused_operations` | `u8` | `0` | Bitmask of paused LP operations | `updatePerpMarketLpPoolPausedOperations(idx, ops)` |
| `lp_fee_transfer_scalar` | `u8` | `0` | Scalar for LP fee transfers | `updatePerpMarketLpPoolFeeTransferScalar(idx, scalar)` |
| `lp_exchange_fee_excluscion_scalar` | `u8` | `0` | Scalar for LP exchange fee exclusion | — |

#### PerpOperation Bit Flags

| Operation | Bit | Effect when set |
|---|---|---|
| `UpdateFunding` | `0b00000001` | Funding updates paused |
| `AmmFill` | `0b00000010` | AMM fills paused |
| `Fill` | `0b00000100` | All fills paused |
| `SettlePnl` | `0b00001000` | PnL settlement paused |
| `SettlePnlWithPosition` | `0b00010000` | Position-based PnL settlement paused |
| `Liquidation` | `0b00100000` | Liquidations paused |
| `AmmImmediateFill` | `0b01000000` | Immediate AMM fills paused |
| `SettleRevPool` | `0b10000000` | Revenue pool settlement paused |

### Protected Maker Mode

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `protected_maker_limit_price_divisor` | `u8` | `0` | Divisor for protected maker limit price offset (0 = disabled) | `updatePerpMarketProtectedMakerParams(idx, limitDiv?, dynamicDiv?)` |
| `protected_maker_dynamic_divisor` | `u8` | `0` | Divisor applied to oracle_std/mark_std for dynamic offset | `updatePerpMarketProtectedMakerParams(idx, limitDiv?, dynamicDiv?)` |

---

## 4. AMM Parameters

Nested within `PerpMarket.amm`. These control the virtual AMM pricing, spreads, funding, and order sizing.

### Oracle

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `oracle` | `Pubkey` | `Pubkey::default()` | Oracle account public key | `updatePerpMarketOracle(idx, oracle, source)` |
| `oracle_source` | `OracleSource` | `QuoteAsset` | Oracle provider/type (Pyth, PythPull, Switchboard, etc.) | `updatePerpMarketOracle(idx, oracle, source)` |
| `oracle_slot_delay_override` | `i8` | `-1` | Override state-level slot delay for this market. -1 = use state default. | `updatePerpMarketOracleSlotDelayOverride(idx, delay)` |
| `oracle_low_risk_slot_delay_override` | `i8` | `0` | Override for low-risk fill slot delay. 0 = no override, -1 = disable speed bump. | `updatePerpMarketOracleLowRiskSlotDelayOverride(idx, delay)` |

> See [ORACLE-PRESETS.md](./ORACLE-PRESETS.md) for oracle configuration details.

### Reserves & Pricing

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `base_asset_reserve` | `u128` | `0` | Current `x` reserves for x*y=k. Precision: AMM_RESERVE_PRECISION. | (set at init / `moveAmmPrice`) |
| `quote_asset_reserve` | `u128` | `0` | Current `y` reserves for x*y=k. Precision: AMM_RESERVE_PRECISION. | (set at init / `moveAmmPrice`) |
| `sqrt_k` | `u128` | `0` | Square root of k (liquidity depth). Precision: AMM_RESERVE_PRECISION. | `updateK(idx, sqrtK)` |
| `peg_multiplier` | `u128` | `0` | Normalizing factor for quote reserves. Precision: PEG_PRECISION. | (set at init / `moveAmmPrice`) |
| `concentration_coef` | `u128` | `0` | Controls slippage curve concentration. Precision: PERCENTAGE_PRECISION. Max: 1,414,200. | `updatePerpMarketConcentrationScale(idx, scale)` |
| `min_base_asset_reserve` | `u128` | `0` | Min base reserves before AMM unavailable. Derived from concentration_coef. | — |
| `max_base_asset_reserve` | `u128` | `0` | Max base reserves before AMM unavailable. Derived from concentration_coef. | — |
| `terminal_quote_asset_reserve` | `u128` | `0` | Quote reserves when market is balanced. | — |

### Spreads

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `base_spread` | `u32` | `0` | Minimum AMM spread (bid/ask). Precision: BID_ASK_SPREAD_PRECISION. E.g., 1000 = 0.1% = 10 bps. | `updatePerpMarketBaseSpread(idx, spread)` |
| `max_spread` | `u32` | `0` | Maximum AMM spread. E.g., 142500 = 14.25%. | `updatePerpMarketMaxSpread(idx, spread)` |
| `long_spread` | `u32` | `0` | Current ask-side spread (dynamic, not directly set). | — |
| `short_spread` | `u32` | `0` | Current bid-side spread (dynamic, not directly set). | — |
| `amm_spread_adjustment` | `i8` | `0` | Signed scale of AMM spread. -100 = 0x, 0 = 1x, +100 = 2x. | `updatePerpMarketAmmSpreadAdjustment(idx, spread, inventory, refOffset)` |
| `amm_inventory_spread_adjustment` | `i8` | `0` | Signed scale of inventory-based spread component. Same scale as above. | `updatePerpMarketAmmSpreadAdjustment(idx, spread, inventory, refOffset)` |
| `reference_price_offset` | `i32` | `0` | Offset applied to reserve price for bid/ask. Precision: BID_ASK_SPREAD_PRECISION. | `updatePerpMarketAmmSpreadAdjustment(idx, spread, inventory, refOffset)` |
| `reference_price_offset_deadband_pct` | `u8` | `0` | Deadband % for reference price offset changes. Value/100 * PERCENTAGE_PRECISION. | `updatePerpMarketReferencePriceOffsetDeadbandPct(idx, pct)` |

### Funding

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `funding_period` | `i64` | `0` | Funding rate update interval in seconds. Typical: 3600 (1 hour). | (set at init as `periodicity`) |
| `last_funding_rate` | `i64` | `0` | Most recent funding rate. Precision: FUNDING_RATE_PRECISION. | — |
| `last_funding_rate_long` | `i64` | `0` | Most recent funding rate for longs. | — |
| `last_funding_rate_short` | `i64` | `0` | Most recent funding rate for shorts. | — |
| `last_24h_avg_funding_rate` | `i64` | `0` | 24h rolling average funding rate. | — |
| `cumulative_funding_rate_long` | `i128` | `0` | Accumulated funding for longs since inception. | — |
| `cumulative_funding_rate_short` | `i128` | `0` | Accumulated funding for shorts since inception. | — |

> See [ORACLE-PRESETS.md](./ORACLE-PRESETS.md) for funding-related oracle params.

### Order Sizing

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `order_step_size` | `u64` | `0` | Min increment for order base amount. Precision: BASE_PRECISION. SDK default: BASE_PRECISION/10000 = 100,000 (0.0001 base). | `updatePerpMarketStepSizeAndTickSize(idx, step, tick)` |
| `order_tick_size` | `u64` | `0` | Min increment for order price. Precision: PRICE_PRECISION. SDK default: PRICE_PRECISION/100000 = 10 ($0.00001). | `updatePerpMarketStepSizeAndTickSize(idx, step, tick)` |
| `min_order_size` | `u64` | `1` | Minimum order size. Precision: BASE_PRECISION. SDK default: BASE_PRECISION/10000 = 100,000 (0.0001 base). | `updatePerpMarketMinOrderSize(idx, size)` |

### Capacity

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `max_open_interest` | `u128` | `0` | Max open interest (one-sided). Precision: BASE_PRECISION. 0 = unlimited. | `updatePerpMarketMaxOpenInterest(idx, maxOI)` |
| `max_fill_reserve_fraction` | `u16` | `0` | Fraction of AMM liquidity a single fill can consume. E.g., 1 = 100%, 2 = 50%. | `updatePerpMarketMaxFillReserveFraction(idx, fraction)` |
| `max_slippage_ratio` | `u16` | `0` | Max slippage allowed per fill. | `updateMaxSlippageRatio(idx, ratio)` |

### Curve Dynamics

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `curve_update_intensity` | `u8` | `0` | How aggressively AMM adjusts k. 0 = no auto-adjust, 1-100 = intensity, 101-200 = enables reference price offset. | `updatePerpMarketCurveUpdateIntensity(idx, intensity)` |
| `amm_jit_intensity` | `u8` | `0` | AMM JIT-making intensity. 0 = disabled. 1-100 = protocol-owned AMM intensity. 101-200 = user LP-owned AMM intensity. | `updateAmmJitIntensity(idx, intensity)` |

### LP Configuration

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `per_lp_base` | `i8` | `0` | Exponent for per-LP share units. Per-LP unit = 10^per_lp_base. | `updatePerpMarketPerLpBase(idx, base)` |
| `target_base_asset_amount_per_lp` | `i32` | `0` | Target base amount per LP share for AMM JIT splitting. Precision: BASE_PRECISION. | `updatePerpMarketTargetBaseAssetAmountPerLp(idx, target)` |
| `user_lp_shares` | `u128` | `0` | Total user LP shares. Precision: AMM_RESERVE_PRECISION. | — |

---

## 5. Spot Market Parameters

Stored in `SpotMarket` accounts (one per market).

### Identity & Status

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `name` | `[u8; 32]` | `[0; 32]` | UTF-8 encoded market name (e.g., "SOL", "USDC") | `updateSpotMarketName(idx, name)` |
| `market_index` | `u16` | (set at init) | Unique market identifier (0 = USDC quote) | — |
| `mint` | `Pubkey` | (set at init) | SPL token mint address | — |
| `vault` | `Pubkey` | (set at init) | Token vault PDA | — |
| `decimals` | `u32` | (set at init) | Token decimals. Precision = 10^decimals. | — |
| `status` | `MarketStatus` | `Initialized` | Market lifecycle state | `updateSpotMarketStatus(idx, status)` |
| `asset_tier` | `AssetTier` | `Unlisted` | Collateral/risk tier | `updateSpotMarketAssetTier(idx, tier)` |
| `orders_enabled` | `bool` | `false` | Whether spot trading is enabled | `updateSpotMarketOrdersEnabled(idx, enabled)` |
| `pool_id` | `u8` | `0` | Pool grouping identifier | `updateSpotMarketPoolId(idx, poolId)` |

#### AssetTier Values

| Tier | Collateral | Borrowable | Multi-Borrow | Notes |
|---|---|---|---|---|
| `Collateral` | Yes | Yes | Yes | Full privilege (USDC, SOL) |
| `Protected` | Yes | No | N/A | Collateral but no borrowing |
| `Cross` | No | Yes | Yes | Borrowable, not collateral |
| `Isolated` | No | Yes | No | Single borrow only |
| `Unlisted` | No | No | No | Default — no privileges |

### Oracle

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `oracle` | `Pubkey` | `Pubkey::default()` | Oracle account public key | `updateSpotMarketOracle(idx, oracle, source)` |
| `oracle_source` | `OracleSource` | `QuoteAsset` | Oracle provider/type | `updateSpotMarketOracle(idx, oracle, source)` |

### Margin Weights

All weights use `SPOT_WEIGHT_PRECISION` (10,000 = 1.0).

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `initial_asset_weight` | `u32` | `0` | Deposit contribution to initial collateral. E.g., 8000 = 0.8 ($100 deposit = $80 collateral). | `updateSpotMarketMarginWeights(idx, ia, ma, il, ml, imf?)` |
| `maintenance_asset_weight` | `u32` | `0` | Deposit contribution to maintenance collateral. E.g., 9000 = 0.9. | `updateSpotMarketMarginWeights(idx, ia, ma, il, ml, imf?)` |
| `initial_liability_weight` | `u32` | `0` | Borrow contribution to initial margin requirement. E.g., 12000 = 1.2. | `updateSpotMarketMarginWeights(idx, ia, ma, il, ml, imf?)` |
| `maintenance_liability_weight` | `u32` | `0` | Borrow contribution to maintenance margin. E.g., 11000 = 1.1. | `updateSpotMarketMarginWeights(idx, ia, ma, il, ml, imf?)` |
| `imf_factor` | `u32` | `0` | Increases liability weight / decreases asset weight for large positions. Precision: MARGIN_PRECISION. | `updateSpotMarketMarginWeights(idx, ia, ma, il, ml, imf?)` |
| `scale_initial_asset_weight_start` | `u64` | `0` | Deposit value above which initial asset weight starts scaling down. Precision: QUOTE_PRECISION. 0 = disabled. | `updateSpotMarketScaleInitialAssetWeightStart(idx, start)` |

### Interest Rates

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `optimal_utilization` | `u32` | `0` | Target utilization rate. Precision: SPOT_UTILIZATION_PRECISION. E.g., 700000 = 70%. | `updateSpotMarketBorrowRate(idx, optUtil, optRate, maxRate, minRate?)` |
| `optimal_borrow_rate` | `u32` | `0` | Borrow rate at optimal utilization. Precision: SPOT_RATE_PRECISION. E.g., 100000 = 10% APR. | `updateSpotMarketBorrowRate(idx, optUtil, optRate, maxRate, minRate?)` |
| `max_borrow_rate` | `u32` | `0` | Borrow rate at 100% utilization. Precision: SPOT_RATE_PRECISION. E.g., 2000000 = 200% APR. | `updateSpotMarketBorrowRate(idx, optUtil, optRate, maxRate, minRate?)` |
| `min_borrow_rate` | `u8` | `0` | Min borrow rate regardless of utilization. Value/200 = rate %. E.g., 1 = 0.5% APR. | `updateSpotMarketBorrowRate(idx, optUtil, optRate, maxRate, minRate?)` |

### Deposit/Borrow Limits

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `max_token_deposits` | `u64` | `0` | Max deposit cap in token units. Precision: token mint. 0 = unlimited. | `updateSpotMarketMaxTokenDeposits(idx, max)` |
| `max_token_borrows_fraction` | `u16` | `0` | Max borrows as fraction of max_token_deposits. Precision: X/10000. 0 = disabled. E.g., 5000 = 50%. | `updateSpotMarketMaxTokenBorrows(idx, fraction)` |
| `withdraw_guard_threshold` | `u64` | `0` | Deposits below this skip withdraw limits. Precision: token mint. | `updateWithdrawGuardThreshold(idx, threshold)` |

### Liquidation

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `liquidator_fee` | `u32` | `0` | Fee to liquidator. Precision: LIQUIDATION_FEE_PRECISION. | `updateSpotMarketLiquidationFee(idx, liqFee, ifFee)` |
| `if_liquidation_fee` | `u32` | `0` | Fee to insurance fund. Precision: LIQUIDATION_FEE_PRECISION. | `updateSpotMarketLiquidationFee(idx, liqFee, ifFee)` |

### Order Sizing

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `order_step_size` | `u64` | `1` | Min order size increment. Precision: token mint. | `updateSpotMarketStepSizeAndTickSize(idx, step, tick)` |
| `order_tick_size` | `u64` | `0` | Min price increment. Precision: PRICE_PRECISION. | `updateSpotMarketStepSizeAndTickSize(idx, step, tick)` |
| `min_order_size` | `u64` | `0` | Minimum order size. Precision: token mint. | `updateSpotMarketMinOrderSize(idx, size)` |
| `max_position_size` | `u64` | `0` | Max position size. Precision: token mint. 0 = unlimited. | — |

### Fees & Incentives

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `fee_adjustment` | `i16` | `0` | Scales market fees -100 to +100 %. | `updateSpotMarketFeeAdjustment(idx, adj)` |
| `fuel_boost_deposits` | `u8` | `0` | Fuel multiplier for deposits. Precision: /10. | `updateSpotMarketFuel(idx, dep?, bor?, taker?, maker?, ins?)` |
| `fuel_boost_borrows` | `u8` | `0` | Fuel multiplier for borrows. Precision: /10. | `updateSpotMarketFuel(idx, dep?, bor?, taker?, maker?, ins?)` |
| `fuel_boost_taker` | `u8` | `0` | Fuel multiplier for taker volume. Precision: /10. | `updateSpotMarketFuel(idx, dep?, bor?, taker?, maker?, ins?)` |
| `fuel_boost_maker` | `u8` | `0` | Fuel multiplier for maker volume. Precision: /10. | `updateSpotMarketFuel(idx, dep?, bor?, taker?, maker?, ins?)` |
| `fuel_boost_insurance` | `u8` | `0` | Fuel multiplier for insurance staking. Precision: /10. | `updateSpotMarketFuel(idx, dep?, bor?, taker?, maker?, ins?)` |

### Insurance Fund

Nested in `SpotMarket.insurance_fund`.

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `insurance_fund.vault` | `Pubkey` | (set at init) | Insurance fund vault PDA | — |
| `insurance_fund.unstaking_period` | `i64` | `0` | Cooldown (seconds) before IF unstake completes. Default constant: 13 days (1,123,200s). | `updateInsuranceFundUnstakingPeriod(idx, period)` |
| `insurance_fund.revenue_settle_period` | `i64` | `0` | Min time between revenue settlements. | `updateSpotMarketRevenueSettlePeriod(idx, period)` |
| `insurance_fund.total_factor` | `u32` | `0` | % of interest going to total insurance fund. Precision: IF_FACTOR_PRECISION (10^6 = 100%). | `updateSpotMarketIfFactor(idx, userFactor, totalFactor)` |
| `insurance_fund.user_factor` | `u32` | `0` | % of interest going to user-staked insurance. Must be <= total_factor. | `updateSpotMarketIfFactor(idx, userFactor, totalFactor)` |

### Operations

| Rust Field | Type | Default | Description | SDK Function |
|---|---|---|---|---|
| `paused_operations` | `u8` | `0` | Bitmask of paused spot operations | `updateSpotMarketPausedOperations(idx, ops)` |
| `if_paused_operations` | `u8` | `0` | Bitmask of paused insurance fund operations | `updateSpotMarketIfPausedOperations(idx, ops)` |

#### SpotOperation Bit Flags

| Operation | Bit |
|---|---|
| `UpdateCumulativeInterest` | `0b00000001` |
| `Fill` | `0b00000010` |
| `Deposit` | `0b00000100` |
| `Withdraw` | `0b00001000` |
| `Liquidation` | `0b00010000` |

#### InsuranceFundOperation Bit Flags

| Operation | Bit |
|---|---|
| `Init` | `0b00000001` |
| `Add` | `0b00000010` |
| `RequestRemove` | `0b00000100` |
| `Remove` | `0b00001000` |

---

## 6. SDK Admin Function Quick Reference

All functions are on `AdminClient` (extends `DriftClient`). Each has a corresponding `get*Ix` variant that returns a `TransactionInstruction`.

### Global State Functions

| Function | Parameters | Description |
|---|---|---|
| `initialize(usdcMint, adminControlsPrices)` | mint, bool | Initialize the exchange state |
| `updateAdmin(admin)` | PublicKey | Change exchange admin |
| `updateWhitelistMint(mint?)` | PublicKey? | Set/clear whitelist mint |
| `updateDiscountMint(mint)` | PublicKey | Set discount mint |
| `updateSerumVault(vault)` | PublicKey | Set SRM vault |
| `updateExchangeStatus(status)` | ExchangeStatus | Set exchange status bitmask |
| `updatePerpFeeStructure(feeStructure)` | FeeStructure | Set perp fee tiers & rewards |
| `updateSpotFeeStructure(feeStructure)` | FeeStructure | Set spot fee tiers & rewards |
| `updateOracleGuardRails(rails)` | OracleGuardRails | Set oracle validity params |
| `updateInitialPctToLiquidate(pct)` | number | Set initial liquidation % |
| `updateLiquidationDuration(duration)` | number | Set liquidation spread duration |
| `updateLiquidationMarginBufferRatio(ratio)` | number | Set margin buffer above maintenance |
| `updateStateSettlementDuration(duration)` | number | Set settlement duration |
| `updateStateMaxNumberOfSubAccounts(max)` | number | Set max sub-accounts |
| `updateStateMaxInitializeUserFee(fee)` | number | Set max account init fee |
| `updateLpCooldownTime(time)` | BN | Set LP withdrawal cooldown |
| `updatePerpAuctionDuration(min)` | number | Set min perp auction duration |
| `updateSpotAuctionDuration(duration)` | number | Set default spot auction duration |
| `updateFeatureBitFlagsMMOracle()` | — | Toggle MM oracle feature |
| `updateFeatureBitFlagsMedianTriggerPrice()` | — | Toggle median trigger price |
| `updateFeatureBitFlagsBuilderCodes()` | — | Toggle builder codes |
| `updateFeatureBitFlagsBuilderReferral()` | — | Toggle builder referral |
| `updateFeatureBitFlagsSettleLpPool()` | — | Toggle LP pool settlement |
| `updateFeatureBitFlagsSwapLpPool()` | — | Toggle LP pool swap |
| `updateFeatureBitFlagsMintRedeemLpPool()` | — | Toggle LP pool mint/redeem |

### Perp Market Functions

| Function | Parameters | Description |
|---|---|---|
| `initializePerpMarket(idx, oracle, baseReserve, quoteReserve, periodicity, ...)` | many | Create new perp market |
| `initializePredictionMarket(idx)` | marketIdx | Convert to prediction market |
| `deleteInitializedPerpMarket(idx)` | marketIdx | Delete un-activated market |
| `moveAmmPrice(idx, baseReserve, quoteReserve, sqrtK?)` | idx, BN, BN, BN? | Admin override AMM reserves |
| `updateK(idx, sqrtK)` | idx, BN | Update AMM liquidity depth |
| `updatePerpMarketConcentrationScale(idx, scale)` | idx, BN | Set concentration coefficient |
| `updatePerpMarketOracle(idx, oracle, source)` | idx, PK, OracleSource | Change oracle |
| `updatePerpMarketName(idx, name)` | idx, string | Rename market |
| `updatePerpMarketStatus(idx, status)` | idx, MarketStatus | Change market status |
| `updatePerpMarketContractTier(idx, tier)` | idx, ContractTier | Change risk tier |
| `updatePerpMarketExpiry(idx, ts)` | idx, BN | Set expiry timestamp |
| `updatePerpMarketMarginRatio(idx, init, maint)` | idx, num, num | Set margin ratios |
| `updatePerpMarketHighLeverageMarginRatio(idx, init, maint)` | idx, num, num | Set HLM margin ratios |
| `updatePerpMarketImfFactor(idx, imf, upnlImf)` | idx, num, num | Set IMF factors |
| `updatePerpMarketUnrealizedAssetWeight(idx, init, maint)` | idx, num, num | Set uPnL weights |
| `updatePerpMarketMaxImbalances(idx, maxImbalance, maxRevWithdraw, maxIns)` | idx, BN, BN, BN | Set insurance/imbalance limits |
| `updatePerpMarketMaxOpenInterest(idx, maxOI)` | idx, BN | Set OI cap |
| `updatePerpMarketLiquidationFee(idx, liqFee, ifFee)` | idx, num, num | Set liquidation fees |
| `updatePerpMarketFeeAdjustment(idx, adj)` | idx, num | Scale market fees |
| `updatePerpMarketBaseSpread(idx, spread)` | idx, num | Set min spread |
| `updatePerpMarketMaxSpread(idx, spread)` | idx, num | Set max spread |
| `updatePerpMarketCurveUpdateIntensity(idx, intensity)` | idx, num | Set k-adjustment intensity |
| `updateAmmJitIntensity(idx, intensity)` | idx, num | Set AMM JIT participation |
| `updatePerpMarketAmmSpreadAdjustment(idx, spread, inv, refOffset)` | idx, num, num, num | Set spread adjustments |
| `updatePerpMarketReferencePriceOffsetDeadbandPct(idx, pct)` | idx, num | Set ref price offset deadband |
| `updatePerpMarketStepSizeAndTickSize(idx, step, tick)` | idx, BN, BN | Set order increments |
| `updatePerpMarketMinOrderSize(idx, size)` | idx, BN | Set min order |
| `updatePerpMarketMaxFillReserveFraction(idx, fraction)` | idx, num | Limit single-fill impact |
| `updateMaxSlippageRatio(idx, ratio)` | idx, num | Set max slippage |
| `updatePerpMarketPerLpBase(idx, base)` | idx, num | Set LP share unit exponent |
| `updatePerpMarketTargetBaseAssetAmountPerLp(idx, target)` | idx, num | Set LP target |
| `updatePerpMarketNumberOfUser(idx, users?, usersWithBase?)` | idx, num?, num? | Override user counts |
| `updatePerpMarketPausedOperations(idx, ops)` | idx, num | Set paused ops bitmask |
| `updatePerpMarketFuel(idx, taker?, maker?, position?)` | idx, num?, num?, num? | Set fuel boosts |
| `updatePerpMarketOracleSlotDelayOverride(idx, delay)` | idx, num | Override oracle slot delay |
| `updatePerpMarketOracleLowRiskSlotDelayOverride(idx, delay)` | idx, num | Override low-risk slot delay |
| `updatePerpMarketProtectedMakerParams(idx, limitDiv?, dynamicDiv?)` | idx, num?, num? | Set protected maker params |
| `updatePerpMarketAmmOracleTwap(idx)` | idx | Force update AMM oracle TWAP |
| `updatePerpMarketPnlPool(idx)` | idx | Update PnL pool |
| `updatePerpMarketAmmSummaryStats(idx, ...)` | idx, opts | Update AMM summary stats |
| `updatePerpMarketLpPoolId(idx, id)` | idx, num | Set LP pool ID |
| `updatePerpMarketLpPoolStatus(idx, status)` | idx, num | Set LP pool status |
| `updatePerpMarketLpPoolFeeTransferScalar(idx, scalar)` | idx, num | Set LP fee transfer scalar |
| `updatePerpMarketLpPoolPausedOperations(idx, ops)` | idx, num | Set LP paused ops |

### Spot Market Functions

| Function | Parameters | Description |
|---|---|---|
| `initializeSpotMarket(mint, optUtil, optRate, maxRate, oracle, ...)` | many | Create new spot market |
| `deleteInitializedSpotMarket(idx)` | marketIdx | Delete un-activated market |
| `updateSpotMarketOracle(idx, oracle, source)` | idx, PK, OracleSource | Change oracle |
| `updateSpotMarketName(idx, name)` | idx, string | Rename market |
| `updateSpotMarketStatus(idx, status)` | idx, MarketStatus | Change market status |
| `updateSpotMarketAssetTier(idx, tier)` | idx, AssetTier | Change asset tier |
| `updateSpotMarketOrdersEnabled(idx, enabled)` | idx, bool | Toggle spot trading |
| `updateSpotMarketPoolId(idx, poolId)` | idx, num | Set pool ID |
| `updateSpotMarketMarginWeights(idx, ia, ma, il, ml, imf?)` | idx, nums | Set margin weights |
| `updateSpotMarketScaleInitialAssetWeightStart(idx, start)` | idx, BN | Set weight scale threshold |
| `updateSpotMarketBorrowRate(idx, optUtil, optRate, maxRate, minRate?)` | idx, nums | Set interest rate curve |
| `updateSpotMarketMaxTokenDeposits(idx, max)` | idx, BN | Set deposit cap |
| `updateSpotMarketMaxTokenBorrows(idx, fraction)` | idx, num | Set borrow fraction cap |
| `updateWithdrawGuardThreshold(idx, threshold)` | idx, BN | Set withdraw guard |
| `updateSpotMarketLiquidationFee(idx, liqFee, ifFee)` | idx, num, num | Set liquidation fees |
| `updateSpotMarketStepSizeAndTickSize(idx, step, tick)` | idx, BN, BN | Set order increments |
| `updateSpotMarketMinOrderSize(idx, size)` | idx, BN | Set min order |
| `updateSpotMarketFeeAdjustment(idx, adj)` | idx, num | Scale market fees |
| `updateSpotMarketFuel(idx, dep?, bor?, taker?, maker?, ins?)` | idx, nums? | Set fuel boosts |
| `updateSpotMarketExpiry(idx, ts)` | idx, BN | Set expiry timestamp |
| `updateSpotMarketPausedOperations(idx, ops)` | idx, num | Set paused ops bitmask |
| `updateSpotMarketIfPausedOperations(idx, ops)` | idx, num | Set IF paused ops |
| `updateSpotMarketIfFactor(idx, userFactor, totalFactor)` | idx, BN, BN | Set IF revenue factors |
| `updateSpotMarketRevenueSettlePeriod(idx, period)` | idx, BN | Set revenue settle interval |
| `updateInsuranceFundUnstakingPeriod(idx, period)` | idx, BN | Set IF unstaking cooldown |

### Other Admin Functions

| Function | Parameters | Description |
|---|---|---|
| `initializeHighLeverageModeConfig(maxUsers)` | num | Create HLM config account |
| `updateUpdateHighLeverageModeConfig(maxUsers, reduceOnly)` | num, bool | Update HLM config |
| `initializeProtectedMakerModeConfig(maxUsers)` | num | Create protected maker config |
| `updateProtectedMakerModeConfig(maxUsers, reduceOnly)` | num, bool | Update protected maker config |
| `initializePythPullOracle(feedId)` | string | Initialize Pyth pull oracle |
| `initializePythLazerOracle(feedId)` | string | Initialize Pyth Lazer oracle |
| `initializePrelaunchOracle(idx, price?, maxPrice?)` | idx, BN?, BN? | Create prelaunch oracle |
| `updatePrelaunchOracleParams(idx, price?, maxPrice?)` | idx, BN?, BN? | Update prelaunch oracle |
| `initializeProtocolIfSharesTransferConfig()` | — | Create IF transfer config |
| `updateProtocolIfSharesTransferConfig(signers?, maxTransfer?)` | PK[]?, BN? | Update IF transfer config |
| `initializeIfRebalanceConfig(params)` | IfRebalanceConfigParams | Create IF rebalance config |

---

*Source files: `programs/drift/src/state/state.rs`, `perp_market.rs`, `spot_market.rs`, `math/constants.rs`, `paused_operations.rs`, `sdk/src/adminClient.ts`*
