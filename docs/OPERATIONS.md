# Custom Perp DEX — Operations Guide

## Program Details
- **Program ID**: `6prdU12bH7QLTHoNPhA3RF1yzSjrduLQg45JQgCMJ1ko`
- **Admin Pubkey**: `7XAMFnYGKtJDqATNycQ6JQ7CwvFazrrtmmwn1UHSLQGr`
- **Keypairs**: `./keys/admin-keypair.json`, `./target/deploy/custom_drift-keypair.json`

## Fee Structure
| Tier | Taker Fee | Maker Rebate |
|------|-----------|--------------|
| 0 (default) | 5 bps | -2 bps |
| 1 | 4.5 bps | -2 bps |
| 2 | 4 bps | -2 bps |
| 3 | 3.5 bps | -2 bps |
| 4 | 3 bps | -2 bps |
| 5 | 2.5 bps | -2 bps |

## Markets
| Index | Market | Oracle Source |
|-------|--------|-------------|
| 0 | SOL-PERP | Pyth |
| 1 | BTC-PERP | Pyth |
| 2 | ETH-PERP | Pyth |

## Deployment Steps

### 1. Build
```bash
export C_INCLUDE_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include"
anchor build
cd sdk && yarn install --ignore-engines && yarn build && cd ..
```

### 2. Deploy to Devnet
```bash
# Fund admin wallet
solana config set --url devnet
solana airdrop 5 --keypair keys/admin-keypair.json

# Deploy program
bash deploy-scripts/deploy-devnet.sh

# Initialize protocol + markets
DRIFT_ENV=devnet \
RPC_ENDPOINT=https://api.devnet.solana.com \
ADMIN_KEYPAIR_PATH=./keys/admin-keypair.json \
npx ts-node scripts/initialize-protocol.ts
```

### 3. Start DLOB Server
```bash
cd ../dlob-server
cp .env.custom .env
yarn install && yarn start
```

### 4. Start Keeper Bots
```bash
cd ../keeper-bots-v2
# Fund bot wallet with SOL + USDC
export KEEPER_PRIVATE_KEY=$(cat /path/to/bot-wallet.json)
yarn install && yarn start --config custom-dex.config.yaml
```

### 5. Start Gateway (Optional)
```bash
cd ../gateway
cargo build --release
./target/release/gateway --rpc https://api.devnet.solana.com --dev
```

## Required Environment Variables
| Variable | Description |
|----------|-------------|
| `DRIFT_ENV` | `devnet` or `mainnet-beta` |
| `RPC_ENDPOINT` | Solana RPC URL |
| `ADMIN_KEYPAIR_PATH` | Path to admin keypair JSON |
| `KEEPER_PRIVATE_KEY` | Bot wallet private key (JSON array) |
