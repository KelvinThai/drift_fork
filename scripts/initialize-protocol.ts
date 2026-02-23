import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
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
// Devnet: New Pyth push feed accounts (PriceUpdateV2 format, owned by rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ)
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
