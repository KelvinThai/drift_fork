# E2E Test Cases — Custom Perp DEX

Tracking all scenarios to test against the devnet deployment.

## Status Legend

- [ ] Not started
- [x] Done

---

## Filler Bot Scenarios

- [x] **1. Cross limit orders (maker/taker)** — `test-e2e-orders.ts`
  Maker SELL + taker BUY at same price, direct fill, verify positions
- [ ] **2. Market orders (taker vs AMM)**
  Taker places market order with no resting maker; filler matches against AMM
- [ ] **3. Partial fills**
  Maker has 1.0 SOL ask, taker buys 0.3 SOL; verify partial fill + remaining order
- [ ] **4. Multiple makers**
  Taker order fills across 2-3 makers at different price levels
- [ ] **5. JIT auction fill**
  Taker places market order with auction params; maker provides JIT liquidity during auction window
- [ ] **6. Post-only rejection**
  Maker places post-only order that would immediately cross; verify rejection
- [ ] **7. Expired orders**
  Place order with `maxTs` in near future; verify it expires unfilled
- [ ] **8. Oracle-pegged orders**
  Place limit order with oracle price offset; verify fill price adjusts with oracle movement
- [ ] **9. Reduce-only orders**
  Open a position, then place reduce-only order; verify it only closes and doesn't flip
- [ ] **10. Immediate-or-cancel (IOC)**
  Place IOC order; verify unfilled portion is cancelled immediately

## Liquidator Bot Scenarios

- [ ] **11. Basic perp liquidation**
  User opens leveraged long, oracle moves against them until margin < maintenance; verify liquidator bot liquidates
- [ ] **12. Partial liquidation**
  Large position that exceeds single-tx liquidation capacity; verify liquidator handles multiple rounds
- [ ] **13. Multi-position liquidation**
  User has positions in SOL + BTC + ETH; one goes underwater; verify correct market is liquidated first
- [ ] **14. Auto-derisking**
  After liquidator takes over a position, verify it derisk (closes) the inherited position

## Trigger Bot Scenarios

- [ ] **15. Stop-loss (trigger market)**
  Place trigger order below current price for a long; move oracle down past trigger; verify trigger bot fires it
- [ ] **16. Take-profit (trigger limit)**
  Place trigger order above current price; move oracle up past trigger; verify trigger bot fires it
- [ ] **17. Triggered order with crossing**
  Triggered order immediately crosses a resting maker; verify fill chain works end-to-end

## Funding Rate Scenarios

- [ ] **18. Funding rate update**
  Create imbalanced positions (more longs than shorts); verify `fundingRateUpdater` bot updates the funding rate
- [ ] **19. Funding payment settlement**
  After funding rate update, verify funding payments flow correctly between longs and shorts

## PnL Settlement Scenarios

- [ ] **20. Settle positive PnL**
  User has unrealized profit; verify `userPnlSettler` bot settles it to collateral balance
- [ ] **21. Settle negative PnL**
  User has unrealized loss; verify settlement reduces collateral

## Multi-Market / Cross-Margin Scenarios

- [ ] **22. Cross-margin leverage**
  User opens positions on SOL and BTC using same USDC collateral; verify margin calculated across both
- [ ] **23. BTC-PERP and ETH-PERP fills**
  Repeat basic cross fill test on market index 1 (BTC) and 2 (ETH); verify multi-market support

## Edge Cases

- [ ] **24. Self-trade prevention**
  Same user places both buy and sell; verify they don't match against themselves
- [ ] **25. Minimum order size**
  Place order below minimum base amount; verify rejection
- [ ] **26. Price band limits**
  Place order far from oracle (e.g. 50% away); verify rejection by oracle guard rails
- [ ] **27. Concurrent taker orders**
  Multiple takers submit orders simultaneously against same maker; verify no double-fill
- [ ] **28. Insufficient margin rejection**
  User with insufficient collateral tries to open a position; verify order rejected

---

## Priority

| Priority | Tests | Rationale |
|----------|-------|-----------|
| P0 | 1, 2, 3, 11 | Core fill + safety-critical liquidation |
| P1 | 9, 15, 16, 18, 19 | Key user features + core perp mechanics |
| P2 | 4, 5, 20, 21, 22, 23 | Depth, settlement, multi-market |
| P3 | 6, 7, 8, 10, 12-14, 17, 24-28 | Robustness + edge cases |

## Scripts

| Script | Tests covered |
|--------|---------------|
| `test-e2e-orders.ts` | #1 |

## Notes

- All tests use Prelaunch oracles (admin-controlled) — oracle price can be moved via `updatePrelaunchOracleParams`
- AMM state must be fixed before fills (moveAmmToPrice + resetOracleTwap + contract tier + guard rails)
- Taker accounts are ephemeral (new keypair each run); admin accumulates positions across runs
- DLOB server is optional — direct fill works without it
