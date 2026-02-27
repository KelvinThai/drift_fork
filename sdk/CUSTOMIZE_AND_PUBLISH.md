# Customizing and Publishing the SDK

This guide explains how to update the SDK to match your own on-chain deployment and publish it to npm.

All values referenced here come from `deployments.json` at the root of this repository.

---

## Prerequisites

- Node.js >= 18
- `bun` or `yarn` installed
- An npm account with publish rights to the package scope
- A completed on-chain deployment (program + markets initialized)

---

## Step 1 — Read your `deployments.json`

Your deployment file should look like this after running the deploy scripts:

```json
{
  "program": {
    "id": "<YOUR_PROGRAM_ID>"
  },
  "markets": {
    "perp": [
      { "index": 0, "name": "SOL-PERP",  "oracle": "<ORACLE_PUBKEY>", "oracleSource": "PYTH_PULL" },
      { "index": 1, "name": "BTC-PERP",  "oracle": "<ORACLE_PUBKEY>", "oracleSource": "PYTH_PULL" },
      { "index": 2, "name": "ETH-PERP",  "oracle": "<ORACLE_PUBKEY>", "oracleSource": "PYTH_PULL" }
    ],
    "spot": [
      { "index": 0, "name": "USDC", "mint": "<USDC_MINT>", "oracleSource": "QUOTE_ASSET" }
    ]
  },
  "oracles": {
    "pythReceiver": "<PYTH_RECEIVER_PROGRAM_ID>"
  }
}
```

Identify these 6 values — you will paste them into the SDK:

| Field | JSON path | Used in |
|---|---|---|
| Program ID | `program.id` | `config.ts` (already set at deploy time) |
| Oracle Receiver | `oracles.pythReceiver` | `config.ts` → `DRIFT_ORACLE_RECEIVER_ID` |
| USDC mint | `markets.spot[0].mint` | `config.ts` → devnet `USDC_MINT_ADDRESS` |
| SOL-PERP oracle | `markets.perp[0].oracle` | `perpMarkets.ts` → marketIndex 0 |
| BTC-PERP oracle | `markets.perp[1].oracle` | `perpMarkets.ts` → marketIndex 1 |
| ETH-PERP oracle | `markets.perp[2].oracle` | `perpMarkets.ts` → marketIndex 2 |

---

## Step 2 — Edit `src/config.ts`

Two values to change:

### 2a. Oracle Receiver Program ID

```ts
// Before
export const DRIFT_ORACLE_RECEIVER_ID =
    'G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha';

// After — use oracles.pythReceiver from deployments.json
export const DRIFT_ORACLE_RECEIVER_ID =
    'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
```

### 2b. Devnet USDC Mint

Inside the `configs.devnet` block:

```ts
// Before
USDC_MINT_ADDRESS: '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2',

// After — use markets.spot[0].mint from deployments.json
USDC_MINT_ADDRESS: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
```

> `DRIFT_PROGRAM_ID` on line 46 should already match `program.id` from your deploy.
> If it doesn't, update it there too.

---

## Step 3 — Edit `src/constants/perpMarkets.ts`

Replace the oracle address and source for each market in `DevnetPerpMarkets`.
Also **remove any market entries beyond the ones you actually deployed** — leaving
stale entries causes subscription errors at runtime.

```ts
export const DevnetPerpMarkets: PerpMarketConfig[] = [
    {
        fullName: 'Solana',
        category: ['L1', 'Infra'],
        symbol: 'SOL-PERP',
        baseAssetSymbol: 'SOL',
        marketIndex: 0,
        // use markets.perp[0].oracle from deployments.json
        oracle: new PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE'),
        launchTs: 1655751353000,
        // match markets.perp[0].oracleSource
        oracleSource: OracleSource.PYTH_PULL,
    },
    {
        fullName: 'Bitcoin',
        category: ['L1', 'Payment'],
        symbol: 'BTC-PERP',
        baseAssetSymbol: 'BTC',
        marketIndex: 1,
        oracle: new PublicKey('4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo'),
        launchTs: 1655751353000,
        oracleSource: OracleSource.PYTH_PULL,
    },
    {
        fullName: 'Ethereum',
        category: ['L1', 'Infra'],
        symbol: 'ETH-PERP',
        baseAssetSymbol: 'ETH',
        marketIndex: 2,
        oracle: new PublicKey('42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC'),
        launchTs: 1637691133472,
        oracleSource: OracleSource.PYTH_PULL,
    },
    // Add more entries here only if you initialized more perp markets on-chain
];
```

**Oracle source mapping:**

| `deployments.json` value | TypeScript enum |
|---|---|
| `"PYTH_PULL"` | `OracleSource.PYTH_PULL` |
| `"PYTH_LAZER"` | `OracleSource.PYTH_LAZER` |
| `"SWITCHBOARD"` | `OracleSource.Switchboard` |
| `"SWITCHBOARD_ON_DEMAND"` | `OracleSource.SWITCHBOARD_ON_DEMAND` |

---

## Step 4 — Edit `src/constants/spotMarkets.ts`

Replace `DevnetSpotMarkets` with only the spot markets you initialized.

For a USDC-only deployment with `oracleSource: "QUOTE_ASSET"` (price always = $1,
no external oracle needed), use the system program as the oracle placeholder:

```ts
export const DevnetSpotMarkets: SpotMarketConfig[] = [
    {
        symbol: 'USDC',
        marketIndex: 0,
        poolId: 0,
        // System program — placeholder for QUOTE_ASSET (no real oracle used)
        oracle: new PublicKey('11111111111111111111111111111111'),
        oracleSource: OracleSource.QUOTE_ASSET,
        // use markets.spot[0].mint from deployments.json
        mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        precision: QUOTE_PRECISION,
        precisionExp: QUOTE_PRECISION_EXP,
    },
    // Add more entries here only if you initialized more spot markets on-chain
];
```

---

## Step 5 — Update `package.json`

Set the package name and version before publishing:

```json
{
  "name": "@your-org/drift-sdk",
  "version": "1.0.0"
}
```

- The `name` must match your npm org scope (the org must exist on npm and you must be a member).
- The `publishConfig.access` is already set to `"public"` in this file.

---

## Step 6 — Install, Build, and Publish

```bash
cd sdk/

# Install dependencies
bun install

# Build (compiles node + browser targets)
npm run build

# Log into npm (one-time setup)
npm login

# Publish
npm publish
```

If the build succeeds you will see output like:

```
Running node environment postbuild script
Running browser environment postbuild script
```

And `lib/node/` and `lib/browser/` will be populated.

---

## Quick Reference: `deployments.json` → SDK file mapping

| `deployments.json` field | SDK file | Variable / location |
|---|---|---|
| `program.id` | `src/config.ts:46` | `DRIFT_PROGRAM_ID` |
| `oracles.pythReceiver` | `src/config.ts:47` | `DRIFT_ORACLE_RECEIVER_ID` |
| `markets.spot[0].mint` | `src/config.ts:66` | `configs.devnet.USDC_MINT_ADDRESS` |
| `markets.perp[N].oracle` | `src/constants/perpMarkets.ts` | `DevnetPerpMarkets[N].oracle` |
| `markets.perp[N].oracleSource` | `src/constants/perpMarkets.ts` | `DevnetPerpMarkets[N].oracleSource` |
| `markets.spot[N].mint` | `src/constants/spotMarkets.ts` | `DevnetSpotMarkets[N].mint` |
| `markets.spot[N].oracleSource` | `src/constants/spotMarkets.ts` | `DevnetSpotMarkets[N].oracleSource` |

---

## Adding a New Market Later

1. Initialize the market on-chain with the admin scripts.
2. Add the new entry to `deployments.json` under `markets.perp` or `markets.spot`.
3. Add the corresponding entry to `DevnetPerpMarkets` or `DevnetSpotMarkets` in the SDK.
4. Bump the version in `package.json` (e.g. `1.0.0` → `1.1.0`).
5. Run `npm run build && npm publish`.
