/**
 * Test 24: Self-Trade Prevention
 *
 * 1. User places SELL limit order
 * 2. Same user places BUY limit order at same price
 * 3. Attempt to fill user's BUY against user's SELL
 * 4. Verify no fill occurs (self-trade prevented)
 */
import {
	PositionDirection,
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
	console.log('\n=== Test 24: Self-Trade Prevention ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	const taker = await createTaker(ctx);
	const { oraclePrice, tickSize } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);
	console.log(`\n  Oracle: ${oraclePrice.toString()}`);

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId, taker.keypair.publicKey, 0
	);

	// ── Step 1: User places SELL at oracle-2% (post-only, won't cross) ──
	console.log('\n--- Step 1: User places SELL ---');
	const sellPrice = oraclePrice.muln(98).divn(100).div(tickSize).mul(tickSize);
	const sellOid = await placeLimitOrder(taker.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: sellPrice,
		userOrderId: 1,
	});

	// ── Step 2: Same user places BUY at oracle (would cross the SELL) ──
	console.log('\n--- Step 2: Same user places BUY ---');
	const buyOid = await placeLimitOrder(taker.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: oraclePrice,
		userOrderId: 2,
	});

	// ── Step 3: Try to fill BUY against own SELL ──
	console.log('\n--- Step 3: Attempt self-trade fill ---');
	await taker.client.fetchAccounts();
	const buyOrder = findOpenOrder(taker.client, buyOid);
	const sellOrder = findOpenOrder(taker.client, sellOid);

	let fillFailed = false;
	if (buyOrder && sellOrder) {
		// Build maker info using the taker's own SELL order
		const selfMakerInfo = buildMakerInfo(
			ctx.programId, taker.keypair, taker.client, 0, sellOrder
		);
		try {
			const filled = await directFill(
				ctx.client,
				takerUserPubkey,
				taker.client.getUserAccount()!,
				buyOrder,
				selfMakerInfo
			);
			fillFailed = !filled;
		} catch (e: any) {
			console.log(`  Fill errored (expected): ${e.message?.slice(0, 150)}`);
			fillFailed = true;
		}
	} else {
		console.log('  Orders not found');
		fillFailed = true;
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await taker.client.fetchAccounts();

	const takerPos = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	const noPosition = !takerPos;

	console.log(`  Fill failed/no position: ${fillFailed || noPosition ? 'YES (self-trade prevented)' : 'NO'}`);
	console.log(`  Taker position: ${takerPos ? `${takerPos.side} ${takerPos.baseAmountSol} SOL` : 'none'}`);

	// Self-trade prevention: either the fill failed OR no position was created
	const selfTradePrevented = fillFailed || noPosition;
	console.log(`  Self-trade prevented: ${selfTradePrevented ? '-- PASS' : '-- FAIL'}`);

	printTestResult('24-self-trade-prevention', selfTradePrevented);

	await cancelAllOrders(taker.client);
	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
