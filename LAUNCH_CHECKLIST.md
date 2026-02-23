# Mainnet Launch Checklist

## Pre-Launch
- [ ] Smart contract audit completed (OtterSec, Neodyme, or Sec3)
- [ ] All Drift audit reports reviewed for known issues
- [ ] Program deployed and verified on mainnet
- [ ] Admin authority transferred to multisig (Squads Protocol)
- [ ] All markets initialized with correct Pyth oracle feeds
- [ ] Market parameters verified (margin ratios, leverage limits)
- [ ] Fee structure confirmed and tested
- [ ] Insurance fund vault initialized and seeded

## Infrastructure
- [ ] Private RPC node(s) operational (Helius/QuickNode/Triton)
- [ ] Backup RPC endpoints configured
- [ ] Redis cluster running (3+ nodes for DLOB WebSocket mode)
- [ ] DLOB server running in production (WebSocket mode, 2+ instances)
- [ ] Filler bots running (2+ instances for redundancy)
- [ ] Liquidator bots running (2+ instances for redundancy)
- [ ] JIT maker bot deployed (recommended)
- [ ] Trigger bot running
- [ ] Gateway deployed (if using)

## Monitoring
- [ ] Prometheus metrics collection configured
- [ ] Grafana dashboards set up (bot health, fill rates, liquidations)
- [ ] Alerting configured (bot downtime, failed fills, low balances)
- [ ] Bot wallet balance monitoring

## Security
- [ ] Admin keypair stored in hardware wallet / multisig
- [ ] Bot keypairs have limited SOL/USDC balances
- [ ] Program upgrade authority secured
- [ ] No sensitive keys in environment variables on shared systems
- [ ] Emergency pause procedures documented and tested

## Operations
- [ ] Runbook documented for common operations
- [ ] On-call rotation established
- [ ] Incident response plan documented
- [ ] Market parameter update procedures tested
- [ ] Bot restart procedures tested

## Cost Estimates (Monthly)
| Component | Devnet | Mainnet |
|-----------|--------|---------|
| RPC nodes | $0-50 | $500-2000 |
| DLOB servers | $100-200 | $2000-5000 |
| Keeper bots | $50-100 | $2000-5000 |
| Redis cluster | $0 | $500-1000 |
| Monitoring | $0 | $200-500 |
| Bot collateral | ~$100 | $10K-50K |
| **Total** | **~$200-500** | **~$15K-60K** |
