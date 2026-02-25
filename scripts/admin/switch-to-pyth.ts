import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	AdminClient,
	BulkAccountLoader,
	initialize,
	OracleSource,
} from '../../sdk/src';
import fs from 'fs';

// ============================================================================
// CONFIGURATION
// ============================================================================

const ENV = 'devnet' as const;
const RPC_ENDPOINT =
	process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com';
const ADMIN_KEYPAIR_PATH =
	process.env.ADMIN_KEYPAIR_PATH || './keys/admin-keypair.json';

// Pyth PriceUpdateV2 push-feed addresses (original oracles)
const MARKETS = [
	{
		index: 0,
		name: 'SOL-PERP',
		pythOracle: new PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE'),
	},
	{
		index: 1,
		name: 'BTC-PERP',
		pythOracle: new PublicKey('4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo'),
	},
	{
		index: 2,
		name: 'ETH-PERP',
		pythOracle: new PublicKey('42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC'),
	},
];

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Decode a Pyth PriceUpdateV2 account to get the price.
 * Format: 8-byte discriminator, then PriceUpdateV2 struct.
 * The price is in the PriceFeed -> PriceRecord -> price field.
 *
 * PriceUpdateV2 layout (after 8-byte discriminator):
 *   write_authority: Pubkey (32 bytes)         offset 8
 *   verification_level: u8 (1 byte)            offset 40
 *   padding: [u8; 3] (3 bytes)                 offset 41
 *   price_message:                              offset 44
 *     feed_id: [u8; 32]                           offset 44
 *     price: i64                                  offset 76
 *     conf: u64                                   offset 84
 *     exponent: i32                               offset 92
 *     publish_time: i64                           offset 96
 *     prev_publish_time: i64                      offset 104
 *     ema_price: i64                              offset 112
 *     ema_conf: u64                               offset 120
 *   posted_slot: u64                            offset 128
 */
function _decodePythPrice(data: Buffer): { price: number; confidence: number; exponent: number; publishTime: number; slot: number } | null {
	if (data.length < 134) {
		console.log(`  Pyth data too short: ${data.length} bytes`);
		return null;
	}

	const price = Number(data.readBigInt64LE(76));
	const conf = Number(data.readBigUInt64LE(84));
	const exponent = data.readInt32LE(92);
	const publishTime = Number(data.readBigInt64LE(96));
	const postedSlot = Number(data.readBigUInt64LE(128));

	const priceFloat = price * Math.pow(10, exponent);
	const confFloat = conf * Math.pow(10, exponent);

	return {
		price: priceFloat,
		confidence: confFloat,
		exponent,
		publishTime,
		slot: postedSlot,
	};
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	console.log('\n=== Switch Oracles: Prelaunch -> PYTH_PULL ===\n');

	const adminKeypairData = JSON.parse(
		fs.readFileSync(ADMIN_KEYPAIR_PATH, 'utf-8')
	);
	const adminKeypair = Keypair.fromSecretKey(
		Uint8Array.from(adminKeypairData)
	);
	console.log(`Admin: ${adminKeypair.publicKey.toBase58()}`);

	const connection = new Connection(RPC_ENDPOINT, 'confirmed');
	const wallet = new anchor.Wallet(adminKeypair);
	const sdkConfig = initialize({ env: ENV });
	const programId = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);
	console.log(`Program: ${programId.toBase58()}`);

	const adminClient = new AdminClient({
		connection,
		wallet,
		programID: programId,
		opts: {
			commitment: 'confirmed',
			preflightCommitment: 'confirmed',
		},
		activeSubAccountId: 0,
		accountSubscription: {
			type: 'polling',
			accountLoader: new BulkAccountLoader(connection, 'confirmed', 1000),
		},
		skipLoadUsers: true,
	});

	await adminClient.subscribe();

	const state = adminClient.getStateAccount();
	console.log(
		`State: ${state.numberOfMarkets} perp, ${state.numberOfSpotMarkets} spot markets\n`
	);

	// ------------------------------------------------------------------
	// Step 1: Verify Pyth oracle accounts exist
	// ------------------------------------------------------------------
	console.log('--- Checking Pyth oracle accounts ---\n');
	for (const market of MARKETS) {
		const acctInfo = await connection.getAccountInfo(market.pythOracle);
		if (!acctInfo) {
			console.error(`  FATAL: ${market.name} Pyth oracle ${market.pythOracle.toBase58()} NOT FOUND`);
			process.exit(1);
		}
		console.log(`  ${market.name}: ${market.pythOracle.toBase58()} (${acctInfo.data.length} bytes, owner: ${acctInfo.owner.toBase58()})`);
	}

	// ------------------------------------------------------------------
	// Step 2: Switch each market from Prelaunch to PYTH_PULL
	// ------------------------------------------------------------------
	console.log('\n--- Switching oracles ---\n');
	for (const market of MARKETS) {
		console.log(`${market.name} (index ${market.index}):`);

		const perpMarket = adminClient.getPerpMarketAccount(market.index);
		if (!perpMarket) {
			console.error(`  WARNING: Perp market ${market.index} not found, skipping.`);
			continue;
		}

		const currentSource = JSON.stringify(perpMarket.amm.oracleSource);
		const currentOracle = perpMarket.amm.oracle.toBase58();
		console.log(`  Current: ${currentOracle} (${currentSource})`);
		console.log(`  Target:  ${market.pythOracle.toBase58()} (PYTH_PULL)`);

		if (perpMarket.amm.oracle.equals(market.pythOracle)) {
			console.log('  Already using Pyth oracle, skipping.\n');
			continue;
		}

		try {
			// Use skipInvariantCheck=true since prelaunch prices may differ from Pyth
			const txSig = await adminClient.updatePerpMarketOracle(
				market.index,
				market.pythOracle,
				OracleSource.PYTH_PULL,
				true // skipInvariantCheck
			);
			console.log(`  Switched! Tx: ${txSig}`);
		} catch (err: any) {
			console.error(`  FAILED: ${err.message}`);
			if (err.logs) {
				const relevantLogs = err.logs.filter((l: string) => l.includes('Error') || l.includes('error') || l.includes('invalid'));
				relevantLogs.forEach((l: string) => console.error(`    ${l}`));
			}
			continue;
		}

		// Verify
		await adminClient.fetchAccounts();
		const updated = adminClient.getPerpMarketAccount(market.index);
		console.log(`  Verified: ${updated?.amm.oracle.toBase58()} (${JSON.stringify(updated?.amm.oracleSource)})\n`);
	}

	console.log('=== Oracle switch complete ===\n');
	console.log('Next steps:');
	console.log('  1. Update sdk/src/constants/perpMarkets.ts to use PYTH_PULL oracles');
	console.log('  2. Rebuild SDK: cd sdk && yarn build');
	console.log('  3. Reinstall SDK in keeper-bots and rebuild');
	console.log('  4. Restart keeper bots');

	await adminClient.unsubscribe();
}

main().catch((err) => {
	console.error('\nFailed:', err);
	process.exit(1);
});
