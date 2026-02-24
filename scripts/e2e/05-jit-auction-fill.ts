/**
 * Test 05: JIT Auction Fill
 *
 * Taker places MARKET BUY with auction params (oracle → oracle+2%, 10 slots).
 * JIT maker places LIMIT SELL at oracle price during the auction window.
 * Admin fills the taker against the JIT maker DURING the auction.
 *
 * Verify:
 *   - Taker gets LONG position
 *   - Maker gets SHORT position
 *   - Fill price is at maker's price (oracle), NOT the auction end price
 */
import { BN } from '@coral-xyz/anchor';
import { PositionDirection, PostOnlyParams, BASE_PRECISION, PRICE_PRECISION } from '../../sdk/src';
import {
	getUserAccountPublicKeySync,
} from '../../sdk/src/addresses/pda';
import { createAdminClient, cleanupClients } from './setup/client';
import { ensureAdminCollateral, createTaker } from './setup/user';
import { setupMarket } from './setup/oracle';
import {
	getOraclePriceSnapped,
	placeMarketOrder,
	placeLimitOrder,
	cancelAllOrders,
	findOpenOrder,
} from './setup/order';
import { buildMakerInfo, directFill } from './setup/fill';
import { printTestResult, getPosition } from './setup/verify';
import {
	SOL_PERP_MARKET_INDEX,
	DEFAULT_ORDER_SIZE,
	RPC_ENDPOINT,
} from './setup/config';

async function main() {
	console.log('\n=== Test 05: JIT Auction Fill ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	// 1. Set up admin (filler + JIT maker) + collateral
	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);

	// 2. Setup market oracle + AMM at $150
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	// 3. Create taker
	const taker = await createTaker(ctx);

	// 4. Compute auction prices
	console.log('\n--- Auction parameters ---');
	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);
	const auctionStart = oraclePrice; // best case for taker
	const auctionEnd = oraclePrice.muln(102).divn(100); // worst case: oracle + 2%
	console.log(`  Oracle:        ${oraclePrice.toString()} ($${oraclePrice.div(PRICE_PRECISION).toString()})`);
	console.log(`  Auction start: ${auctionStart.toString()} (oracle — best for taker)`);
	console.log(`  Auction end:   ${auctionEnd.toString()} (oracle + 2% — worst for taker)`);

	// 5. Record admin position before
	await ctx.client.fetchAccounts();
	const adminPosBefore = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseBefore = adminPosBefore ? new BN(adminPosBefore.baseAmount) : new BN(0);

	// 6. Taker places MARKET BUY with auction
	console.log('\n--- Taker: MARKET BUY with auction ---');
	const takerOrderId = await placeMarketOrder(taker.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: auctionEnd, // max willing to pay
		auctionStartPrice: auctionStart,
		auctionEndPrice: auctionEnd,
		auctionDuration: 10,
		userOrderId: 1,
	});

	// 7. JIT maker places LIMIT SELL at oracle (provides liquidity during auction)
	//    In real JIT flow, the maker sees the auction and responds immediately.
	console.log('\n--- JIT Maker (admin): SELL at oracle price ---');
	const makerOrderId = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: oraclePrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 2,
	});

	// 8. Fill DURING the auction window (don't wait for it to end)
	//    The taker's effective price interpolates between start and end.
	//    Since maker price ($150) is within the auction range, the fill should match.
	console.log('\n--- Filling during auction window ---');
	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();

	const takerOrder = findOpenOrder(taker.client, takerOrderId);
	const makerOrder = findOpenOrder(ctx.client, makerOrderId);

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId,
		taker.keypair.publicKey,
		0
	);

	if (takerOrder && makerOrder) {
		console.log(`  Taker auction: slots ${takerOrder.auctionDuration}, ` +
			`start=${takerOrder.auctionStartPrice.toString()}, ` +
			`end=${takerOrder.auctionEndPrice.toString()}`);

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
		console.log('  Could not find open orders for fill.');
		if (!takerOrder) console.log('    Missing taker order');
		if (!makerOrder) console.log('    Missing maker order');
	}

	// 9. Verify
	console.log('\n--- Verification ---');
	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();

	// Taker should have LONG position
	const takerPos = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	console.log('\n  Taker position:');
	let takerOk = false;
	if (takerPos) {
		console.log(`    Side: ${takerPos.side}`);
		console.log(`    Base: ${takerPos.baseAmount} (${takerPos.baseAmountSol} SOL)`);
		console.log(`    Quote entry: ${takerPos.quoteEntry}`);
		takerOk = takerPos.side === 'LONG';

		// Check fill price: should be at maker's price (oracle), not auction end
		const fillPrice = new BN(takerPos.quoteEntry).abs()
			.mul(BASE_PRECISION)
			.div(new BN(takerPos.baseAmount).abs());
		console.log(`    Effective fill price: ${fillPrice.toString()} (oracle=${oraclePrice.toString()})`);

		// Fill price should be at or near oracle, not at auction end
		const priceDiff = fillPrice.sub(oraclePrice).abs();
		const maxSlippage = oraclePrice.divn(100); // allow 1% tolerance
		const priceOk = priceDiff.lt(maxSlippage);
		console.log(`    Price near oracle: ${priceOk ? '-- PASS' : '-- FAIL'} (diff=${priceDiff.toString()})`);
		takerOk = takerOk && priceOk;
	} else {
		console.log('    No position (fill failed)');
	}
	console.log(`    ${takerOk ? '-- PASS' : '-- FAIL'}`);

	// Maker (admin) should have SHORT delta
	const adminPosAfter = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseAfter = adminPosAfter ? new BN(adminPosAfter.baseAmount) : new BN(0);
	const adminDelta = adminBaseAfter.sub(adminBaseBefore);
	console.log('\n  JIT Maker (admin) position delta:');
	console.log(`    Before: ${adminBaseBefore.toString()}`);
	console.log(`    After:  ${adminBaseAfter.toString()}`);
	console.log(`    Delta:  ${adminDelta.toString()} (expected: -${DEFAULT_ORDER_SIZE.toString()})`);
	const makerOk = adminDelta.abs().eq(DEFAULT_ORDER_SIZE);
	console.log(`    ${makerOk ? '-- PASS' : '-- FAIL'}`);

	const allPassed = takerOk && makerOk;
	printTestResult('05-jit-auction-fill', allPassed);

	// Cleanup
	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
