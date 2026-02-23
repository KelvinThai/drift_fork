# Drift Protocol v2 — How Perp Market Liquidity Works

Detailed explanation of the multi-layered liquidity system in Drift v2 perpetual markets.

---

## Table of Contents

1. [The Virtual AMM (vAMM)](#1-the-virtual-amm-vamm--core-pricing-engine)
2. [Spreads](#2-spreads--the-amms-edge)
3. [Four Layers of Liquidity](#3-four-layers-of-liquidity-fill-priority)
4. [The Auction Mechanism](#4-the-auction-mechanism)
5. [Funding Rate](#5-funding-rate--implicit-liquidity-balancing)
6. [Curve Dynamics](#6-curve-dynamics--self-adjusting-liquidity)
7. [How It All Fits Together](#7-how-it-all-fits-together)
8. [Key Parameters](#8-key-parameters-that-control-liquidity)

---

## 1. The Virtual AMM (vAMM) — Core Pricing Engine

Unlike a spot AMM (Uniswap), there are **no actual token pools**. The AMM is purely mathematical — it simulates a constant-product curve to provide guaranteed liquidity.

### Constant Product Formula

```
base_asset_reserve × quote_asset_reserve = k
sqrt_k = √k
```

The **reserve price** (mid-market) is:

```
reserve_price = (quote_asset_reserve × peg_multiplier) / base_asset_reserve
```

- `peg_multiplier` — anchors the price to the oracle (e.g., SOL at $150 → peg ≈ 150,000,000 in PRICE_PRECISION)
- `sqrt_k` — controls **liquidity depth**. Higher k = less slippage per trade. This is the most important liquidity parameter.
- `concentration_coef` — squeezes liquidity around the current price (like Uniswap v3 ranges). Max ~1.414 (√2). Tighter concentration = less slippage near mid-price but AMM runs out of liquidity faster on big moves.

### Example

Say `sqrt_k = 1,000,000 * BASE_PRECISION` (1M base units) and SOL is $150:
- A buy of 1 SOL would push price up very slightly
- A buy of 100,000 SOL would push price up significantly
- The slippage curve is the classic `x*y=k` hyperbola

### What "Virtual" Means

When a user goes long 1 SOL-PERP:
- `base_asset_reserve` increases (AMM "sells" base)
- `quote_asset_reserve` decreases
- No actual SOL moves — it's all accounting
- The user's collateral is USDC in the spot vault

---

## 2. Spreads — The AMM's Edge

The AMM doesn't quote at the reserve price directly. It adds a **bid-ask spread**:

```
ask_price = reserve_price × (1 + long_spread + reference_price_offset)
bid_price = reserve_price × (1 - short_spread + reference_price_offset)
```

Spreads are **dynamic** and widen based on:

| Factor | Effect |
|---|---|
| `base_spread` | Minimum spread floor (e.g., 10 bps) |
| `max_spread` | Hard ceiling (e.g., 14.25%) |
| **Inventory** | More lopsided AMM position → wider spread on the heavy side |
| **Oracle confidence** | Low confidence → wider spread |
| **Volatility** (`mark_std`, `oracle_std`) | Higher vol → wider spread |
| **Revenue drawdown** | If AMM is losing money → spreads widen defensively |
| `amm_spread_adjustment` | Admin override: -100 (0x) to +100 (2x) |
| `reference_price_offset` | Shifts entire bid/ask up or down vs oracle |

This means the AMM **self-adjusts** to charge more when conditions are risky.

---

## 3. Four Layers of Liquidity (Fill Priority)

When a taker order comes in, it doesn't just hit the AMM. There's a priority waterfall:

```
┌─────────────────────────────────────────────┐
│  1. DLOB Makers (limit orders from users)   │  ← Best price wins
├─────────────────────────────────────────────┤
│  2. JIT Makers (just-in-time market makers) │  ← Fill during auction
├─────────────────────────────────────────────┤
│  3. AMM (virtual market maker)              │  ← Backstop liquidity
├─────────────────────────────────────────────┤
│  4. LP Shares (user-provided AMM liquidity) │  ← Share of AMM fills
└─────────────────────────────────────────────┘
```

### Layer 1: DLOB (Decentralized Limit Order Book)

Users place limit orders that sit off-chain in the DLOB (served by `dlob-server` and `keeper-bots-v2`). When a taker order crosses a maker's price, the keeper bot matches them.

- Maker gets a **rebate** (e.g., -2 bps)
- Taker pays a **fee** (e.g., 5 bps)
- This is the cheapest liquidity — no AMM slippage

### Layer 2: JIT (Just-In-Time) Makers

During the **auction period** (`min_perp_auction_duration` slots), market makers can see incoming taker orders and fill against them at the auction price.

- Controlled by `amm_jit_intensity` (0 = off, 1-100 = protocol AMM intensity, 101-200 = LP intensity)
- AMM only JIT-makes when it would **reduce its inventory** (not add risk)
- This is similar to Uniswap's JIT liquidity concept

### Layer 3: The AMM Itself

If makers and JIT don't fully fill the order, the AMM acts as backstop:

- Fills at the spread-adjusted price on the `x*y=k` curve
- Subject to `max_fill_reserve_fraction` — limits how much liquidity one fill can consume
- Subject to `max_slippage_ratio` — max price impact per fill
- Blocked if `max_open_interest` would be breached
- Blocked if AMM has too much drawdown (`net_revenue_since_last_funding` too negative)

### Layer 4: LP Shares

Users can **mint LP shares** to provide liquidity alongside the protocol-owned AMM:

```
Protocol-owned liquidity = sqrt_k - user_lp_shares
User LP liquidity = user_lp_shares
```

LP providers:
- Earn a share of trading fees (80/20 split: `LP_FEE_SLICE_NUMERATOR/DENOMINATOR` = 8/10)
- Take on the AMM's position risk proportionally
- Track PnL via `base_asset_amount_per_lp` and `quote_asset_amount_per_lp`
- Subject to `lp_cooldown_time` before withdrawal

---

## 4. The Auction Mechanism

Every market order goes through a **Dutch auction** to give makers a chance:

```
Time 0 (order placed)          → Auction start price (favorable to taker)
  │
  ▼  auction slots tick by...
  │
Time N (auction ends)          → Auction end price (oracle + spread)
  │
  ▼  after auction...
  │
AMM can fill                   → At AMM bid/ask with slippage
```

- `min_perp_auction_duration` (global) sets the minimum auction length
- `oracle_low_risk_slot_delay_override` (per-market) can shorten/disable it
- Makers who fill during auction get better prices than the AMM would give
- This creates competition that tightens effective spreads

---

## 5. Funding Rate — Implicit Liquidity Balancing

Every `funding_period` (typically 1 hour), a **funding rate** is calculated:

```
funding_rate ∝ (mark_twap - oracle_twap) / oracle_twap
```

- If mark > oracle → longs pay shorts (too many longs)
- If mark < oracle → shorts pay longs (too many shorts)

This **incentivizes arbitrageurs** to take the other side, naturally balancing the book and keeping the mark price near oracle. It's an indirect liquidity mechanism.

---

## 6. Curve Dynamics — Self-Adjusting Liquidity

The AMM can **automatically adjust k** (liquidity depth):

- `curve_update_intensity` (0-100): How aggressively k adjusts
  - 0 = no auto-adjustment (admin must call `updateK`)
  - Higher = more responsive to market conditions
  - 101-200 = also enables `reference_price_offset` (AMM shifts its mid-price toward oracle)
- k increases when the AMM is profitable (earning fees)
- k decreases when the AMM is losing money (defensive)
- Bounded by `MAX_K_BPS_INCREASE` (10 bps/update) and `MAX_K_BPS_DECREASE` (2.2%/update)

---

## 7. How It All Fits Together

A typical trade flow:

```
1. User submits market long for 10 SOL-PERP
2. Order enters auction (e.g., 10 slots ≈ 5 seconds)
3. Keeper bots check DLOB for crossing maker orders
   → 3 SOL filled by maker at $150.01 (maker rebate, taker fee)
4. JIT maker fills 2 SOL at auction price $150.02
5. AMM fills remaining 5 SOL at $150.05 (with slippage on curve)
   → AMM's base_asset_amount_with_amm goes -5 SOL (short exposure)
   → reserve price shifts up slightly
   → spreads may widen on ask side (inventory skew)
6. LP share holders absorb portion of AMM's new position
7. Next funding update: if mark > oracle, longs pay shorts
   → incentivizes new shorts to balance the book
```

---

## 8. Key Parameters That Control Liquidity

| Parameter | What It Controls | Typical Value |
|---|---|---|
| `sqrt_k` | Liquidity depth (most important) | 1M-100M base units |
| `base_spread` | Minimum spread | 250-1000 (2.5-10 bps) |
| `max_spread` | Maximum spread | 50,000-142,500 (5-14.25%) |
| `concentration_coef` | Curve tightness | 1,000,000-1,414,200 |
| `curve_update_intensity` | Auto k-adjustment speed | 0-200 |
| `amm_jit_intensity` | JIT participation level | 0-200 |
| `max_fill_reserve_fraction` | Max single-fill liquidity use | 1-100 |
| `max_open_interest` | OI cap | Market-dependent |
| `funding_period` | Funding interval | 3600 (1 hour) |

---

*See [PARAMETERS.md](./PARAMETERS.md) for full parameter reference with precisions and SDK functions.*
