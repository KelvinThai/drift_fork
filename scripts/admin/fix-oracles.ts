import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	AdminClient,
	BulkAccountLoader,
	initialize,
	OracleSource,
	PRICE_PRECISION,
} from '../../sdk/src';
import {
	getPrelaunchOraclePublicKey,
	getAmmCachePublicKey,
} from '../../sdk/src/addresses/pda';
import fs from 'fs';

// ============================================================================
// CONFIGURATION
// ============================================================================

const ENV = 'devnet' as const;
const RPC_ENDPOINT =
	process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com';
const ADMIN_KEYPAIR_PATH =
	process.env.ADMIN_KEYPAIR_PATH || './keys/admin-keypair.json';

// Prices in USD (will be multiplied by PRICE_PRECISION)
const MARKET_PRICES: { index: number; name: string; priceUsd: number }[] = [
	{ index: 0, name: 'SOL-PERP', priceUsd: 150 },
	{ index: 1, name: 'BTC-PERP', priceUsd: 95000 },
	{ index: 2, name: 'ETH-PERP', priceUsd: 3500 },
];

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	console.log('\n=== Fix Oracles: Switch from PYTH_PULL to Prelaunch ===\n');

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
	// Step 0: Initialize AMM cache (required by updatePerpMarketOracle)
	// ------------------------------------------------------------------
	const ammCachePda = getAmmCachePublicKey(programId);
	const ammCacheAcct = await connection.getAccountInfo(ammCachePda);
	if (!ammCacheAcct) {
		console.log('--- Initializing AMM cache ---');
		const txSig = await adminClient.initializeAmmCache();
		console.log(`  AMM cache initialized. Tx: ${txSig}`);

		// Add each perp market to the cache
		for (const market of MARKET_PRICES) {
			const addTx = await adminClient.addMarketToAmmCache(market.index);
			console.log(`  Added market ${market.index} to AMM cache. Tx: ${addTx}`);
		}
		console.log('');
	} else {
		console.log('AMM cache already exists.\n');
	}

	for (const market of MARKET_PRICES) {
		console.log(`--- ${market.name} (index ${market.index}) ---`);

		const priceScaled = new BN(market.priceUsd).mul(PRICE_PRECISION);
		const maxPriceScaled = priceScaled.muln(10); // max price = 10x current
		console.log(
			`  Target price: $${market.priceUsd} (raw: ${priceScaled.toString()})`
		);

		// Step 1: Initialize prelaunch oracle
		const oraclePda = getPrelaunchOraclePublicKey(programId, market.index);
		console.log(`  Prelaunch oracle PDA: ${oraclePda.toBase58()}`);

		// Check if already initialized
		const oracleAcct = await connection.getAccountInfo(oraclePda);
		if (oracleAcct) {
			console.log('  Prelaunch oracle already exists, updating price...');
			const txSig = await adminClient.updatePrelaunchOracleParams(
				market.index,
				priceScaled,
				maxPriceScaled
			);
			console.log(`  Updated. Tx: ${txSig}`);
		} else {
			console.log('  Initializing prelaunch oracle...');
			const txSig = await adminClient.initializePrelaunchOracle(
				market.index,
				priceScaled,
				maxPriceScaled
			);
			console.log(`  Initialized. Tx: ${txSig}`);
		}

		// Step 2: Update perp market to use prelaunch oracle
		console.log('  Switching perp market oracle to Prelaunch...');
		const perpMarket = adminClient.getPerpMarketAccount(market.index);
		if (!perpMarket) {
			console.log(`  WARNING: Perp market ${market.index} not found, skipping.`);
			continue;
		}

		// Check current oracle source
		const currentSource = JSON.stringify(perpMarket.amm.oracleSource);
		console.log(`  Current oracle source: ${currentSource}`);
		console.log(
			`  Current oracle: ${perpMarket.amm.oracle.toBase58()}`
		);

		if (perpMarket.amm.oracle.equals(oraclePda)) {
			console.log('  Already using prelaunch oracle, skipping update.');
		} else {
			// skipInvariantCheck = true because old PYTH_PULL oracle is stale
			const txSig = await adminClient.updatePerpMarketOracle(
				market.index,
				oraclePda,
				OracleSource.Prelaunch,
				true // skip invariant check
			);
			console.log(`  Oracle switched. Tx: ${txSig}`);
		}

		// Refresh and verify
		await adminClient.fetchAccounts();
		const updatedMarket = adminClient.getPerpMarketAccount(market.index);
		console.log(
			`  Verified oracle: ${updatedMarket?.amm.oracle.toBase58()}`
		);
		console.log(
			`  Verified source: ${JSON.stringify(updatedMarket?.amm.oracleSource)}\n`
		);
	}

	console.log('=== All oracles switched to Prelaunch ===\n');
	console.log('Now restart the keeper bots and re-run the E2E test.');

	await adminClient.unsubscribe();
}

main().catch((err) => {
	console.error('\nFailed:', err);
	process.exit(1);
});
