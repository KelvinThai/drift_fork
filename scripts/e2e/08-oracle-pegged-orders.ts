/**
 * Test 08: Oracle-Pegged Orders
 *
 * Place an oracle-pegged BUY with positive offset (crosses AMM).
 * Fill against AMM. Verify fill price is near oracle.
 * Then move oracle to $160, place another oracle-pegged BUY,
 * verify the new fill price tracks the new oracle.
 */
import { BN } from '@coral-xyz/anchor';
import {
	PositionDirection,
	OrderType,
	MarketType,
	PRICE_PRECISION,
	BASE_PRECISION,
} from '../../sdk/src';
import {
	getUserAccountPublicKeySync,
} from '../../sdk/src/addresses/pda';
import { createAdminClient, cleanupClients } from './setup/client';
import { ensureAdminCollateral, createTaker } from './setup/user';
import { setupMarket } from './setup/oracle';
import {
	getOraclePriceSnapped,
	cancelAllOrders,
	findOpenOrder,
} from './setup/order';
import { directFill } from './setup/fill';
import { printTestResult, getPosition } from './setup/verify';
import { sleep } from './setup/helpers';
import {
	SOL_PERP_MARKET_INDEX,
	DEFAULT_ORDER_SIZE,
	RPC_ENDPOINT,
} from './setup/config';

async function main() {
	console.log('\n=== Test 08: Oracle-Pegged Orders ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);

	// ── Phase 1: Oracle at $150 ──
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);
	const taker = await createTaker(ctx);

	const { oraclePrice: oracle150 } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);
	console.log(`\n  Phase 1 oracle: ${oracle150.toString()} ($${oracle150.div(PRICE_PRECISION).toString()})`);

	// Place oracle-pegged BUY with offset = +5% of PRICE_PRECISION
	// For a BUY, positive offset means willing to buy above oracle (crosses AMM)
	const offset = PRICE_PRECISION.muln(5).divn(100).toNumber(); // 5% = 50000
	console.log(`  oraclePriceOffset: ${offset} (+5%)`);

	console.log('\n--- Taker: Oracle-pegged BUY (offset=+5%) at $150 oracle ---');
	const takerTx1 = await taker.client.placePerpOrder({
		orderType: OrderType.ORACLE,
		marketIndex: SOL_PERP_MARKET_INDEX,
		marketType: MarketType.PERP,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		oraclePriceOffset: offset,
		userOrderId: 1,
	});
	console.log(`  Placed oracle BUY. Tx: ${takerTx1}`);

	await taker.client.fetchAccounts();
	const takerOrder1 = findOpenOrder(taker.client, 1);
	if (takerOrder1) {
		console.log(`  Order: offset=${takerOrder1.oraclePriceOffset}, auctionDuration=${takerOrder1.auctionDuration}`);
	}

	// Wait for auction to complete
	console.log('  Waiting for auction to complete...');
	await sleep(5000);

	// Fill against AMM (no maker)
	console.log('\n--- Fill Phase 1: taker vs AMM ---');
	await taker.client.fetchAccounts();
	const order1 = findOpenOrder(taker.client, 1);
	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId,
		taker.keypair.publicKey,
		0
	);

	if (order1) {
		await directFill(
			ctx.client,
			takerUserPubkey,
			taker.client.getUserAccount()!,
			order1
		);
	} else {
		console.log('  Order already consumed');
	}

	await sleep(2000);
	await taker.client.fetchAccounts();

	const pos1 = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	let phase1Ok = false;
	console.log('\n  Phase 1 result:');
	if (pos1) {
		console.log(`    Side: ${pos1.side}, Base: ${pos1.baseAmountSol} SOL`);
		const fillPrice1 = new BN(pos1.quoteEntry).abs()
			.mul(BASE_PRECISION)
			.div(new BN(pos1.baseAmount).abs());
		const diff1 = fillPrice1.sub(oracle150).abs();
		const maxDiff = oracle150.divn(10); // 10% tolerance (AMM spread)
		phase1Ok = pos1.side === 'LONG' && diff1.lt(maxDiff);
		console.log(`    Fill price: ${fillPrice1.toString()} (oracle=${oracle150.toString()})`);
		console.log(`    Within 10% of oracle: ${phase1Ok ? '-- PASS' : '-- FAIL'}`);
	} else {
		console.log('    No position');
	}

	// ── Phase 2: Move oracle to $160, place another oracle-pegged BUY ──
	console.log('\n--- Phase 2: Move oracle to $160 ---');
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 160);
	const { oraclePrice: oracle160 } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);
	console.log(`  Phase 2 oracle: ${oracle160.toString()} ($${oracle160.div(PRICE_PRECISION).toString()})`);

	// Create second taker for clean position
	const taker2 = await createTaker(ctx, undefined, 'taker2');

	console.log('\n--- Taker2: Oracle-pegged BUY (offset=+5%) at $160 oracle ---');
	const takerTx2 = await taker2.client.placePerpOrder({
		orderType: OrderType.ORACLE,
		marketIndex: SOL_PERP_MARKET_INDEX,
		marketType: MarketType.PERP,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		oraclePriceOffset: offset,
		userOrderId: 1,
	});
	console.log(`  Placed oracle BUY. Tx: ${takerTx2}`);

	await sleep(5000);

	const taker2UserPubkey = getUserAccountPublicKeySync(
		ctx.programId,
		taker2.keypair.publicKey,
		0
	);
	await taker2.client.fetchAccounts();
	const order2 = findOpenOrder(taker2.client, 1);
	if (order2) {
		await directFill(
			ctx.client,
			taker2UserPubkey,
			taker2.client.getUserAccount()!,
			order2
		);
	}

	await sleep(2000);
	await taker2.client.fetchAccounts();

	const pos2 = getPosition(taker2.client, SOL_PERP_MARKET_INDEX);
	let phase2Ok = false;
	console.log('\n  Phase 2 result:');
	if (pos2) {
		console.log(`    Side: ${pos2.side}, Base: ${pos2.baseAmountSol} SOL`);
		const fillPrice2 = new BN(pos2.quoteEntry).abs()
			.mul(BASE_PRECISION)
			.div(new BN(pos2.baseAmount).abs());
		const diff2 = fillPrice2.sub(oracle160).abs();
		const maxDiff2 = oracle160.divn(10); // 10%
		phase2Ok = pos2.side === 'LONG' && diff2.lt(maxDiff2);
		console.log(`    Fill price: ${fillPrice2.toString()} (oracle=${oracle160.toString()})`);
		console.log(`    Within 10% of oracle: ${phase2Ok ? '-- PASS' : '-- FAIL'}`);

		// Key assertion: fill price should be higher than phase 1 (oracle moved up)
		if (pos1) {
			const fp1 = new BN(pos1.quoteEntry).abs().mul(BASE_PRECISION).div(new BN(pos1.baseAmount).abs());
			const priceIncreased = fillPrice2.gt(fp1);
			console.log(`    Fill price increased with oracle: ${priceIncreased ? '-- PASS' : '-- FAIL'}`);
			phase2Ok = phase2Ok && priceIncreased;
		}
	} else {
		console.log('    No position');
	}

	const allPassed = phase1Ok && phase2Ok;
	printTestResult('08-oracle-pegged-orders', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client, taker2.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
