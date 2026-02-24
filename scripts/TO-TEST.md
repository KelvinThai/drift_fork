# E2E Test Cases — Custom Perp DEX

Tracking all scenarios to test against the devnet deployment.

## Status Legend

- [ ] Not started (stub only)
- [x] Done

---

## Filler Bot Scenarios

- [x] **1. Cross limit orders (maker/taker)** — `e2e/01-cross-limit-orders.ts`
  Maker SELL + taker BUY at same price, direct fill, verify positions
- [x] **2. Market orders (taker vs AMM)** — `e2e/02-market-orders.ts`
  Taker places market order with no resting maker; filler matches against AMM
- [x] **3. Partial fills** — `e2e/03-partial-fills.ts`
  Maker has 1.0 SOL ask, taker buys 0.3 SOL; verify partial fill + remaining order
- [x] **4. Multiple makers** — `e2e/04-multiple-makers.ts`
  Taker order fills across 2-3 makers at different price levels
- [ ] **5. JIT auction fill** — `e2e/05-jit-auction-fill.ts`
  Taker places market order with auction params; maker provides JIT liquidity during auction window
- [ ] **6. Post-only rejection** — `e2e/06-post-only-rejection.ts`
  Maker places post-only order that would immediately cross; verify rejection
- [ ] **7. Expired orders** — `e2e/07-expired-orders.ts`
  Place order with `maxTs` in near future; verify it expires unfilled
- [ ] **8. Oracle-pegged orders** — `e2e/08-oracle-pegged-orders.ts`
  Place limit order with oracle price offset; verify fill price adjusts with oracle movement
- [ ] **9. Reduce-only orders** — `e2e/09-reduce-only.ts`
  Open a position, then place reduce-only order; verify it only closes and doesn't flip
- [ ] **10. Immediate-or-cancel (IOC)** — `e2e/10-immediate-or-cancel.ts`
  Place IOC order; verify unfilled portion is cancelled immediately

## Liquidator Bot Scenarios

- [ ] **11. Basic perp liquidation** — `e2e/11-basic-liquidation.ts`
  User opens leveraged long, oracle moves against them until margin < maintenance; verify liquidator bot liquidates
- [ ] **12. Partial liquidation** — `e2e/12-partial-liquidation.ts`
  Large position that exceeds single-tx liquidation capacity; verify liquidator handles multiple rounds
- [ ] **13. Multi-position liquidation** — `e2e/13-multi-position-liquidation.ts`
  User has positions in SOL + BTC + ETH; one goes underwater; verify correct market is liquidated first
- [ ] **14. Auto-derisking** — `e2e/14-auto-derisking.ts`
  After liquidator takes over a position, verify it derisk (closes) the inherited position

## Trigger Bot Scenarios

- [ ] **15. Stop-loss (trigger market)** — `e2e/15-stop-loss.ts`
  Place trigger order below current price for a long; move oracle down past trigger; verify trigger bot fires it
- [ ] **16. Take-profit (trigger limit)** — `e2e/16-take-profit.ts`
  Place trigger order above current price; move oracle up past trigger; verify trigger bot fires it
- [ ] **17. Triggered order with crossing** — `e2e/17-triggered-with-crossing.ts`
  Triggered order immediately crosses a resting maker; verify fill chain works end-to-end

## Funding Rate Scenarios

- [ ] **18. Funding rate update** — `e2e/18-funding-rate-update.ts`
  Create imbalanced positions (more longs than shorts); verify `fundingRateUpdater` bot updates the funding rate
- [ ] **19. Funding payment settlement** — `e2e/19-funding-payment-settlement.ts`
  After funding rate update, verify funding payments flow correctly between longs and shorts

## PnL Settlement Scenarios

- [ ] **20. Settle positive PnL** — `e2e/20-settle-positive-pnl.ts`
  User has unrealized profit; verify `userPnlSettler` bot settles it to collateral balance
- [ ] **21. Settle negative PnL** — `e2e/21-settle-negative-pnl.ts`
  User has unrealized loss; verify settlement reduces collateral

## Multi-Market / Cross-Margin Scenarios

- [ ] **22. Cross-margin leverage** — `e2e/22-cross-margin-leverage.ts`
  User opens positions on SOL and BTC using same USDC collateral; verify margin calculated across both
- [ ] **23. BTC-PERP and ETH-PERP fills** — `e2e/23-btc-eth-fills.ts`
  Repeat basic cross fill test on market index 1 (BTC) and 2 (ETH); verify multi-market support

## Edge Cases

- [ ] **24. Self-trade prevention** — `e2e/24-self-trade-prevention.ts`
  Same user places both buy and sell; verify they don't match against themselves
- [ ] **25. Minimum order size** — `e2e/25-minimum-order-size.ts`
  Place order below minimum base amount; verify rejection
- [ ] **26. Price band limits** — `e2e/26-price-band-limits.ts`
  Place order far from oracle (e.g. 50% away); verify rejection by oracle guard rails
- [ ] **27. Concurrent taker orders** — `e2e/27-concurrent-takers.ts`
  Multiple takers submit orders simultaneously against same maker; verify no double-fill
- [ ] **28. Insufficient margin rejection** — `e2e/28-insufficient-margin.ts`
  User with insufficient collateral tries to open a position; verify order rejected

---

## Priority

| Priority | Tests | Rationale |
|----------|-------|-----------|
| P0 | 1, 2, 3, 11 | Core fill + safety-critical liquidation |
| P1 | 9, 15, 16, 18, 19 | Key user features + core perp mechanics |
| P2 | 4, 5, 20, 21, 22, 23 | Depth, settlement, multi-market |
| P3 | 6, 7, 8, 10, 12-14, 17, 24-28 | Robustness + edge cases |

## Running Tests

```bash
# Run a single test
npx ts-node --transpile-only scripts/e2e/01-cross-limit-orders.ts

# Run all tests
npx ts-node --transpile-only scripts/e2e/run-all.ts

# Run specific tests (by number prefix)
npx ts-node --transpile-only scripts/e2e/run-all.ts 01 02 03

# Admin scripts
npx ts-node --transpile-only scripts/admin/fix-oracles.ts
npx ts-node --transpile-only scripts/admin/initialize-protocol.ts
npx ts-node --transpile-only scripts/admin/reset-with-mock-usdc.ts
```

## Directory Structure

```
scripts/
├── admin/                          # Admin/ops scripts
│   ├── fix-oracles.ts
│   ├── initialize-protocol.ts
│   └── reset-with-mock-usdc.ts
├── e2e/                            # E2E test directory
│   ├── setup/                      # Shared modules
│   │   ├── config.ts               # ENV vars, constants, market indices
│   │   ├── client.ts               # AdminClient + DriftClient factory
│   │   ├── user.ts                 # Create taker, fund, mint, deposit
│   │   ├── oracle.ts               # Prelaunch oracle refresh + AMM fixes
│   │   ├── helpers.ts              # sleep, httpGet, queryDlobL3, etc.
│   │   ├── order.ts                # Place orders, find orders, cancel
│   │   ├── fill.ts                 # Build MakerInfo, execute direct fill
│   │   ├── verify.ts               # Check positions, PASS/FAIL assertion
│   │   └── index.ts                # Barrel re-export
│   ├── 01-cross-limit-orders.ts    # [x] Implemented
│   ├── 02-market-orders.ts         # [x] Implemented
│   ├── ...                         # [ ] Stubs (03-28)
│   └── run-all.ts                  # Sequential test runner
├── TO-TEST.md                      # This file
└── tsconfig.json
```

## Notes

- All tests use Prelaunch oracles (admin-controlled) — oracle price can be moved via `updatePrelaunchOracleParams`
- AMM state must be fixed before fills (moveAmmToPrice + resetOracleTwap + contract tier + guard rails)
- Taker accounts are ephemeral (new keypair each run); admin accumulates positions across runs
- DLOB server is optional — direct fill works without it
- Shared setup modules in `e2e/setup/` eliminate boilerplate — each test is ~60-80 lines
