import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	AdminClient,
	BASE_PRECISION,
	BulkAccountLoader,
	initialize,
	MarketStatus,
	OracleSource,
	PEG_PRECISION,
	PRICE_PRECISION,
	ZERO,
	ContractTier,
} from '../sdk/src';
import { createMint } from '@solana/spl-token';
import fs from 'fs';

// ============================================================================
// CONFIGURATION
// ============================================================================

const ENV = 'devnet' as const;
const RPC_ENDPOINT =
	process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com';
const ADMIN_KEYPAIR_PATH =
	process.env.ADMIN_KEYPAIR_PATH || './keys/admin-keypair.json';

const PYTH_ORACLES = {
	'SOL-USD': new PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE'),
	'BTC-USD': new PublicKey('4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo'),
	'ETH-USD': new PublicKey('42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC'),
};

const AMM_INITIAL_BASE_ASSET_AMOUNT = new BN(1_000).mul(BASE_PRECISION);
const AMM_INITIAL_QUOTE_ASSET_AMOUNT = new BN(1_000).mul(BASE_PRECISION);
const PERIODICITY = new BN(3600);

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	console.log('\n=== Reset Protocol with Mock USDC ===\n');

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
	});

	await adminClient.subscribe();

	const state = adminClient.getStateAccount();
	console.log(
		`Current state: ${state.numberOfMarkets} perp, ${state.numberOfSpotMarkets} spot markets`
	);

	// ------------------------------------------------------------------
	// Step 1: Delete admin user account (if exists, has no balances)
	// ------------------------------------------------------------------
	console.log('\n--- Step 1: Delete admin user account ---');
	try {
		const userAccount = adminClient.getUserAccount();
		if (userAccount) {
			const txSig = await adminClient.deleteUser(0);
			console.log(`  Deleted admin user. Tx: ${txSig}`);
		}
	} catch (e: any) {
		console.log(`  Skip user delete: ${e.message?.slice(0, 100)}`);
	}

	// ------------------------------------------------------------------
	// Step 2: Set all perp markets to Initialized, then delete (reverse order)
	// ------------------------------------------------------------------
	console.log('\n--- Step 2: Delete perp markets ---');
	for (let i = state.numberOfMarkets - 1; i >= 0; i--) {
		console.log(`  Perp market ${i}: setting to Initialized...`);
		await adminClient.updatePerpMarketStatus(i, MarketStatus.INITIALIZED);

		console.log(`  Perp market ${i}: deleting...`);
		const txSig = await adminClient.deleteInitializedPerpMarket(i);
		console.log(`  Perp market ${i}: deleted. Tx: ${txSig}`);
	}

	// ------------------------------------------------------------------
	// Step 3: Set all spot markets to Initialized, then delete (reverse order)
	// ------------------------------------------------------------------
	console.log('\n--- Step 3: Delete spot markets ---');
	// Refresh state after perp deletions
	await adminClient.fetchAccounts();
	const currentSpotCount = adminClient.getStateAccount().numberOfSpotMarkets;

	for (let i = currentSpotCount - 1; i >= 0; i--) {
		console.log(`  Spot market ${i}: setting to Initialized...`);
		await adminClient.updateSpotMarketStatus(i, MarketStatus.INITIALIZED);

		console.log(`  Spot market ${i}: deleting...`);
		const txSig = await adminClient.deleteInitializedSpotMarket(i);
		console.log(`  Spot market ${i}: deleted. Tx: ${txSig}`);
	}

	// ------------------------------------------------------------------
	// Step 4: Create new mock USDC mint (admin = mint authority)
	// ------------------------------------------------------------------
	console.log('\n--- Step 4: Create mock USDC mint ---');
	const mockUsdcMint = await createMint(
		connection,
		adminKeypair, // payer
		adminKeypair.publicKey, // mint authority
		null, // freeze authority
		6 // decimals
	);
	console.log(`  Mock USDC mint: ${mockUsdcMint.toBase58()}`);

	// Save mint address for later use
	fs.writeFileSync(
		'./keys/mock-usdc-mint.json',
		JSON.stringify({ mint: mockUsdcMint.toBase58() })
	);
	console.log('  Saved to ./keys/mock-usdc-mint.json');

	// ------------------------------------------------------------------
	// Step 5: Reinitialize spot market 0 (USDC) with new mint
	// ------------------------------------------------------------------
	console.log('\n--- Step 5: Reinitialize USDC spot market ---');
	const spotTxSig = await adminClient.initializeSpotMarket(
		mockUsdcMint,
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
	console.log(`  USDC spot market initialized. Tx: ${spotTxSig}`);

	// ------------------------------------------------------------------
	// Step 6: Reinitialize perp markets
	// ------------------------------------------------------------------
	console.log('\n--- Step 6: Reinitialize perp markets ---');
	const perpMarkets = [
		{
			name: 'SOL-PERP',
			index: 0,
			oracle: PYTH_ORACLES['SOL-USD'],
			pegMultiplier: new BN(150).mul(PEG_PRECISION),
			contractTier: ContractTier.A,
			marginRatioInitial: 1000,
			marginRatioMaintenance: 500,
		},
		{
			name: 'BTC-PERP',
			index: 1,
			oracle: PYTH_ORACLES['BTC-USD'],
			pegMultiplier: new BN(95000).mul(PEG_PRECISION),
			contractTier: ContractTier.A,
			marginRatioInitial: 1000,
			marginRatioMaintenance: 500,
		},
		{
			name: 'ETH-PERP',
			index: 2,
			oracle: PYTH_ORACLES['ETH-USD'],
			pegMultiplier: new BN(3500).mul(PEG_PRECISION),
			contractTier: ContractTier.A,
			marginRatioInitial: 1000,
			marginRatioMaintenance: 500,
		},
	];

	for (const market of perpMarkets) {
		const txSig = await adminClient.initializePerpMarket(
			market.index,
			market.oracle,
			AMM_INITIAL_BASE_ASSET_AMOUNT,
			AMM_INITIAL_QUOTE_ASSET_AMOUNT,
			PERIODICITY,
			market.pegMultiplier,
			OracleSource.PYTH_PULL,
			market.contractTier,
			market.marginRatioInitial,
			market.marginRatioMaintenance,
			0, // liquidatorFee
			10000, // ifLiquidatorFee
			0, // imfFactor
			true, // activeStatus
			0, // baseSpread
			50000, // maxSpread
			ZERO, // maxOpenInterest
			ZERO, // maxRevenueWithdrawPerPeriod
			ZERO, // quoteMaxInsurance
			BASE_PRECISION.divn(10000), // orderStepSize
			PRICE_PRECISION.divn(100000), // orderTickSize
			BASE_PRECISION.divn(10000) // minOrderSize
		);
		console.log(`  ${market.name} initialized. Tx: ${txSig}`);
	}

	// ------------------------------------------------------------------
	// Step 7: Set auction duration
	// ------------------------------------------------------------------
	console.log('\n--- Step 7: Set protocol parameters ---');
	await adminClient.updatePerpAuctionDuration(10);
	console.log('  Perp auction duration set to 10 slots');

	// ------------------------------------------------------------------
	// Done
	// ------------------------------------------------------------------
	await adminClient.fetchAccounts();
	const finalState = adminClient.getStateAccount();
	console.log('\n=== Reset Complete ===');
	console.log(`  Perp markets: ${finalState.numberOfMarkets}`);
	console.log(`  Spot markets: ${finalState.numberOfSpotMarkets}`);
	console.log(`  Mock USDC mint: ${mockUsdcMint.toBase58()}`);
	console.log(
		'\nNow update your test script and keeper configs to use the new USDC mint.'
	);
	console.log(
		'The admin has mint authority, so the test script can mint freely.\n'
	);

	await adminClient.unsubscribe();
}

main().catch((err) => {
	console.error('\nReset failed:', err);
	process.exit(1);
});
