#!/bin/sh
# Deploy custom perp DEX to devnet
# Usage: ADMIN_KEYPAIR=<path> ./deploy-scripts/deploy-devnet.sh

PROGRAM_ID="6prdU12bH7QLTHoNPhA3RF1yzSjrduLQg45JQgCMJ1ko"
ADMIN_KEYPAIR="${ADMIN_KEYPAIR:-./keys/admin-keypair.json}"

echo "Deploying to devnet..."
echo "Program ID: $PROGRAM_ID"
echo "Admin keypair: $ADMIN_KEYPAIR"

# Deploy the program
anchor deploy \
  --program-name drift \
  --program-keypair target/deploy/custom_drift-keypair.json \
  --provider.cluster devnet \
  --provider.wallet "$ADMIN_KEYPAIR"

echo ""
echo "Program deployed! Now run the initialization script:"
echo "  DRIFT_ENV=devnet RPC_ENDPOINT=https://api.devnet.solana.com ADMIN_KEYPAIR_PATH=$ADMIN_KEYPAIR npx ts-node scripts/initialize-protocol.ts"
