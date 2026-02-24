/**
 * Test 02: Market Orders (taker vs AMM)
 *
 * Taker places a market BUY order with no resting maker.
 * Admin acts as filler and matches the taker against the AMM.
 * Verify: taker ends up with a LONG position.
 */
import { PositionDirection } from '../../sdk/src';
import {
	getUserAccountPublicKeySync,
} from '../../sdk/src/addresses/pda';
import { createAdminClient, cleanupClients } from './setup/client';
import { createTaker } from './setup/user';
import { setupMarket } from './setup/oracle';
import {
	getOraclePriceSnapped,
	placeMarketOrder,
	cancelAllOrders,
	findOpenOrder,
} from './setup/order';
import { directFill } from './setup/fill';
import { assertPosition, printTestResult } from './setup/verify';
import {
	SOL_PERP_MARKET_INDEX,
	DEFAULT_ORDER_SIZE,
	RPC_ENDPOINT,
} from './setup/config';
import { sleep } from './setup/helpers';

async function main() {
	console.log('\n=== Test 02: Market Orders (taker vs AMM) ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	// 1. Set up admin client
	const ctx = await createAdminClient();

	// 2. Cancel stale admin orders (no maker needed for this test)
	await cancelAllOrders(ctx.client);

	// 3. Setup market oracle + AMM at $150
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	// 4. Create taker with fresh keypair + collateral
	const taker = await createTaker(ctx);

	// 5. Get oracle price for auction bounds
	console.log('\n--- Oracle price ---');
	const { oraclePrice } = getOraclePriceSnapped(
		ctx.client,
		SOL_PERP_MARKET_INDEX
	);
	// Auction: start at oracle, end at oracle + 5% (worst-case slippage)
	const auctionStart = oraclePrice;
	const auctionEnd = oraclePrice.muln(105).divn(100);
	console.log(`  Oracle: ${oraclePrice.toString()}`);
	console.log(`  Auction: ${auctionStart.toString()} -> ${auctionEnd.toString()} (5% slippage)`);

	// 6. Taker places MARKET BUY — no maker, will fill against AMM
	console.log('\n--- Placing taker MARKET BUY ---');
	const takerUserOrderId = await placeMarketOrder(taker.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: auctionEnd, // slippage limit
		auctionStartPrice: auctionStart,
		auctionEndPrice: auctionEnd,
		auctionDuration: 10, // 10 slots (matches protocol setting)
		userOrderId: 1,
	});

	// 7. Wait for auction to complete, then fill against AMM
	console.log('\n--- Waiting for auction to complete ---');
	await sleep(5000); // ~5s > 10 slots at ~400ms/slot

	await taker.client.fetchAccounts();
	const takerOrder = findOpenOrder(taker.client, takerUserOrderId);

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId,
		taker.keypair.publicKey,
		0
	);

	if (takerOrder) {
		console.log(`  Taker order still open: id=${takerOrder.orderId}`);
		// Fill against AMM (no makerInfo)
		await directFill(
			ctx.client,
			takerUserPubkey,
			taker.client.getUserAccount()!,
			takerOrder
		);
	} else {
		console.log('  Taker order not found (may have already been filled or expired)');
	}

	// 8. Verify taker position
	console.log('\n--- Verification ---');
	await taker.client.fetchAccounts();

	const takerOk = await assertPosition(
		taker.client,
		SOL_PERP_MARKET_INDEX,
		'LONG',
		'Taker'
	);

	printTestResult('02-market-orders', takerOk);

	// Cleanup
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
