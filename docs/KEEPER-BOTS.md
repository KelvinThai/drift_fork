# Drift Protocol v2 — Keeper Bots & DLOB Server Architecture

How the off-chain infrastructure (keeper bots + DLOB server) powers order matching, liquidations, and protocol maintenance.

---

## Table of Contents

1. [Overview](#1-overview)
2. [DLOB Server](#2-dlob-server--the-order-book-backbone)
3. [Keeper Bots](#3-keeper-bots--the-execution-layer)
4. [Data Flow](#4-data-flow--how-they-connect)
5. [Bot Types Reference](#5-bot-types-reference)
6. [Fill Flow in Detail](#6-fill-flow-in-detail)
7. [JIT Maker](#7-jit-maker--just-in-time-liquidity)
8. [Configuration](#8-configuration)
9. [Deployment Architecture](#9-deployment-architecture)

---

## 1. Overview

Drift v2 is a **hybrid on-chain/off-chain system**:

- **On-chain** (Solana program): Holds all state — user accounts, positions, orders, AMM reserves, collateral vaults
- **Off-chain** (DLOB server + keeper bots): Reads on-chain state, matches orders, and submits transactions to execute fills, liquidations, funding updates, etc.

```
┌──────────────────────────────────────────────────────────────────┐
│                        Solana Blockchain                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │  State    │  │  User    │  │  Perp    │  │  Spot Markets +  │ │
│  │  Account  │  │ Accounts │  │  Markets │  │  Vaults          │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘ │
└────────────────────────┬─────────────────────────────────────────┘
                         │  WebSocket / gRPC / Polling
                         ▼
              ┌─────────────────────┐
              │    DLOB Server      │  ← Aggregates all orders into
              │  (order book cache) │     L2/L3 order book snapshots
              └──────────┬──────────┘
                         │  Redis / HTTP / WebSocket
                         ▼
              ┌─────────────────────┐
              │    Keeper Bots      │  ← Query DLOB, find actionable
              │  (filler, trigger,  │     orders, submit transactions
              │   liquidator, etc.) │
              └──────────┬──────────┘
                         │  Transactions
                         ▼
              ┌─────────────────────┐
              │  Solana Blockchain  │
              └─────────────────────┘
```

**Why off-chain?** Solana programs can't iterate over all accounts or run scheduled tasks. Keeper bots are the "cranks" that keep the protocol running.

---

## 2. DLOB Server — The Order Book Backbone

The DLOB server (`~/dlob-server`) subscribes to all on-chain user accounts, builds an in-memory order book, and serves it via multiple channels.

### What It Does

1. **Subscribes** to all Drift user accounts via WebSocket, gRPC, or polling
2. **Builds** a Decentralized Limit Order Book (DLOB) from user orders
3. **Publishes** L2 (aggregated) and L3 (per-maker) snapshots every ~400ms
4. **Serves** data via HTTP REST, WebSocket, and Redis pub/sub

### Core Components

| Component | File | Purpose |
|---|---|---|
| HTTP Server | `src/index.ts` | Express app with 13 REST endpoints |
| WebSocket Manager | `src/wsConnectionManager.ts` | Streams DLOB updates to subscribers |
| DLOB Publisher | `src/publishers/dlobPublisher.ts` | Builds DLOB, writes snapshots to Redis |
| Trades Publisher | `src/publishers/tradesPublisher.ts` | Streams trade events to Redis |
| DLOB Provider | `src/dlobProvider.ts` | Wraps OrderSubscriber/UserMap |
| DLOBSubscriberIO | `src/dlob-subscriber/DLOBSubscriberIO.ts` | Extended subscriber that publishes to Redis |
| ServerLite | `src/serverLite.ts` | Read-only HTTP server (reads from Redis cache) |

### API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /l2?marketIndex=0&marketType=perp&depth=50` | L2 order book (aggregated price levels) |
| `GET /l3?marketIndex=0&marketType=perp` | L3 order book (individual maker orders) |
| `GET /batchL2?marketIndex=0,1,2&marketType=perp` | Batch L2 for multiple markets |
| `GET /topMakers?marketIndex=0&side=bid&limit=5` | Top makers at best prices |
| `GET /auctionParams?marketIndex=0&direction=long&amount=100` | Optimal auction parameters |
| `GET /priorityFees?marketIndex=0&marketType=perp` | Priority fee estimates |
| `GET /unsettledPnlUsers?marketIndex=0` | Top 20 gainers/losers |
| `GET /health` | Health check |

### Data Subscription Backends (Priority Order)

1. **gRPC (Yellowstone)** — Lowest latency, enterprise-grade. Requires `USE_GRPC=true` + `GRPC_ENDPOINT`
2. **WebSocket** — Standard, uses Solana's native WebSocket. `USE_WEBSOCKET=true`
3. **Polling** — Fallback, uses `BulkAccountLoader` for periodic fetches

### Redis Keys

DLOB server publishes snapshots to Redis for consumption by keeper bots and the lite server:

```
last_update_orderbook_l2_perp_0     # L2 for SOL-PERP
last_update_orderbook_l2_perp_1     # L2 for BTC-PERP
last_update_orderbook_l3_perp_0     # L3 for SOL-PERP
last_update_orderbook_l3_spot_0     # L3 for USDC spot
```

---

## 3. Keeper Bots — The Execution Layer

Keeper bots (`~/keeper-bots-v2`) are the workers that read the DLOB and submit transactions to the Drift program. Each bot type handles a specific protocol operation.

### Architecture

```
┌─────────────────────────────────────────────────┐
│                  index.ts (Entry Point)          │
│  1. Load config (YAML / CLI / env vars)          │
│  2. Create DriftClient + connection               │
│  3. Initialize UserMap + SlotSubscriber           │
│  4. Create enabled bots                           │
│  5. Start interval loops                          │
│  6. Run health check server (:8888)              │
└───────────────────┬─────────────────────────────┘
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
┌──────────┐ ┌───────────┐ ┌────────────┐
│ FillerBot│ │ Liquidator│ │ TriggerBot │  ... (15+ bot types)
│          │ │           │ │            │
│ tryFill()│ │tryLiquid()│ │tryTrigger()│
└──────────┘ └───────────┘ └────────────┘
```

### Bot Interface

All bots implement a common interface (`src/types.ts`):

```typescript
interface Bot {
    name: string;
    dryRun: boolean;
    defaultIntervalMs?: number;

    init(): Promise<void>;              // Subscribe to data sources
    reset(): Promise<void>;             // Cleanup and unsubscribe
    startIntervalLoop(): Promise<void>; // Begin periodic execution
    healthCheck(): Promise<boolean>;    // Liveness check (watchdog pattern)
}
```

### DriftClient — The Protocol Connection

Every bot uses a shared `DriftClient` instance to interact with the Drift program:

```typescript
const driftClient = new DriftClient({
    connection,
    wallet,
    programID: driftPublicKey,
    accountSubscription: { type: 'websocket' | 'polling' },
    env: 'devnet' | 'mainnet-beta',
    perpMarketIndexes: [0, 1, 2],
    spotMarketIndexes: [0],
    txSender,  // retry | while-valid | fast | jet (Jito)
});
```

### UserMap — Account Tracking

`UserMap` maintains all on-chain user accounts in memory:

```typescript
const userMap = new UserMap({
    driftClient,
    connection,
    subscriptionConfig: {
        type: 'polling',     // or 'websocket'
        frequency: 15_000,   // 15s refresh for polling
    },
    skipInitialLoad: false,
    includeIdle: false,
});
```

This feeds into `DLOBSubscriber` which builds the order book that bots query.

---

## 4. Data Flow — How They Connect

### Option A: Keeper Bot with Built-in DLOB (Self-Contained)

```
Solana → UserMap → DLOBSubscriber → FillerBot.tryFill()
         (in-process)
```

The keeper bot builds its own DLOB from UserMap data. No external DLOB server needed, but higher RPC load.

### Option B: Keeper Bot + External DLOB Server

```
Solana → DLOB Server → Redis → Keeper Bot → tryFill()
                      → HTTP
                      → WebSocket
```

The DLOB server centralizes data aggregation. Keeper bots read from Redis/HTTP instead of subscribing to all accounts directly.

### Connection Methods (Bot → DLOB Server)

| Method | Latency | Setup |
|---|---|---|
| **Redis pub/sub** | ~400ms (update interval) | Shared Redis instance |
| **HTTP REST** | On-demand | `GET /l2`, `/l3`, `/topMakers` |
| **WebSocket** | Real-time streaming | Connect to WS port |

### Why Both Options Exist

- **Self-contained** (Option A): Simpler deployment, no Redis dependency, good for low-volume or single-bot setups
- **External DLOB** (Option B): Better for multi-bot deployments, reduces RPC load (one subscriber instead of N), serves frontend too

---

## 5. Bot Types Reference

### Core Order Execution

| Bot | Interval | What It Does |
|---|---|---|
| **FillerBot** | 6s | Fills crossing perp orders via DLOB matching. The primary order execution bot. |
| **FillerLiteBot** | 6s | Lightweight filler using OrderSubscriber (no UserMap). Better for public RPCs. |
| **SpotFillerBot** | 6s | Fills crossing spot orders. Supports external liquidity (Phoenix, Openbook v2). |
| **TriggerBot** | varies | Triggers conditional orders (stop-loss, take-profit) when price conditions are met. |
| **JitMaker** | 30s | Participates in JIT auctions — provides liquidity during the auction window. |
| **FloatingPerpMakerBot** | 5s | Posts limit orders with oracle price offsets for passive market making. |

### Risk Management

| Bot | Interval | What It Does |
|---|---|---|
| **LiquidatorBot** | 5s | Liquidates unhealthy positions. Takes over risk, can derisk via JIT auction. |

### Protocol Maintenance

| Bot | Interval | What It Does |
|---|---|---|
| **FundingRateUpdaterBot** | 2min | Updates perpetual funding rates on the hourly schedule. |
| **UserPnlSettlerBot** | 5s+ | Settles positive/negative PnL to/from the protocol's revenue pool. |
| **IFRevenueSettlerBot** | 10min | Settles insurance fund revenue pool earnings. |
| **UserIdleFlipperBot** | 10min | Marks inactive users as "idle" to free up account slots. |

### Oracle Maintenance

| Bot | Interval | What It Does |
|---|---|---|
| **PythCrankerBot** | 10s+ | Updates Pyth price feeds when prices diverge beyond threshold. |
| **PythLazerCrankerBot** | 2s+ | Updates Pyth Lazer feeds (low-latency push channel). |
| **SwitchboardCrankerBot** | varies | Updates Switchboard oracle feeds. |

### Market Making

| Bot | Interval | What It Does |
|---|---|---|
| **MakerBidAskTwapCrank** | varies | Cranks bid/ask TWAP marks for market makers. |

---

## 6. Fill Flow in Detail

When the **FillerBot** runs its `tryFill()` cycle (every ~6 seconds):

```
Step 1: Check SOL Balance
  └─ Ensure enough SOL for transaction fees

Step 2: Acquire Mutex Lock
  └─ Prevent concurrent fill cycles

Step 3: Get DLOB Snapshot
  └─ dlobSubscriber.getDLOB() → current order book state

Step 4: Prune Throttled Nodes
  └─ Remove orders that failed too many recent fill attempts

Step 5: For Each Perp Market:
  │
  ├─ getPerpNodesForMarket()
  │   ├─ nodesToFill: orders that cross (bid ≥ ask)
  │   └─ nodesToTrigger: conditional orders ready to fire
  │
  ├─ filterPerpNodesForMarket()
  │   ├─ Remove expired orders
  │   ├─ Remove already-attempted orders (backoff: 1000ms)
  │   └─ Remove orders with incompatible market conditions
  │
  └─ Execute (in parallel):
      ├─ executeFillablePerpNodesForMarket()
      │   ├─ Select up to 6 makers per fill (MAX_MAKERS_PER_FILL)
      │   ├─ Build fill instruction via driftClient.getFillPerpOrdersIx()
      │   ├─ Simulate for CU estimate (cuLimitMultiplier: 1.15)
      │   └─ Submit transaction (retry | Jito bundle)
      │
      └─ executeTriggerablePerpNodesForMarket()
          ├─ Build trigger instruction via driftClient.getTriggerOrderIx()
          └─ Submit transaction

Step 6: Record Metrics + Pat Watchdog
```

### Key Constants

| Constant | Value | Purpose |
|---|---|---|
| `FILL_ORDER_THROTTLE_BACKOFF` | 1000ms | Backoff for failed fill attempts |
| `EXPIRE_ORDER_BUFFER_SEC` | 60s | Buffer before considering order expired |
| `MAX_MAKERS_PER_FILL` | 6 | Max maker orders per fill transaction |
| `MAX_ACCOUNTS_PER_TX` | 64 | Solana account limit per transaction |
| `SETTLE_POSITIVE_PNL_COOLDOWN_MS` | 60s | Cooldown between PnL settlements |

### Transaction Sender Types

| Type | Behavior |
|---|---|
| `retry` | Retries failed txs with exponential backoff (default) |
| `while-valid` | Keeps retrying until blockhash expires |
| `fast` | Single attempt, optimized for speed |
| `jet` (Jito) | Submits via Jito bundles for MEV protection |

---

## 7. JIT Maker — Just-In-Time Liquidity

The JIT Maker bot participates in **Dutch auctions** by providing liquidity during the auction window (see [LIQUIDITY.md](./LIQUIDITY.md) Section 4).

### How It Works

1. Uses `JitterSniper` or `JitterShotgun` from `@drift-labs/jit-proxy`
2. Maps one subaccount per market for position isolation
3. Every 30s, evaluates each market:

```
For each market:
  1. Check current position vs target leverage
  2. If over-leveraged (>95% of target) → skip
  3. Get best DLOB bid/ask prices
  4. Get AMM bid/ask prices
  5. Calculate bid/ask offset with aggressiveness (bps)
  6. Update JIT params:
     - maxPosition / minPosition (based on target leverage)
     - bid / ask offsets
     - priceType: LIMIT
     - subAccountId: dedicated per-market
```

### Configuration

```yaml
botConfigs:
  jitMaker:
    marketType: perp
    marketIndexes: [0, 1, 2]
    subaccounts: [1, 2, 3]
    targetLeverage: 1.0
    aggressivenessBps: 5
    jitCULimit: 800000
```

---

## 8. Configuration

### Keeper Bot Config (YAML)

```yaml
global:
  driftEnv: devnet                          # devnet | mainnet-beta
  endpoint: "https://api.devnet.solana.com" # RPC endpoint
  wsEndpoint: "wss://api.devnet.solana.com" # WebSocket endpoint
  keeperPrivateKey: "path/to/keypair.json"  # Wallet keypair
  initUser: true                            # Initialize user account if needed
  websocket: true                           # Use WebSocket for account updates
  subaccounts: [0]                          # Subaccount IDs
  txSenderType: retry                       # retry | while-valid | fast | jet
  priorityFeeMethod: solana                 # solana | helius
  maxPriorityFeeMicroLamports: 1000000

enabledBots:
  - filler
  - trigger
  - liquidator
  - fundingRateUpdater
  - userPnlSettler

botConfigs:
  filler:
    botId: "filler-main"
    fillerPollingInterval: 6000
    revertOnFailure: true
    simulateTxForCUEstimate: true
  liquidator:
    botId: "liquidator-main"
    perpMarketIndicies: [0, 1, 2]
    spotMarketIndicies: [0]
    maxSlippageBps: 50
```

### DLOB Server Config (.env)

```bash
# Network
ENDPOINT=https://api.devnet.solana.com
WS_ENDPOINT=wss://api.devnet.solana.com
ENV=devnet

# Server
PORT=6969
METRICS_PORT=9464
WS_PORT=3000

# Data Subscription
USE_WEBSOCKET=true
USE_ORDER_SUBSCRIBER=true
ORDERBOOK_UPDATE_INTERVAL=400

# Markets
PERP_MARKETS_TO_LOAD=0,1,2
SPOT_MARKETS_TO_LOAD=0

# Redis
ELASTICACHE_HOST=localhost
ELASTICACHE_PORT=6379
REDIS_CLIENT=DLOB

# Optional: gRPC (lower latency)
USE_GRPC=false
GRPC_ENDPOINT=
TOKEN=
```

---

## 9. Deployment Architecture

### Minimum Viable Setup (Dev/Testing)

```
┌─────────────────────────┐
│  DLOB Server (1x)       │  Port 6969 (HTTP), 3000 (WS)
│  - Subscribes via WS    │
│  - Serves L2/L3         │
│  - Requires Redis       │
└────────────┬────────────┘
             │
┌────────────┴────────────┐
│  Redis (1x)             │  Port 6379
│  - Caches order book    │
│  - Pub/sub for updates  │
└────────────┬────────────┘
             │
┌────────────┴────────────┐
│  Keeper Bot (1x)        │  Port 8888 (health), 9464 (metrics)
│  - Filler               │
│  - Trigger              │
│  - Liquidator           │
│  - FundingRateUpdater   │
│  - UserPnlSettler       │
└─────────────────────────┘
```

### Production Setup

```
┌─────────────────┐  ┌─────────────────┐
│ DLOB Server (2x)│  │ ServerLite (Nx) │  ← Read-only cache servers
│ (active/standby)│  │ (for frontends) │
└────────┬────────┘  └────────┬────────┘
         │                    │
         └──────────┬─────────┘
                    │
         ┌──────────┴──────────┐
         │  Redis Cluster      │
         └──────────┬──────────┘
                    │
    ┌───────────────┼───────────────┐
    │               │               │
┌───┴───┐     ┌────┴────┐    ┌────┴────┐
│Filler │     │Liquidator│   │JitMaker │
│Bot    │     │Bot       │   │Bot      │
│(1-2x) │     │(1-2x)   │   │(1x)     │
└───────┘     └─────────┘   └─────────┘
    + Trigger, FundingUpdater, PnlSettler, etc.
```

### Required Infrastructure

| Component | Purpose | Resource |
|---|---|---|
| Solana RPC | Read chain state, submit txs | Dedicated or Helius/Triton |
| Redis | Order book cache, pub/sub | Single instance (dev) or cluster (prod) |
| DLOB Server | Aggregate orders | 1+ instances |
| Keeper Bots | Execute protocol operations | 1+ instances per bot type |
| Monitoring | Prometheus + Grafana | Optional but recommended |

---

*See [LIQUIDITY.md](./LIQUIDITY.md) for how the multi-layered liquidity system works.*
*See [PARAMETERS.md](./PARAMETERS.md) for full parameter reference with precisions and SDK functions.*
