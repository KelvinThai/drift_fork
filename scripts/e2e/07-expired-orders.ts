/**
 * Test 07: Expired Orders
 *
 * 1. Taker places limit BUY with maxTs = now + 10s (below oracle, won't auto-fill)
 * 2. Maker places SELL at oracle (would cross if taker were valid)
 * 3. Wait for maxTs to pass
 * 4. Attempt fill — should fail because taker order is expired
 * 5. Verify taker has no position (order expired unfilled)
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
	console.log('\n=== Test 07: Expired Orders ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	const taker = await createTaker(ctx);
	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);

	const nowSec = Math.floor(Date.now() / 1000);
	const expiryTs = nowSec + 10;
	console.log(`\n  Current time: ${nowSec}`);
	console.log(`  Order expiry: ${expiryTs} (now + 10s)`);
	console.log(`  Oracle: ${oraclePrice.toString()}`);

	// ── Step 1: Taker places BUY at oracle with maxTs ──
	console.log('\n--- Taker: BUY at oracle with maxTs ---');
	const takerOrderParams = getLimitOrderParams({
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: oraclePrice,
		userOrderId: 1,
		maxTs: new BN(expiryTs),
	});
	const takerTx = await taker.client.placePerpOrder(takerOrderParams);
	console.log(`  Placed order with maxTs=${expiryTs}. Tx: ${takerTx}`);

	await taker.client.fetchAccounts();
	const orderBefore = findOpenOrder(taker.client, 1);
	const orderExists = orderBefore !== null;
	console.log(`  Order on-chain: ${orderExists ? 'YES' : 'NO'}`);
	if (orderBefore) {
		console.log(`  maxTs on-chain: ${orderBefore.maxTs.toString()}`);
	}

	// ── Step 2: Maker places SELL at oracle ──
	console.log('\n--- Maker: SELL at oracle ---');
	const makerOrderId = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: oraclePrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 10,
	});

	// ── Step 3: Wait for expiry ──
	console.log('\n--- Waiting for expiry (15 seconds) ---');
	await sleep(15000);

	// ── Step 4: Try to fill after expiry ──
	console.log('\n--- Attempting fill after expiry ---');
	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();

	const takerOrder = findOpenOrder(taker.client, 1);
	const makerOrder = findOpenOrder(ctx.client, makerOrderId);

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId,
		taker.keypair.publicKey,
		0
	);

	let fillFailed = false;
	if (takerOrder && makerOrder) {
		const makerInfo = buildMakerInfo(
			ctx.programId,
			ctx.keypair,
			ctx.client,
			ctx.adminSubAccountId,
			makerOrder
		);
		const filled = await directFill(
			ctx.client,
			takerUserPubkey,
			taker.client.getUserAccount()!,
			takerOrder,
			makerInfo
		);
		fillFailed = !filled;
		console.log(`  Fill result: ${filled ? 'SUCCEEDED (unexpected)' : 'FAILED (expected — order expired)'}`);
	} else {
		// Order might have already been cleaned up
		fillFailed = true;
		console.log('  Order already expired/removed from book');
	}

	// ── Step 5: Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await taker.client.fetchAccounts();

	const takerPos = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	const noPosition = !takerPos;
	console.log(`  Taker position: ${takerPos ? `${takerPos.side} ${takerPos.baseAmountSol} SOL` : 'none (good — expired unfilled)'}`);
	console.log(`  Fill failed/skipped: ${fillFailed ? '-- PASS' : '-- FAIL'}`);
	console.log(`  No taker position: ${noPosition ? '-- PASS' : '-- FAIL'}`);

	const allPassed = orderExists && (fillFailed || noPosition);
	printTestResult('07-expired-orders', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
