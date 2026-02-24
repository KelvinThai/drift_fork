# DLOB Server Setup Guide

How to run the DLOB (Decentralized Limit Order Book) server for the custom perp DEX fork.

---

## Prerequisites

1. **Redis** — DLOB server caches order book snapshots in Redis

   ```bash
   # macOS
   brew install redis
   brew services start redis

   # Verify
   redis-cli ping   # Should return PONG
   ```

2. **Node.js** v20+ and **Yarn**

3. **SDK built** — The dlob-server uses a local link to `protocol-v2/sdk`

   ```bash
   cd ~/protocol-v2/sdk && yarn build
   ```

---

## Quick Start

```bash
# 1. Navigate to dlob-server
cd ~/dlob-server

# 2. Copy environment config
cp .env.custom .env

# 3. Install dependencies (uses local SDK link)
yarn install --ignore-engines

# 4. Start the HTTP server (port 6969)
yarn dev
```

The server will:
- Connect to devnet RPC
- Subscribe to all user accounts via OrderSubscriber
- Build the DLOB from on-chain orders
- Serve L2/L3 order books via HTTP endpoints
- Cache snapshots in Redis every 1000ms

---

## Verify It's Working

```bash
# Health check
curl http://localhost:6969/health

# L2 order book for SOL-PERP
curl "http://localhost:6969/l2?marketIndex=0&marketType=perp&depth=10"

# L2 order book for BTC-PERP
curl "http://localhost:6969/l2?marketIndex=1&marketType=perp&depth=10"

# L3 with individual maker orders
curl "http://localhost:6969/l3?marketIndex=0&marketType=perp"

# Batch L2 for all markets
curl "http://localhost:6969/batchL2?marketIndex=0,1,2&marketType=perp,perp,perp&depth=10,10,10"

# Top makers at best bid
curl "http://localhost:6969/topMakers?marketIndex=0&marketType=perp&side=bid&limit=5"
```

---

## Run Modes

### 1. HTTP Server Only (Simplest)

```bash
yarn dev     # ts-node src/index.ts
```

Serves REST API on port 6969. Keeper bots and frontends query this directly.

### 2. DLOB Publisher (Background Process)

```bash
yarn dlob-publish   # ts-node src/publishers/dlobPublisher.ts
```

Continuously builds DLOB and publishes to Redis. Run alongside the HTTP server or ServerLite.

### 3. ServerLite (Read-Only Cache)

```bash
yarn server-lite   # ts-node src/serverLite.ts
```

Lightweight HTTP server that reads cached data from Redis. Scale horizontally for high traffic.

### 4. WebSocket Manager

```bash
yarn ws-manager   # ts-node src/wsConnectionManager.ts
```

Streams DLOB updates to WebSocket subscribers on port 3000. Requires Redis pub/sub.

### Production Architecture

```
yarn dlob-publish    →  Redis  ←  yarn server-lite (Nx, behind LB)
                              ←  yarn ws-manager
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ENDPOINT` | (required) | Solana RPC HTTP endpoint |
| `WS_ENDPOINT` | (optional) | Solana RPC WebSocket endpoint |
| `ENV` | `devnet` | `devnet` or `mainnet-beta` |
| `PORT` | `6969` | HTTP server port |
| `METRICS_PORT` | `9464` | Prometheus metrics port |
| `PERP_MARKETS_TO_LOAD` | all | Comma-separated perp market indexes |
| `SPOT_MARKETS_TO_LOAD` | all | Comma-separated spot market indexes |
| `ORDERBOOK_UPDATE_INTERVAL` | `400` | L2/L3 update frequency (ms) |
| `USE_WEBSOCKET` | `false` | Use WebSocket for account subscriptions |
| `USE_ORDER_SUBSCRIBER` | `true` | Use OrderSubscriber vs UserMap |
| `USE_GRPC` | `false` | Use gRPC (Yellowstone) for data |
| `ELASTICACHE_HOST` | `localhost` | Redis host |
| `ELASTICACHE_PORT` | `6379` | Redis port |
| `REDIS_CLIENT` | `DLOB` | Redis client prefix |
| `ENABLE_TOB_MONITORING` | `true` | Detect stuck top-of-book orders |
| `DISABLE_GPA_REFRESH` | `false` | Disable periodic getProgramAccounts |

---

## SDK Link

The dlob-server's `package.json` points to the local SDK:

```json
"@drift-labs/sdk": "file:../protocol-v2/sdk"
```

This ensures the DLOB server uses the custom fork's market configs:
- **Program ID**: `6prdU12bH7QLTHoNPhA3RF1yzSjrduLQg45JQgCMJ1ko`
- **Perp Markets**: SOL-PERP (0), BTC-PERP (1), ETH-PERP (2) — PYTH_PULL oracles
- **Spot Markets**: USDC (0) — QUOTE_ASSET oracle

After any SDK changes, rebuild and reinstall:

```bash
cd ~/protocol-v2/sdk && yarn build
cd ~/dlob-server && yarn install --ignore-engines
```

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /startup` | Readiness probe |
| `GET /l2` | L2 order book (aggregated price levels) |
| `GET /l3` | L3 order book (individual maker orders) |
| `GET /batchL2` | Batch L2 for multiple markets |
| `GET /topMakers` | Top makers at best bid/ask |
| `GET /unsettledPnlUsers` | Top 20 PnL gainers/losers |
| `GET /priorityFees` | Priority fee estimates |
| `GET /auctionParams` | Optimal auction parameters for market orders |

### Query Parameters

```
/l2?marketIndex=0&marketType=perp&depth=50
/l3?marketIndex=0&marketType=perp
/topMakers?marketIndex=0&marketType=perp&side=bid&limit=5
/auctionParams?marketIndex=0&marketType=perp&direction=long&amount=100&assetType=base
```

---

## Troubleshooting

### "No L2 found for perp market 0"
- No users have placed orders yet. The order book is empty.
- The AMM does not appear in the DLOB — it's backstop liquidity on-chain.

### Redis connection refused
- Ensure Redis is running: `redis-cli ping`
- Check `ELASTICACHE_HOST` and `ELASTICACHE_PORT` in `.env`

### "Perp market config for X not found"
- The SDK market config doesn't include market index X.
- Check `PERP_MARKETS_TO_LOAD` matches deployed markets (0,1,2).

### SDK mismatch after protocol changes
- Rebuild SDK: `cd ~/protocol-v2/sdk && yarn build`
- Reinstall: `cd ~/dlob-server && yarn install --ignore-engines`

---

*See [KEEPER-BOTS.md](./KEEPER-BOTS.md) for how keeper bots connect to the DLOB server.*
*See [LIQUIDITY.md](./LIQUIDITY.md) for how the multi-layered liquidity system works.*
