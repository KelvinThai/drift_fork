# Custom Perpetual Futures DEX — Complete Deployment Guide

A step-by-step guide to fork Drift Protocol v2, customize it, build, deploy to Solana devnet, and initialize all markets. This document captures every modification, workaround, and command required for a successful deployment.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Repository Setup](#2-repository-setup)
3. [Generate Keypairs](#3-generate-keypairs)
4. [Customize the Program ID](#4-customize-the-program-id)
5. [Fix Stack Overflow in Anchor 0.29.0](#5-fix-stack-overflow-in-anchor-0290)
6. [Add Pyth Receiver to Oracle Whitelist](#6-add-pyth-receiver-to-oracle-whitelist)
7. [Build the Program](#7-build-the-program)
8. [Build the SDK](#8-build-the-sdk)
9. [Create the Initialization Script](#9-create-the-initialization-script)
10. [Fund the Admin Wallet](#10-fund-the-admin-wallet)
11. [Deploy to Devnet](#11-deploy-to-devnet)
12. [Initialize the Protocol](#12-initialize-the-protocol)
13. [Verify Deployment](#13-verify-deployment)
14. [Troubleshooting](#14-troubleshooting)
15. [Architecture Reference](#15-architecture-reference)

---

## 1. Prerequisites

### Software Versions

| Tool | Version | Notes |
|------|---------|-------|
| Rust | 1.79.0 | **Not latest stable** — Anchor 0.29.0 requires this specific version due to wasm-bindgen compatibility |
| Solana CLI | 1.18.26 | Includes `cargo-build-sbf` and platform-tools |
| Anchor CLI | 0.29.0 | Must match `Anchor.toml` and `Cargo.toml` |
| Node.js | 18+ | For SDK and scripts |
| Yarn | 1.x | Package manager for SDK |

### Install Rust 1.79.0

```bash
rustup install 1.79.0
rustup default 1.79.0
```

### Install Solana CLI

```bash
sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

### Install Anchor CLI

```bash
cargo install --git https://github.com/coral-xyz/anchor --tag v0.29.0 anchor-cli --locked
```

### macOS Specific: C Headers

On macOS, set this environment variable before every build (add to your `.zshrc` or `.bashrc`):

```bash
export C_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include"
```

Without this, the build fails with `assert.h not found` errors from the `blake3` crate.

---

## 2. Repository Setup

### Clone the Repositories

```bash
# Core protocol (smart contracts + SDK)
git clone https://github.com/drift-labs/protocol-v2.git
cd protocol-v2

# Install SDK dependencies
cd sdk && yarn install --ignore-engines && cd ..
```

> **Note:** `--ignore-engines` is required because `pyth-lazer-sdk` has a strict Node.js version constraint.

### Verify Vanilla Build (Optional)

Before making changes, confirm the unmodified code builds:

```bash
export C_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include"
anchor build
```

The "Error: A function call in method ... overwrites values in the frame" messages are **warnings**, not build failures. The build succeeds if you see `Finished release [optimized]` at the end.

---

## 3. Generate Keypairs

You need two keypairs: one for the admin (upgrade authority, fee authority) and one for the program itself.

```bash
mkdir -p keys

# Admin keypair — this is your admin/upgrade authority
solana-keygen new -o keys/admin-keypair.json --no-bip39-passphrase

# Program keypair — determines your program's on-chain address
solana-keygen new -o keys/program-keypair.json --no-bip39-passphrase
```

Note the public keys:

```bash
solana-keygen pubkey keys/admin-keypair.json
# Example output: 7XAMFnYGKtJDqATNycQ6JQ7CwvFazrrtmmwn1UHSLQGr

solana-keygen pubkey keys/program-keypair.json
# Example output: 6prdU12bH7QLTHoNPhA3RF1yzSjrduLQg45JQgCMJ1ko
```

> **CRITICAL:** Store keypairs in `keys/` (not `target/deploy/`). The `target/` directory is wiped by `cargo clean`. Losing the program keypair means you can never upgrade that program.

---

## 4. Customize the Program ID

Replace the original Drift program ID with your new program ID in all files. The original Drift mainnet ID is `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`, and the devnet ID is `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH` as well.

### Files to Update (12 total)

Replace `<YOUR_PROGRAM_ID>` with the pubkey from `keys/program-keypair.json`:

#### 4.1 Smart Contract Entry Point

**`programs/drift/src/lib.rs`** — Both `declare_id!` macros (mainnet-beta and non-mainnet-beta):

```rust
#[cfg(feature = "mainnet-beta")]
declare_id!("<YOUR_PROGRAM_ID>");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("<YOUR_PROGRAM_ID>");
```

#### 4.2 Anchor Configuration

**`Anchor.toml`** — All three network sections:

```toml
[programs.localnet]
drift = "<YOUR_PROGRAM_ID>"

[programs.devnet]
drift = "<YOUR_PROGRAM_ID>"

[programs.mainnet]
drift = "<YOUR_PROGRAM_ID>"
```

#### 4.3 SDK Configuration

**`sdk/src/config.ts`** — The exported constant:

```typescript
export const DRIFT_PROGRAM_ID = '<YOUR_PROGRAM_ID>';
```

#### 4.4 SDK Event Parsing

**`sdk/src/events/parse.ts`** — The `driftProgramId` constant at line 4:

```typescript
const driftProgramId = '<YOUR_PROGRAM_ID>';
```

**`sdk/src/events/eventsServerLogProvider.ts`** — Two hardcoded references in the callback (lines 85, 87):

```typescript
'Program <YOUR_PROGRAM_ID> invoke [1]',
// ...
'Program <YOUR_PROGRAM_ID> success',
```

#### 4.5 Operational Files

**`deploy-scripts/deploy-devnet.sh`**:

```bash
PROGRAM_ID="<YOUR_PROGRAM_ID>"
```

**`OPERATIONS.md`** — Update the Program ID field.

#### 4.6 Test Files (5 files)

These files contain the program ID in test fixtures:

- `programs/drift/src/state/order_params/tests.rs`
- `programs/drift/src/math/orders/tests.rs`
- `programs/drift/src/controller/spot_balance/tests.rs`
- `programs/drift/src/controller/position/tests.rs`
- `programs/drift/src/controller/liquidation/tests.rs`

### Quick Replacement Command

Use `grep` + `sed` or your editor's find-and-replace to do all 12 files at once:

```bash
# Find all occurrences
grep -r "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH" --include="*.rs" --include="*.ts" --include="*.toml" --include="*.md" --include="*.sh" .

# Replace (macOS sed)
find . -type f \( -name "*.rs" -o -name "*.ts" -o -name "*.toml" -o -name "*.md" -o -name "*.sh" \) \
  -exec sed -i '' 's/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH/<YOUR_PROGRAM_ID>/g' {} +
```

---

## 5. Fix Stack Overflow in Anchor 0.29.0

### The Problem

Anchor 0.29.0 combined with Solana platform-tools v1.41 (bundled with Solana CLI 1.18.x) generates `try_accounts` methods that exceed the **4,096-byte SBF stack frame limit**. The affected instructions are:

- `InitializeSpotMarket` — 4,792 bytes (696 over the limit)
- `InitializePerpMarket` — fixed by compiler optimization flag alone
- `InitializeLpPool` / `InitializeConstituent` — still overflow but **not needed** for basic perp DEX operation

When these instructions are called on-chain, they produce:
```
Access violation in stack frame 9 at address 0x200009ff8
```

### The Fix (Two Parts)

#### Part A: Compiler Optimization Flag

Add `RUSTFLAGS="-C opt-level=z"` to the build command. This optimizes for binary size, which as a side effect reduces stack usage enough to fix `InitializePerpMarket`.

#### Part B: Refactor InitializeSpotMarket Account Struct

The `InitializeSpotMarket` struct originally had two `init` constraints for `spot_market_vault` and `insurance_fund_vault`. Anchor's generated code for `init` constraints creates PDA accounts inside `try_accounts`, which inflates the stack frame. The fix moves account creation into the handler function using a separate `#[inline(never)]` helper.

**File: `programs/drift/src/instructions/admin.rs`**

**Step 1:** Change the two `init` constraints to plain `#[account(mut)]` with safety CHECK comments:

Before (original):
```rust
#[derive(Accounts)]
pub struct InitializeSpotMarket<'info> {
    // ... other accounts ...
    #[account(
        init,
        seeds = [b"spot_market_vault".as_ref(), state.number_of_spot_markets.to_le_bytes().as_ref()],
        space = get_vault_len(&spot_market_mint)?,
        bump,
        payer = admin,
        token::mint = spot_market_mint,
        token::authority = drift_signer,
        token::token_program = token_program,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        seeds = [b"insurance_fund_vault".as_ref(), state.number_of_spot_markets.to_le_bytes().as_ref()],
        space = get_vault_len(&spot_market_mint)?,
        bump,
        payer = admin,
        token::mint = spot_market_mint,
        token::authority = drift_signer,
        token::token_program = token_program,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    // ... other accounts ...
}
```

After (fixed):
```rust
#[derive(Accounts)]
pub struct InitializeSpotMarket<'info> {
    // ... other accounts ...
    #[account(mut)]
    /// CHECK: created via CPI in handler to reduce stack usage
    pub spot_market_vault: AccountInfo<'info>,
    #[account(mut)]
    /// CHECK: created via CPI in handler to reduce stack usage
    pub insurance_fund_vault: AccountInfo<'info>,
    // ... other accounts ...
}
```

**Step 2:** Add the `create_pda_account` helper function (place it before `handle_initialize_spot_market`):

```rust
/// Create a PDA account via CPI to system program (separate function to isolate stack frame)
#[inline(never)]
fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    space: usize,
    owner: &Pubkey,
    system_program: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);
    let ix = anchor_lang::solana_program::system_instruction::create_account(
        payer.key,
        target.key,
        lamports,
        space as u64,
        owner,
    );
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[payer.clone(), target.clone(), system_program.clone()],
        &[seeds],
    )?;
    Ok(())
}
```

**Step 3:** At the beginning of `handle_initialize_spot_market`, create the vault accounts via CPI before they are used:

```rust
pub fn handle_initialize_spot_market(
    ctx: Context<InitializeSpotMarket>,
    // ... parameters ...
) -> Result<()> {
    let state = &mut ctx.accounts.state;
    let spot_market_pubkey = ctx.accounts.spot_market.key();

    // Create vault accounts via CPI (moved out of Anchor init to reduce stack in try_accounts)
    let market_index_bytes = state.number_of_spot_markets.to_le_bytes();
    let vault_space = get_vault_len(&ctx.accounts.spot_market_mint)?;
    let token_program_id = ctx.accounts.token_program.key();

    {
        let (_, vault_bump) = Pubkey::find_program_address(
            &[b"spot_market_vault", &market_index_bytes],
            ctx.program_id,
        );
        create_pda_account(
            &ctx.accounts.admin.to_account_info(),
            &ctx.accounts.spot_market_vault,
            vault_space,
            &token_program_id,
            &ctx.accounts.system_program.to_account_info(),
            &[b"spot_market_vault", &market_index_bytes, &[vault_bump]],
        )?;
    }

    {
        let (_, if_vault_bump) = Pubkey::find_program_address(
            &[b"insurance_fund_vault", &market_index_bytes],
            ctx.program_id,
        );
        create_pda_account(
            &ctx.accounts.admin.to_account_info(),
            &ctx.accounts.insurance_fund_vault,
            vault_space,
            &token_program_id,
            &ctx.accounts.system_program.to_account_info(),
            &[b"insurance_fund_vault", &market_index_bytes, &[if_vault_bump]],
        )?;
    }

    // ... rest of handler (initialize_token_account calls, etc.) ...
```

---

## 6. Add Pyth Receiver to Oracle Whitelist

### The Problem

Drift's oracle whitelist only recognizes 4 oracle program owners. The new Pyth push feed accounts on devnet (PriceUpdateV2 format) are owned by the **Pyth Solana Receiver** program (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`), which is not in the original whitelist. Without this, perp market initialization fails with `InvalidOracle` (Error 6035).

### Background: Pyth Oracle Migration

Pyth Network deprecated legacy V1 push oracles (owned by `gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s`) as of June 30, 2024. The legacy addresses still exist on-chain but their price data is **stale/frozen**. The replacement is:

- **New Pyth Push Feeds**: Use `PriceUpdateV2` account format, actively updated
- **Owner program**: `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` (Pyth Solana Receiver)
- **Oracle source**: `OracleSource::PythPull` (reads PriceUpdateV2 format)

### The Fix

#### Step 1: Add Pyth Receiver program ID to `ids.rs`

**File: `programs/drift/src/ids.rs`**

Add after the `drift_oracle_receiver_program` module:

```rust
pub mod pyth_receiver_program {
    use solana_program::declare_id;
    declare_id!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
}
```

#### Step 2: Add to oracle whitelist in `oracle_map.rs`

**File: `programs/drift/src/state/oracle_map.rs`**

Update the import:
```rust
use crate::ids::{
    drift_oracle_receiver_program, pyth_program, pyth_receiver_program, switchboard_on_demand,
    switchboard_program,
};
```

Expand the whitelist array from 4 to 5:
```rust
const EXTERNAL_ORACLE_PROGRAM_IDS: [Pubkey; 5] = [
    pyth_program::id(),
    drift_oracle_receiver_program::id(),
    switchboard_program::id(),
    switchboard_on_demand::id(),
    pyth_receiver_program::id(),
];
```

### Pyth Devnet Push Feed Addresses

These are the current (as of Feb 2026) Pyth push feed accounts on Solana devnet:

| Pair | Address | Owner |
|------|---------|-------|
| SOL/USD | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` |
| BTC/USD | `4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo` | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` |
| ETH/USD | `42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC` | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` |

These addresses are PDAs derived from program `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT` with seeds `[shard_id (u16 LE = 0x0000), feed_id (32 bytes)]`.

Feed IDs (hex):
- SOL/USD: `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`
- BTC/USD: `e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43`
- ETH/USD: `ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace`

You can find additional feed IDs via the Pyth Hermes API:
```bash
curl -s "https://hermes.pyth.network/v2/price_feeds?query=SOL&asset_type=crypto" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for d in data:
    if d['attributes'].get('symbol') == 'Crypto.SOL/USD':
        print(f'0x{d[\"id\"]}')"
```

---

## 7. Build the Program

### Build Command

```bash
export C_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include"

RUSTFLAGS="-C opt-level=z" cargo build-sbf \
  --manifest-path programs/drift/Cargo.toml \
  --tools-version v1.42 \
  --arch sbfv1 \
  --sbf-out-dir target/deploy
```

### Explanation of Flags

| Flag | Purpose |
|------|---------|
| `RUSTFLAGS="-C opt-level=z"` | Optimize for size. Reduces stack frame sizes enough to fix `InitializePerpMarket` overflow |
| `--tools-version v1.42` | Uses newer platform-tools with slightly better code generation |
| `--arch sbfv1` | Target SBF v1 (devnet/mainnet compatible). SBF v2 has 8KB+ stack frames but is not yet enabled on any cluster |
| `--sbf-out-dir target/deploy` | Output the `.so` file to `target/deploy/drift.so` |

### Expected Output

You will see warning messages like:
```
Error: A function call in method ...InitializeConstituent...try_accounts... overwrites values in the frame.
```

These are **warnings for functions we don't use** (LP Pool features). The build succeeds if you see:
```
Finished release [optimized] target(s) in X.XXs
```

The output binary is at `target/deploy/drift.so` (~5.5 MB).

### Why Not Use `anchor build`?

`anchor build` does not support the `--tools-version` or `RUSTFLAGS` flags needed for the stack overflow fix. We call `cargo build-sbf` directly.

---

## 8. Build the SDK

```bash
cd sdk
yarn install --ignore-engines
yarn build
cd ..
```

The SDK must be rebuilt after changing the program ID in `sdk/src/config.ts`. The `--ignore-engines` flag is required due to the `pyth-lazer-sdk` Node.js version constraint.

---

## 9. Create the Initialization Script

Create **`scripts/initialize-protocol.ts`**:

```typescript
import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	AdminClient,
	BASE_PRECISION,
	BulkAccountLoader,
	initialize,
	OracleSource,
	PEG_PRECISION,
	PRICE_PRECISION,
	ZERO,
	ContractTier,
} from '../sdk/src';
import fs from 'fs';

// ============================================================================
// CONFIGURATION — Edit these values for your deployment
// ============================================================================

const ENV = (process.env.DRIFT_ENV || 'devnet') as 'devnet' | 'mainnet-beta';
const RPC_ENDPOINT =
	process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com';
const ADMIN_KEYPAIR_PATH =
	process.env.ADMIN_KEYPAIR_PATH || './keys/admin-keypair.json';

// USDC mint address (devnet faucet USDC or mainnet USDC)
const USDC_MINT =
	ENV === 'devnet'
		? new PublicKey('8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2') // devnet USDC
		: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // mainnet USDC

// Pyth oracle feed addresses
// Devnet: New Pyth push feed accounts (PriceUpdateV2 format)
const PYTH_ORACLES = {
	devnet: {
		'SOL-USD': new PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE'),
		'BTC-USD': new PublicKey('4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo'),
		'ETH-USD': new PublicKey('42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC'),
	},
	'mainnet-beta': {
		'SOL-USD': new PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE'),
		'BTC-USD': new PublicKey('4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo'),
		'ETH-USD': new PublicKey('42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC'),
	},
};

// Market parameters
const AMM_INITIAL_BASE_ASSET_AMOUNT = new BN(1_000).mul(BASE_PRECISION);
const AMM_INITIAL_QUOTE_ASSET_AMOUNT = new BN(1_000).mul(BASE_PRECISION);
const PERIODICITY = new BN(3600); // 1 hour funding period

// ============================================================================
// INITIALIZATION LOGIC
// ============================================================================

async function main() {
	console.log(`\n=== Custom Perp DEX — Protocol Initialization ===`);
	console.log(`Environment: ${ENV}`);
	console.log(`RPC: ${RPC_ENDPOINT}`);
	console.log('');

	// Load admin keypair
	const adminKeypairData = JSON.parse(
		fs.readFileSync(ADMIN_KEYPAIR_PATH, 'utf-8')
	);
	const adminKeypair = Keypair.fromSecretKey(
		Uint8Array.from(adminKeypairData)
	);
	console.log(`Admin pubkey: ${adminKeypair.publicKey.toBase58()}`);

	// Set up connection and wallet
	const connection = new Connection(RPC_ENDPOINT, 'confirmed');
	const wallet = new anchor.Wallet(adminKeypair);

	// Initialize SDK config
	const sdkConfig = initialize({ env: ENV });
	console.log(`Program ID: ${sdkConfig.DRIFT_PROGRAM_ID}`);

	// Create AdminClient
	const adminClient = new AdminClient({
		connection,
		wallet,
		programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
		opts: {
			commitment: 'confirmed',
			preflightCommitment: 'confirmed',
		},
		activeSubAccountId: 0,
		accountSubscription: {
			type: 'polling',
			accountLoader: new BulkAccountLoader(connection, 'confirmed', 1000),
		},
	});

	// ----------------------------------------------------------------
	// Step 1: Initialize Protocol State
	// ----------------------------------------------------------------
	console.log('\n--- Step 1: Initializing Protocol State ---');
	try {
		const [txSig] = await adminClient.initialize(USDC_MINT, true);
		console.log(`  Protocol initialized. Tx: ${txSig}`);
	} catch (e: any) {
		if (e.message?.includes('already initialized')) {
			console.log('  Protocol already initialized, skipping.');
		} else {
			throw e;
		}
	}

	await adminClient.subscribe();

	// ----------------------------------------------------------------
	// Step 2: Initialize Spot Market (USDC as quote asset, index 0)
	// ----------------------------------------------------------------
	console.log('\n--- Step 2: Initializing USDC Spot Market ---');
	try {
		const txSig = await adminClient.initializeSpotMarket(
			USDC_MINT,
			700000, // optimalUtilization (70%)
			200000, // optimalRate (20%)
			3286000, // maxRate (328.6%)
			PublicKey.default, // USDC oracle (quote asset uses default)
			OracleSource.QUOTE_ASSET,
			10000, // initialAssetWeight (1.0)
			10000, // maintenanceAssetWeight (1.0)
			10000, // initialLiabilityWeight (1.0)
			10000, // maintenanceLiabilityWeight (1.0)
			0, // imfFactor
			0, // liquidatorFee
			0 // ifLiquidationFee
		);
		console.log(`  USDC spot market initialized. Tx: ${txSig}`);
	} catch (e: any) {
		console.log(`  USDC spot market init error: ${e.message}`);
		if (e.logs) console.log('  Logs:', e.logs.join('\n  '));
	}

	// ----------------------------------------------------------------
	// Step 3: Initialize Perp Markets
	// ----------------------------------------------------------------
	const oracles = PYTH_ORACLES[ENV];

	const perpMarkets = [
		{
			name: 'SOL-PERP',
			index: 0,
			oracle: oracles['SOL-USD'],
			pegMultiplier: new BN(150).mul(PEG_PRECISION), // ~$150
			contractTier: ContractTier.A,
			marginRatioInitial: 1000, // 10x max leverage
			marginRatioMaintenance: 500,
		},
		{
			name: 'BTC-PERP',
			index: 1,
			oracle: oracles['BTC-USD'],
			pegMultiplier: new BN(95000).mul(PEG_PRECISION), // ~$95,000
			contractTier: ContractTier.A,
			marginRatioInitial: 1000, // 10x max leverage
			marginRatioMaintenance: 500,
		},
		{
			name: 'ETH-PERP',
			index: 2,
			oracle: oracles['ETH-USD'],
			pegMultiplier: new BN(3500).mul(PEG_PRECISION), // ~$3,500
			contractTier: ContractTier.A,
			marginRatioInitial: 1000, // 10x max leverage
			marginRatioMaintenance: 500,
		},
	];

	console.log('\n--- Step 3: Initializing Perp Markets ---');
	for (const market of perpMarkets) {
		try {
			const txSig = await adminClient.initializePerpMarket(
				market.index,
				market.oracle,
				AMM_INITIAL_BASE_ASSET_AMOUNT,
				AMM_INITIAL_QUOTE_ASSET_AMOUNT,
				PERIODICITY,
				market.pegMultiplier,
				OracleSource.PYTH_PULL, // Must use PYTH_PULL for PriceUpdateV2 accounts
				market.contractTier,
				market.marginRatioInitial,
				market.marginRatioMaintenance,
				0, // liquidatorFee
				10000, // ifLiquidatorFee
				0, // imfFactor
				true, // activeStatus
				0, // baseSpread
				50000, // maxSpread (must be < marginRatioInitial * 100)
				ZERO, // maxOpenInterest
				ZERO, // maxRevenueWithdrawPerPeriod
				ZERO, // quoteMaxInsurance
				BASE_PRECISION.divn(10000), // orderStepSize
				PRICE_PRECISION.divn(100000), // orderTickSize
				BASE_PRECISION.divn(10000), // minOrderSize
			);
			console.log(`  ${market.name} initialized. Tx: ${txSig}`);
		} catch (e: any) {
			console.log(`  ${market.name} error: ${e.message}`);
			if (e.logs) console.log('  Logs:', e.logs.join('\n  '));
		}
	}

	// ----------------------------------------------------------------
	// Step 4: Set Protocol Parameters
	// ----------------------------------------------------------------
	console.log('\n--- Step 4: Setting Protocol Parameters ---');
	try {
		await adminClient.updatePerpAuctionDuration(10); // 10 slots
		console.log('  Perp auction duration set to 10 slots');
	} catch (e: any) {
		console.log(`  Auction duration: ${e.message?.slice(0, 100)}`);
	}

	// ----------------------------------------------------------------
	// Done
	// ----------------------------------------------------------------
	console.log('\n=== Protocol Initialization Complete ===\n');

	const state = adminClient.getStateAccount();
	console.log(`Admin: ${state.admin.toBase58()}`);
	console.log(`Number of perp markets: ${state.numberOfMarkets}`);
	console.log(`Number of spot markets: ${state.numberOfSpotMarkets}`);

	await adminClient.unsubscribe();
}

main().catch((err) => {
	console.error('Initialization failed:', err);
	process.exit(1);
});
```

### Key Configuration Notes

| Parameter | Value | Explanation |
|-----------|-------|-------------|
| `OracleSource.PYTH_PULL` | Required | Reads PriceUpdateV2 account format used by new Pyth push feeds |
| `maxSpread` | 50000 | Must be less than `marginRatioInitial * 100` (= 100000). Setting it to 142500 causes `InvalidMarginRatio` |
| `marginRatioInitial` | 1000 | 10% = 10x max leverage. Stored internally as 100000 |
| `marginRatioMaintenance` | 500 | 5% = 20x maintenance leverage |
| `USDC_MINT` (devnet) | `8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2` | Devnet USDC faucet mint |
| Perp market indices | Must be sequential starting from 0 | Index 1 fails if index 0 doesn't exist yet |

---

## 10. Fund the Admin Wallet

Program deployment on Solana requires **rent** for the program data account. For a ~5.5 MB program, you need approximately **39 SOL** for rent (returned if you ever close the program) plus SOL for transaction fees.

**Recommended minimum: 45 SOL**

### Devnet

```bash
# Set config to devnet
solana config set --url devnet

# Try the faucet (rate limited — may fail)
solana airdrop 5 --keypair keys/admin-keypair.json

# If faucet is rate limited, send SOL manually from another wallet:
echo "Send SOL to: $(solana-keygen pubkey keys/admin-keypair.json)"
```

### Check Balance

```bash
solana balance --keypair keys/admin-keypair.json --url devnet
```

---

## 11. Deploy to Devnet

```bash
solana program deploy target/deploy/drift.so \
  --url devnet \
  --keypair keys/admin-keypair.json \
  --program-id keys/program-keypair.json \
  --with-compute-unit-price 10000
```

### Flags Explained

| Flag | Purpose |
|------|---------|
| `--keypair` | The payer and upgrade authority |
| `--program-id` | The program keypair file (determines the on-chain address) |
| `--with-compute-unit-price 10000` | Priority fee to avoid transaction drops during devnet congestion |

### Expected Output

```
Program Id: 6prdU12bH7QLTHoNPhA3RF1yzSjrduLQg45JQgCMJ1ko
```

### Verify Deployment

```bash
solana program show <YOUR_PROGRAM_ID> --url devnet
```

Expected:
```
Program Id: 6prdU12bH7QLTHoNPhA3RF1yzSjrduLQg45JQgCMJ1ko
Owner: BPFLoaderUpgradeab1e11111111111111111111111
Authority: 7XAMFnYGKtJDqATNycQ6JQ7CwvFazrrtmmwn1UHSLQGr
Data Length: 5580240 bytes
Balance: 38.83967448 SOL
```

---

## 12. Initialize the Protocol

```bash
DRIFT_ENV=devnet \
RPC_ENDPOINT=https://api.devnet.solana.com \
ADMIN_KEYPAIR_PATH=./keys/admin-keypair.json \
npx ts-node --transpile-only scripts/initialize-protocol.ts
```

> **Note:** `--transpile-only` skips TypeScript type checking. This avoids errors in files like `tokenFaucet.ts` that we don't use but are part of the project.

### Expected Output

```
=== Custom Perp DEX — Protocol Initialization ===
Environment: devnet
RPC: https://api.devnet.solana.com

Admin pubkey: 7XAMFnYGKtJDqATNycQ6JQ7CwvFazrrtmmwn1UHSLQGr
Program ID: 6prdU12bH7QLTHoNPhA3RF1yzSjrduLQg45JQgCMJ1ko

--- Step 1: Initializing Protocol State ---
  Protocol initialized. Tx: 1vJwaTCm...

--- Step 2: Initializing USDC Spot Market ---
  USDC spot market initialized. Tx: 511pBJv4...

--- Step 3: Initializing Perp Markets ---
  SOL-PERP initialized. Tx: 61cY8c1e...
  BTC-PERP initialized. Tx: 2c9AtY3s...
  ETH-PERP initialized. Tx: 4oDxTifL...

--- Step 4: Setting Protocol Parameters ---
  Perp auction duration set to 10 slots

=== Protocol Initialization Complete ===

Admin: 7XAMFnYGKtJDqATNycQ6JQ7CwvFazrrtmmwn1UHSLQGr
Number of perp markets: 3
Number of spot markets: 2
```

The script is **idempotent** — running it again skips already-initialized components.

---

## 13. Verify Deployment

### Check Program On-Chain

```bash
solana program show <YOUR_PROGRAM_ID> --url devnet
```

### Check Accounts Created

The initialization creates these on-chain accounts (all PDAs derived from your program ID):

| Account | PDA Seeds | Purpose |
|---------|-----------|---------|
| State | `["drift_state"]` | Protocol global state |
| Spot Market 0 | `["spot_market", 0u16]` | USDC quote asset market |
| Spot Market Vault 0 | `["spot_market_vault", 0u16]` | USDC vault |
| Insurance Fund Vault 0 | `["insurance_fund_vault", 0u16]` | Insurance fund |
| Perp Market 0 | `["perp_market", 0u16]` | SOL-PERP |
| Perp Market 1 | `["perp_market", 1u16]` | BTC-PERP |
| Perp Market 2 | `["perp_market", 2u16]` | ETH-PERP |

---

## 14. Troubleshooting

### Build Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `assert.h not found` / `blake3` error | Missing C headers on macOS | Set `C_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include"` |
| `wasm-bindgen` version conflict | Wrong Rust version | Use `rustup default 1.79.0` |
| Stack overflow warnings for `InitializeConstituent` | LP Pool feature — not used | Safe to ignore. These functions are never called for basic perp DEX |

### Deployment Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `insufficient funds for spend (38.84 SOL)` | Not enough SOL for program buffer rent | Need ~45 SOL total. Buffer rent is returned after deploy |
| `158 write transactions failed` | Devnet congestion | Use `--with-compute-unit-price 10000` flag |
| `Program has been closed, use a new Program Id` | Attempted to redeploy to a closed program address | Generate a new keypair. **Closing a program is permanent** |

### Initialization Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `InvalidOracle` (Error 6035) | Oracle account owner not in whitelist | Add `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` to `EXTERNAL_ORACLE_PROGRAM_IDS` (see Section 6) |
| `InvalidOracle` with legacy Pyth addresses | Legacy Pyth V1 oracles are deprecated/stale | Use new Pyth push feed addresses (see Section 6) with `OracleSource.PYTH_PULL` |
| `InvalidMarginRatio` (Error 6073) | `maxSpread` exceeds `marginRatioInitial * 100` | Lower `maxSpread` to be less than margin ratio. e.g., `50000` < `100000` |
| `ConstraintSeeds` (Error 2006) on market index > 0 | Previous market index failed to initialize | Perp markets must be initialized sequentially from index 0. Fix index 0 first |
| `Access violation in stack frame 9 at address 0x200009ff8` | Stack overflow in Anchor-generated `try_accounts` | Apply the stack overflow fix (see Section 5) |
| `already initialized` on Step 1 | Protocol state already exists | Safe to ignore — script skips it |

### Upgrading a Deployed Program

To upgrade after making code changes:

```bash
# Rebuild
export C_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include"
RUSTFLAGS="-C opt-level=z" cargo build-sbf \
  --manifest-path programs/drift/Cargo.toml \
  --tools-version v1.42 --arch sbfv1 --sbf-out-dir target/deploy

# Upgrade (requires ~39 SOL buffer temporarily — returned after upgrade)
solana program deploy target/deploy/drift.so \
  --url devnet \
  --keypair keys/admin-keypair.json \
  --program-id <YOUR_PROGRAM_ID> \
  --with-compute-unit-price 10000
```

> **Note:** Upgrading requires enough SOL for a temporary buffer account (~39 SOL). This is in addition to the SOL already locked in the existing program. The buffer rent is returned after the upgrade completes. If you don't have enough, you must either fund the wallet with more SOL, or close the program (losing the address permanently) and redeploy fresh.

---

## 15. Architecture Reference

### Program Dependencies

```
Anchor.toml
├── anchor-lang = "0.29.0"
├── solana-program = "1.16"
├── anchor-spl = "0.29.0"
├── pyth-client = "0.2.2"
├── pyth-solana-receiver-sdk (git, drift-labs fork)
└── pyth-lazer-solana-contract (git, drift-labs fork)
```

### Key Source Files

```
programs/drift/src/
├── lib.rs                          # Entry point, declare_id!
├── ids.rs                          # External program IDs (Pyth, Switchboard, etc.)
├── instructions/
│   └── admin.rs                    # All initialization handlers + account structs
├── state/
│   ├── oracle.rs                   # Oracle price reading (get_pyth_price, etc.)
│   ├── oracle_map.rs               # Oracle whitelist (EXTERNAL_ORACLE_PROGRAM_IDS)
│   ├── state.rs                    # Protocol State account, FeeStructure
│   ├── perp_market.rs              # PerpMarket account definition
│   └── spot_market.rs              # SpotMarket account definition
└── math/
    └── fees.rs                     # Fee calculation logic

sdk/src/
├── config.ts                       # DRIFT_PROGRAM_ID constant
├── events/
│   ├── parse.ts                    # Log parsing (hardcoded program ID)
│   └── eventsServerLogProvider.ts  # WebSocket event provider (hardcoded program ID)
└── types.ts                        # OracleSource enum definition

scripts/
└── initialize-protocol.ts          # Protocol initialization script

keys/
├── admin-keypair.json              # Admin / upgrade authority
└── program-keypair.json            # Program keypair (determines on-chain address)
```

### Fee Structure (Default)

| Tier | Taker Fee | Maker Rebate |
|------|-----------|-------------|
| 0 (default) | 5 bps | -2 bps |
| 1 | 4.5 bps | -2 bps |
| 2 | 4 bps | -2 bps |
| 3 | 3.5 bps | -2 bps |
| 4 | 3 bps | -2 bps |
| 5 | 2.5 bps | -2 bps |

### Market Configuration

| Index | Market | Oracle Source | Oracle Address |
|-------|--------|-------------|----------------|
| Spot 0 | USDC | QUOTE_ASSET | `11111111111111111111111111111111` (default) |
| Perp 0 | SOL-PERP | PYTH_PULL | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |
| Perp 1 | BTC-PERP | PYTH_PULL | `4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo` |
| Perp 2 | ETH-PERP | PYTH_PULL | `42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC` |

---

## Quick Reference: Complete Command Sequence

```bash
# 1. Set environment
export C_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include"
cd protocol-v2

# 2. Generate keypairs (only once)
mkdir -p keys
solana-keygen new -o keys/admin-keypair.json --no-bip39-passphrase
solana-keygen new -o keys/program-keypair.json --no-bip39-passphrase

# 3. Update program ID in all 12 files (see Section 4)
# ...

# 4. Apply stack overflow fix (see Section 5)
# 5. Add Pyth receiver to oracle whitelist (see Section 6)
# ...

# 6. Build program
RUSTFLAGS="-C opt-level=z" cargo build-sbf \
  --manifest-path programs/drift/Cargo.toml \
  --tools-version v1.42 --arch sbfv1 --sbf-out-dir target/deploy

# 7. Build SDK
cd sdk && yarn install --ignore-engines && yarn build && cd ..

# 8. Fund admin wallet (need ~45 SOL)
solana config set --url devnet
solana airdrop 5 --keypair keys/admin-keypair.json  # or send manually

# 9. Deploy
solana program deploy target/deploy/drift.so \
  --url devnet \
  --keypair keys/admin-keypair.json \
  --program-id keys/program-keypair.json \
  --with-compute-unit-price 10000

# 10. Initialize protocol + markets
DRIFT_ENV=devnet \
RPC_ENDPOINT=https://api.devnet.solana.com \
ADMIN_KEYPAIR_PATH=./keys/admin-keypair.json \
npx ts-node --transpile-only scripts/initialize-protocol.ts
```
