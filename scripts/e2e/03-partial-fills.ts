/**
 * Test 03: Partial Fills
 *
 * Maker places LIMIT SELL for 1.0 SOL at oracle price (competitive with AMM).
 * Taker places LIMIT BUY for 0.3 SOL at oracle + 2% (crosses maker).
 * Admin fills the taker order against the maker.
 * Verify: taker has LONG 0.3 SOL, maker has SHORT position increased by 0.3 SOL,
 *         maker's order has 0.7 SOL remaining.
 */
import { BN } from '@coral-xyz/anchor';
import { PositionDirection, BASE_PRECISION, PostOnlyParams } from '../../sdk/src';
import {
	getUserAccountPublicKeySync,
} from '../../sdk/src/addresses/pda';
import { createAdminClient, cleanupClients } from './setup/client';
import { ensureAdminCollateral, createTaker } from './setup/user';
import { setupMarket } from './setup/oracle';
import {
	getOraclePriceSnapped,
	placeLimitOrder,
	cancelAllOrders,
	findOpenOrder,
} from './setup/order';
import { buildMakerInfo, directFill } from './setup/fill';
import { assertPosition, assertOrderRemaining, printTestResult, getPosition } from './setup/verify';
import {
	SOL_PERP_MARKET_INDEX,
	RPC_ENDPOINT,
} from './setup/config';
import { sleep } from './setup/helpers';

const MAKER_SIZE = BASE_PRECISION; // 1.0 SOL
const TAKER_SIZE = BASE_PRECISION.muln(3).divn(10); // 0.3 SOL
const EXPECTED_REMAINING = BASE_PRECISION.muln(7).divn(10); // 0.7 SOL

async function main() {
	console.log('\n=== Test 03: Partial Fills (1.0 SOL maker, 0.3 SOL taker) ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	// 1. Set up admin client + collateral
	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);

	// 2. Cancel stale orders
	await cancelAllOrders(ctx.client);

	// 3. Setup market oracle + AMM at $150
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	// 4. Create taker
	const taker = await createTaker(ctx);

	// 5. Compute order prices
	//    Maker: at oracle price (competitive with AMM so it gets matched)
	//    Taker: at oracle + 2% (crosses maker for sure)
	console.log('\n--- Oracle price ---');
	const { oraclePrice, tickSize } = getOraclePriceSnapped(
		ctx.client,
		SOL_PERP_MARKET_INDEX
	);
	const makerPrice = oraclePrice; // at oracle — better than AMM for the taker
	const takerPrice = oraclePrice.muln(102).divn(100).div(tickSize).mul(tickSize); // oracle + 2%
	console.log(`  Oracle: ${oraclePrice.toString()}`);
	console.log(`  Maker SELL price: ${makerPrice.toString()} (at oracle)`);
	console.log(`  Taker BUY price:  ${takerPrice.toString()} (oracle + 2%)`);

	// 6. Record admin position before fill
	await ctx.client.fetchAccounts();
	const adminPosBefore = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseBefore = adminPosBefore
		? new BN(adminPosBefore.baseAmount)
		: new BN(0);
	console.log(`\n  Admin position before: ${adminBaseBefore.toString()}`);

	// 7. Maker LIMIT SELL 1.0 SOL at oracle price (admin)
	console.log('\n--- Placing maker LIMIT SELL 1.0 SOL at oracle price (admin) ---');
	const makerUserOrderId = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: MAKER_SIZE,
		price: makerPrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 1,
	});

	// 8. Taker LIMIT BUY 0.3 SOL (crosses maker)
	console.log('\n--- Placing taker LIMIT BUY 0.3 SOL at oracle + 2% ---');
	const takerUserOrderId = await placeLimitOrder(taker.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: TAKER_SIZE,
		price: takerPrice,
		userOrderId: 1,
	});

	// 9. Direct fill
	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();

	const takerOrder = findOpenOrder(taker.client, takerUserOrderId);
	const makerOrder = findOpenOrder(ctx.client, makerUserOrderId);

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId,
		taker.keypair.publicKey,
		0
	);

	if (takerOrder && makerOrder) {
		const makerInfo = buildMakerInfo(
			ctx.programId,
			ctx.keypair,
			ctx.client,
			ctx.adminSubAccountId,
			makerOrder
		);
		await directFill(
			ctx.client,
			takerUserPubkey,
			taker.client.getUserAccount()!,
			takerOrder,
			makerInfo
		);
	} else {
		console.log('\n  Could not find open orders for fill.');
		if (!takerOrder) console.log('    Missing taker order');
		if (!makerOrder) console.log('    Missing maker order');
	}

	// 10. Wait and refresh
	await sleep(2000);
	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();

	// 11. Verify taker position: LONG 0.3 SOL
	console.log('\n--- Verification ---');

	const takerOk = await assertPosition(
		taker.client,
		SOL_PERP_MARKET_INDEX,
		'LONG',
		'Taker (0.3 SOL expected)'
	);

	// 12. Verify maker position increased by ~0.3 SOL SHORT
	const adminPosAfter = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseAfter = adminPosAfter
		? new BN(adminPosAfter.baseAmount)
		: new BN(0);
	const adminDelta = adminBaseAfter.sub(adminBaseBefore);
	console.log(`\n  Admin position after: ${adminBaseAfter.toString()}`);
	console.log(`  Admin delta: ${adminDelta.toString()} (expected: -${TAKER_SIZE.toString()})`);
	const makerPosOk = adminDelta.abs().eq(TAKER_SIZE);
	console.log(`  Maker position delta: ${makerPosOk ? '-- PASS' : '-- FAIL'}`);

	// 13. Verify maker's order has 0.7 SOL remaining
	const makerOrderAfter = findOpenOrder(ctx.client, makerUserOrderId);
	const remainingOk = assertOrderRemaining(
		makerOrderAfter,
		EXPECTED_REMAINING,
		'Maker remaining'
	);

	const allPassed = takerOk && makerPosOk && remainingOk;
	printTestResult('03-partial-fills', allPassed);

	// Cleanup: cancel remaining maker order
	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
