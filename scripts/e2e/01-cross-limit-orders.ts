/**
 * Test 01: Cross Limit Orders (maker/taker)
 *
 * Maker places LIMIT SELL, taker places LIMIT BUY at same price.
 * Admin acts as filler to match them directly.
 * Verify: maker has SHORT position, taker has LONG position.
 */
import { PositionDirection } from '../../sdk/src';
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
import { assertPosition, printTestResult } from './setup/verify';
import {
	SOL_PERP_MARKET_INDEX,
	DEFAULT_ORDER_SIZE,
	DLOB_SERVER,
	RPC_ENDPOINT,
} from './setup/config';
import { sleep, queryDlobL3 } from './setup/helpers';

async function main() {
	console.log('\n=== Test 01: Cross Limit Orders (maker SELL + taker BUY) ===');
	console.log(`RPC: ${RPC_ENDPOINT}`);
	console.log(`DLOB: ${DLOB_SERVER}\n`);

	// 1. Set up admin client
	const ctx = await createAdminClient();

	// 2. Ensure admin has USDC collateral
	await ensureAdminCollateral(ctx);

	// 3. Cancel stale orders, note existing positions
	await cancelAllOrders(ctx.client);
	const existingPos = ctx.client.getUser().getPerpPosition(SOL_PERP_MARKET_INDEX);
	if (existingPos && !existingPos.baseAssetAmount.isZero()) {
		const side = existingPos.baseAssetAmount.isNeg() ? 'SHORT' : 'LONG';
		console.log(`  Admin has existing ${side} position (will accumulate)`);
	}

	// 4. Setup market oracle + AMM
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	// 5. Create taker
	const taker = await createTaker(ctx);

	// 6. Get oracle price, compute order price (2% above oracle)
	console.log('\n--- Oracle price ---');
	const { oraclePrice, tickSize } = getOraclePriceSnapped(
		ctx.client,
		SOL_PERP_MARKET_INDEX
	);
	const buffer = oraclePrice.divn(50); // 2%
	const orderPrice = oraclePrice.add(buffer).div(tickSize).mul(tickSize);
	console.log(`  Oracle: ${oraclePrice.toString()}, Order price: ${orderPrice.toString()}`);

	// 7. Maker LIMIT SELL (admin)
	console.log('\n--- Placing maker LIMIT SELL (admin) ---');
	const makerUserOrderId = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: orderPrice,
		userOrderId: 1,
	});

	// 8. DLOB check (after maker)
	console.log('\n--- DLOB check (after maker order) ---');
	await sleep(3000);
	const dlob1 = await queryDlobL3(SOL_PERP_MARKET_INDEX);
	if (dlob1) {
		console.log(`  DLOB L3: ${dlob1.bids?.length || 0} bids, ${dlob1.asks?.length || 0} asks`);
		if (dlob1.asks?.length > 0) {
			console.log(`  Top ask: price=${dlob1.asks[0].price}, size=${dlob1.asks[0].size}`);
		}
	}

	// 9. Taker LIMIT BUY (crosses maker)
	console.log('\n--- Placing taker LIMIT BUY (crosses maker) ---');
	const takerUserOrderId = await placeLimitOrder(taker.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: orderPrice,
		userOrderId: 1,
	});

	// 10. DLOB check (after taker)
	console.log('\n--- DLOB check (after taker order) ---');
	await sleep(3000);
	const dlob2 = await queryDlobL3(SOL_PERP_MARKET_INDEX);
	if (dlob2) {
		console.log(`  DLOB L3: ${dlob2.bids?.length || 0} bids, ${dlob2.asks?.length || 0} asks`);
	}

	// 11. Direct fill (admin as filler)
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

	// 12. DLOB check (post-fill)
	const dlob3 = await queryDlobL3(SOL_PERP_MARKET_INDEX);
	if (dlob3) {
		console.log(`  DLOB L3 (post-fill): ${dlob3.bids?.length || 0} bids, ${dlob3.asks?.length || 0} asks`);
	}

	// 13. Verify positions
	console.log('\n--- Verification ---');
	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();

	await assertPosition(
		ctx.client,
		SOL_PERP_MARKET_INDEX,
		'SHORT',
		'Maker (admin)'
	);
	const takerOk = await assertPosition(
		taker.client,
		SOL_PERP_MARKET_INDEX,
		'LONG',
		'Taker'
	);

	// Taker is the key indicator (always fresh each run)
	printTestResult('01-cross-limit-orders', takerOk);

	// Cleanup
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
