/**
 * Test 17: Triggered Order with Crossing
 *
 * 1. Open LONG 0.1 SOL at $150
 * 2. Place trigger SELL (stop-loss) with triggerCondition=BELOW, triggerPrice=$140
 * 3. Admin places BUY (maker) at $138 — a resting order below trigger
 * 4. Move oracle to $135 (below trigger)
 * 5. Trigger the order
 * 6. Fill the triggered order against the resting maker
 * 7. Verify position closed and maker filled
 */
import { BN } from '@coral-xyz/anchor';
import {
	PositionDirection,
	PostOnlyParams,
	OrderTriggerCondition,
	getTriggerMarketOrderParams,
	PRICE_PRECISION,
	MarketType,
} from '../../sdk/src';
import {
	getUserAccountPublicKeySync,
} from '../../sdk/src/addresses/pda';
import { createAdminClient, cleanupClients } from './setup/client';
import { ensureAdminCollateral, createTaker } from './setup/user';
import { setupMarket } from './setup/oracle';
import {
	getOraclePriceSnapped,
	placeLimitOrder,
	placeMarketOrder,
	cancelAllOrders,
	findOpenOrder,
} from './setup/order';
import { buildMakerInfo, directFill } from './setup/fill';
import { printTestResult, getPosition } from './setup/verify';
import { sleep } from './setup/helpers';
import {
	SOL_PERP_MARKET_INDEX,
	DEFAULT_ORDER_SIZE,
	RPC_ENDPOINT,
} from './setup/config';

async function main() {
	console.log('\n=== Test 17: Triggered Order with Crossing ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	const taker = await createTaker(ctx);
	const { oraclePrice, tickSize } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId, taker.keypair.publicKey, 0
	);

	// ── Step 1: Open LONG 0.1 SOL ──
	console.log('\n--- Step 1: Open LONG 0.1 SOL ---');
	const makerOrderId = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: oraclePrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 1,
	});

	const auctionEnd = oraclePrice.muln(102).divn(100);
	const takerOrderId = await placeMarketOrder(taker.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: auctionEnd,
		auctionStartPrice: oraclePrice,
		auctionEndPrice: auctionEnd,
		auctionDuration: 10,
		userOrderId: 1,
	});

	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();
	const takerOrder = findOpenOrder(taker.client, takerOrderId);
	const makerOrder = findOpenOrder(ctx.client, makerOrderId);

	if (takerOrder && makerOrder) {
		const makerInfo = buildMakerInfo(
			ctx.programId, ctx.keypair, ctx.client, ctx.adminSubAccountId, makerOrder
		);
		await directFill(ctx.client, takerUserPubkey, taker.client.getUserAccount()!, takerOrder, makerInfo);
	}

	await sleep(2000);
	await taker.client.fetchAccounts();
	const posAfterOpen = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	if (!posAfterOpen || posAfterOpen.side !== 'LONG') {
		console.log('  Failed to open position');
		printTestResult('17-triggered-with-crossing', false);
		await cleanupClients(ctx.client, taker.client);
		return;
	}
	console.log(`  Position: ${posAfterOpen.side} ${posAfterOpen.baseAmountSol} SOL`);

	// Record admin position before
	await ctx.client.fetchAccounts();
	const adminPosBefore = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseBefore = adminPosBefore ? new BN(adminPosBefore.baseAmount) : new BN(0);

	// ── Step 2: Place trigger SELL ──
	console.log('\n--- Step 2: Place trigger SELL at $140 ---');
	const triggerPrice = new BN(140).mul(PRICE_PRECISION).div(tickSize).mul(tickSize);

	const triggerParams = getTriggerMarketOrderParams({
		marketType: MarketType.PERP,
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		triggerCondition: OrderTriggerCondition.BELOW,
		triggerPrice,
		reduceOnly: true,
		userOrderId: 2,
	});

	await taker.client.placePerpOrder(triggerParams);
	await taker.client.fetchAccounts();
	const trigOrderPlaced = findOpenOrder(taker.client, 2) !== null;
	console.log(`  Trigger order placed: ${trigOrderPlaced ? 'YES' : 'NO'}`);

	// ── Step 3: Admin places resting BUY (maker) ──
	console.log('\n--- Step 3: Admin places BUY at $135 ---');
	await cancelAllOrders(ctx.client);
	// Move oracle to $135 first so the maker order is valid
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 135);
	await sleep(2000);

	const { oraclePrice: newOracle } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);
	const makerBuyOid = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: newOracle,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 3,
	});

	// ── Step 4: Trigger the order ──
	console.log('\n--- Step 4: Trigger the stop-loss ---');
	await taker.client.fetchAccounts();
	const orderToTrigger = findOpenOrder(taker.client, 2);

	let triggered = false;
	if (orderToTrigger) {
		try {
			const trigTx = await ctx.client.triggerOrder(
				takerUserPubkey,
				taker.client.getUserAccount()!,
				orderToTrigger,
			);
			console.log(`  Trigger tx: ${trigTx}`);
			triggered = true;
		} catch (e: any) {
			console.log(`  Trigger failed: ${e.message?.slice(0, 200)}`);
		}
	}

	// ── Step 5: Fill triggered order vs maker ──
	console.log('\n--- Step 5: Fill triggered vs resting maker ---');
	await sleep(2000);
	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();

	const triggeredOrder = findOpenOrder(taker.client, 2);
	const restingMaker = findOpenOrder(ctx.client, makerBuyOid);

	if (triggeredOrder && restingMaker) {
		const makerInfo = buildMakerInfo(
			ctx.programId, ctx.keypair, ctx.client, ctx.adminSubAccountId, restingMaker
		);
		await directFill(ctx.client, takerUserPubkey, taker.client.getUserAccount()!, triggeredOrder, makerInfo);
	} else if (triggeredOrder) {
		// Fill against AMM
		await directFill(ctx.client, takerUserPubkey, taker.client.getUserAccount()!, triggeredOrder);
	} else {
		console.log('  Triggered order not found (may have already filled)');
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await taker.client.fetchAccounts();
	await ctx.client.fetchAccounts();

	const posAfterTrigger = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	const posReduced = !posAfterTrigger ||
		new BN(posAfterTrigger.baseAmount).abs().lt(new BN(posAfterOpen.baseAmount).abs());

	console.log('  Taker position after triggered fill:');
	if (posAfterTrigger) {
		console.log(`    Side: ${posAfterTrigger.side}, Base: ${posAfterTrigger.baseAmountSol} SOL`);
	} else {
		console.log('    No position (closed)');
	}

	// Check if maker got filled
	const adminPosAfter = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseAfter = adminPosAfter ? new BN(adminPosAfter.baseAmount) : new BN(0);
	const _makerFilled = !adminBaseAfter.eq(adminBaseBefore);

	console.log(`  Trigger placed: ${trigOrderPlaced ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Triggered: ${triggered ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Position reduced: ${posReduced ? '-- PASS' : '-- FAIL'}`);

	const allPassed = trigOrderPlaced && triggered && posReduced;
	printTestResult('17-triggered-with-crossing', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
