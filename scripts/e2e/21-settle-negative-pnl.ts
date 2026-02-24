/**
 * Test 21: Settle Negative PnL
 *
 * 1. Open LONG 0.1 SOL at $150
 * 2. Re-align AMM at $150 (fill creates small negative PnL from spread)
 * 3. Call settlePNL
 * 4. Verify settlement succeeds and settledPerpPnl is negative
 *
 * Note: Speculative tier limits oracle divergence from 5min TWAP to 2.5% for settle.
 */
import { BN } from '@coral-xyz/anchor';
import {
	PositionDirection,
	PostOnlyParams,
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
	console.log('\n=== Test 21: Settle Negative PnL ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	const taker = await createTaker(ctx);
	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId, taker.keypair.publicKey, 0
	);

	// ── Step 1: Open LONG 0.1 SOL ──
	console.log('\n--- Step 1: Open LONG 0.1 SOL at $150 ---');
	const makerOid = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: oraclePrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 1,
	});

	const auctionEnd = oraclePrice.muln(102).divn(100);
	const takerOid = await placeMarketOrder(taker.client, {
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
	const takerOrder = findOpenOrder(taker.client, takerOid);
	const makerOrder = findOpenOrder(ctx.client, makerOid);

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
		printTestResult('21-settle-negative-pnl', false);
		await cleanupClients(ctx.client, taker.client);
		return;
	}
	console.log(`  Position: ${posAfterOpen.side} ${posAfterOpen.baseAmountSol} SOL`);

	// ── Step 2: Re-align AMM at $150 (stay within 2.5% settle band) ──
	console.log('\n--- Step 2: Re-align AMM at $150 ---');
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);
	await sleep(2000);
	await taker.client.fetchAccounts();

	const unrealizedPnl = taker.client.getUser().getUnrealizedPNL(false, SOL_PERP_MARKET_INDEX);
	console.log(`  Unrealized PnL: ${unrealizedPnl.toString()}`);

	// ── Step 3: Settle PnL ──
	console.log('\n--- Step 3: Settle PnL ---');
	const settledBefore = taker.client.getUserAccount()!.settledPerpPnl;
	console.log(`  settledPerpPnl before: ${settledBefore.toString()}`);

	let settled = false;
	try {
		const settleTx = await ctx.client.settlePNL(
			takerUserPubkey,
			taker.client.getUserAccount()!,
			SOL_PERP_MARKET_INDEX,
		);
		console.log(`  settlePNL tx: ${settleTx}`);
		settled = true;
	} catch (e: any) {
		console.log(`  settlePNL failed: ${e.message?.slice(0, 200)}`);
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await taker.client.fetchAccounts();

	const settledAfter = taker.client.getUserAccount()!.settledPerpPnl;
	console.log(`  settledPerpPnl after: ${settledAfter.toString()}`);

	const pnlNegative = settledAfter.lt(new BN(0));
	console.log(`  Settle succeeded: ${settled ? '-- PASS' : '-- FAIL'}`);
	console.log(`  settledPerpPnl negative: ${pnlNegative ? '-- PASS' : '-- FAIL'}`);

	const allPassed = settled && pnlNegative;
	printTestResult('21-settle-negative-pnl', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
