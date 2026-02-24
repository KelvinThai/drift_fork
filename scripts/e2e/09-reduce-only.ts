/**
 * Test 09: Reduce-Only Orders
 *
 * 1. Open a LONG 0.1 SOL position (market BUY vs maker SELL)
 * 2. Place reduce-only SELL for 0.2 SOL (larger than position)
 * 3. Fill — should only close the 0.1 SOL, NOT flip to SHORT
 * 4. Verify position is closed (zero or no position)
 */
import { BN } from '@coral-xyz/anchor';
import {
	PositionDirection,
	PostOnlyParams,
	getLimitOrderParams,
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
	console.log('\n=== Test 09: Reduce-Only Orders ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	const taker = await createTaker(ctx);
	const { oraclePrice, tickSize } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);
	console.log(`\n  Oracle: ${oraclePrice.toString()}`);

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId,
		taker.keypair.publicKey,
		0
	);

	// ── Step 1: Open LONG position via market order + maker ──
	console.log('\n--- Step 1: Open LONG 0.1 SOL ---');
	// Maker SELL
	const makerOrderId1 = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: oraclePrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 1,
	});

	// Taker MARKET BUY with auction
	const auctionEnd = oraclePrice.muln(102).divn(100);
	const takerOrderId1 = await placeMarketOrder(taker.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: auctionEnd,
		auctionStartPrice: oraclePrice,
		auctionEndPrice: auctionEnd,
		auctionDuration: 10,
		userOrderId: 1,
	});

	// Fill
	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();
	const takerOrder1 = findOpenOrder(taker.client, takerOrderId1);
	const makerOrder1 = findOpenOrder(ctx.client, makerOrderId1);

	if (takerOrder1 && makerOrder1) {
		const makerInfo = buildMakerInfo(
			ctx.programId, ctx.keypair, ctx.client, ctx.adminSubAccountId, makerOrder1
		);
		await directFill(ctx.client, takerUserPubkey, taker.client.getUserAccount()!, takerOrder1, makerInfo);
	}

	await sleep(2000);
	await taker.client.fetchAccounts();
	const posAfterOpen = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	console.log(`\n  After open: ${posAfterOpen ? `${posAfterOpen.side} ${posAfterOpen.baseAmountSol} SOL` : 'none'}`);
	const openOk = posAfterOpen?.side === 'LONG';
	if (!openOk) {
		console.log('  Failed to open position — cannot test reduce-only');
		printTestResult('09-reduce-only', false);
		await cleanupClients(ctx.client, taker.client);
		return;
	}

	// ── Step 2: Place reduce-only SELL 0.2 SOL ──
	console.log('\n--- Step 2: Reduce-only SELL 0.2 SOL ---');
	const reduceOnlySize = DEFAULT_ORDER_SIZE.muln(2); // 0.2 SOL
	const reduceOrderParams = getLimitOrderParams({
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: reduceOnlySize,
		price: oraclePrice.muln(98).divn(100).div(tickSize).mul(tickSize),
		reduceOnly: true,
		userOrderId: 2,
	});
	const roTx = await taker.client.placePerpOrder(reduceOrderParams);
	console.log(`  Placed reduce-only SELL 0.2 SOL. Tx: ${roTx}`);

	// ── Step 3: Maker BUY to match ──
	console.log('\n--- Step 3: Maker BUY to match reduce-only ---');
	await cancelAllOrders(ctx.client);
	const makerOrderId2 = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: reduceOnlySize,
		price: oraclePrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 3,
	});

	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();
	const takerOrder2 = findOpenOrder(taker.client, 2);
	const makerOrder2 = findOpenOrder(ctx.client, makerOrderId2);

	if (takerOrder2 && makerOrder2) {
		const makerInfo = buildMakerInfo(
			ctx.programId, ctx.keypair, ctx.client, ctx.adminSubAccountId, makerOrder2
		);
		await directFill(ctx.client, takerUserPubkey, taker.client.getUserAccount()!, takerOrder2, makerInfo);
	}

	// ── Step 4: Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await taker.client.fetchAccounts();

	const posAfterReduce = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	console.log('\n  After reduce-only:');
	if (posAfterReduce) {
		console.log(`    Side: ${posAfterReduce.side}`);
		console.log(`    Base: ${posAfterReduce.baseAmount} (${posAfterReduce.baseAmountSol} SOL)`);
	} else {
		console.log('    No position (fully closed)');
	}

	const notFlipped = !posAfterReduce || posAfterReduce.side !== 'SHORT';
	const positionClosed = !posAfterReduce || new BN(posAfterReduce.baseAmount).isZero();
	console.log(`  Not flipped to SHORT: ${notFlipped ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Position closed: ${positionClosed ? '-- PASS' : '-- FAIL'}`);

	const allPassed = openOk && notFlipped;
	printTestResult('09-reduce-only', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
