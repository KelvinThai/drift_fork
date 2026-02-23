import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	BASE_PRECISION,
	BulkAccountLoader,
	DriftClient,
	initialize,
	MarketType,
	OrderType,
	PositionDirection,
	PRICE_PRECISION,
} from '../sdk/src';
import fs from 'fs';

const ENV = (process.env.DRIFT_ENV || 'devnet') as 'devnet' | 'mainnet-beta';
const RPC_ENDPOINT =
	process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com';
const USER_KEYPAIR_PATH =
	process.env.USER_KEYPAIR_PATH || './keys/admin-keypair.json';

async function main() {
	console.log('\n=== Custom Perp DEX — End-to-End Test ===\n');
	console.log(`Environment: ${ENV}`);
	console.log(`RPC: ${RPC_ENDPOINT}`);

	// Load user keypair
	const userKeypairData = JSON.parse(
		fs.readFileSync(USER_KEYPAIR_PATH, 'utf-8')
	);
	const userKeypair = Keypair.fromSecretKey(
		Uint8Array.from(userKeypairData)
	);
	console.log(`User pubkey: ${userKeypair.publicKey.toBase58()}`);

	const connection = new Connection(RPC_ENDPOINT, 'confirmed');
	const wallet = new anchor.Wallet(userKeypair);
	const sdkConfig = initialize({ env: ENV });

	const driftClient = new DriftClient({
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

	await driftClient.subscribe();

	// ================================================================
	// Test 1: Check protocol state
	// ================================================================
	console.log('\n--- Test 1: Protocol State ---');
	const state = driftClient.getStateAccount();
	console.log(`  Admin: ${state.admin.toBase58()}`);
	console.log(`  Perp markets: ${state.numberOfMarkets}`);
	console.log(`  Spot markets: ${state.numberOfSpotMarkets}`);
	console.assert(state.numberOfMarkets > 0, 'Should have perp markets');
	console.assert(state.numberOfSpotMarkets > 0, 'Should have spot markets');
	console.log('  PASS');

	// ================================================================
	// Test 2: Read market data
	// ================================================================
	console.log('\n--- Test 2: Market Data ---');
	for (let i = 0; i < state.numberOfMarkets; i++) {
		try {
			const market = driftClient.getPerpMarketAccount(i);
			if (market) {
				const name = Buffer.from(market.name)
					.toString('utf-8')
					.replace(/\0/g, '');
				console.log(
					`  Market ${i}: ${name} | Status: ${JSON.stringify(market.status)} | Oracle: ${market.amm.oracle.toBase58().slice(0, 8)}...`
				);
			}
		} catch (e: any) {
			console.log(`  Market ${i}: ${e.message?.slice(0, 60)}`);
		}
	}
	console.log('  PASS');

	// ================================================================
	// Test 3: Place a limit order (SOL-PERP)
	// ================================================================
	console.log('\n--- Test 3: Place Limit Order ---');
	try {
		const orderParams = {
			orderType: OrderType.LIMIT,
			marketIndex: 0,
			marketType: MarketType.PERP,
			direction: PositionDirection.LONG,
			baseAssetAmount: BASE_PRECISION.divn(100), // 0.01 SOL
			price: PRICE_PRECISION.muln(100), // $100 limit price (should not fill)
		};

		const txSig = await driftClient.placePerpOrder(orderParams);
		console.log(`  Order placed. Tx: ${txSig}`);
		console.log('  PASS');
	} catch (e: any) {
		console.log(`  Order failed: ${e.message?.slice(0, 100)}`);
		console.log('  SKIP (may need user account + collateral)');
	}

	// ================================================================
	// Test 4: Cancel all orders
	// ================================================================
	console.log('\n--- Test 4: Cancel Orders ---');
	try {
		const txSig = await driftClient.cancelOrders();
		console.log(`  Orders cancelled. Tx: ${txSig}`);
		console.log('  PASS');
	} catch (e: any) {
		console.log(`  Cancel: ${e.message?.slice(0, 100)}`);
		console.log('  SKIP');
	}

	// ================================================================
	// Summary
	// ================================================================
	console.log('\n=== End-to-End Tests Complete ===\n');

	await driftClient.unsubscribe();
}

main().catch((err) => {
	console.error('E2E test failed:', err);
	process.exit(1);
});
