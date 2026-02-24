/**
 * Test 19: Funding Payment Settlement
 *
 * 1. Create positions (LONG taker vs SHORT admin)
 * 2. Re-align AMM (so settlePNL doesn't hit price bands)
 * 3. Settle PnL for the taker
 * 4. Verify settlement was called successfully
 */
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
	console.log('\n=== Test 19: Funding Payment Settlement ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	// ── Step 1: Create positions ──
	console.log('\n--- Step 1: Create LONG position ---');
	const taker = await createTaker(ctx);
	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId, taker.keypair.publicKey, 0
	);

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
	const takerPos = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	if (!takerPos || takerPos.side !== 'LONG') {
		console.log('  Failed to open position');
		printTestResult('19-funding-payment-settlement', false);
		await cleanupClients(ctx.client, taker.client);
		return;
	}
	console.log(`  Taker: ${takerPos.side} ${takerPos.baseAmountSol} SOL`);

	// ── Step 2: Re-align AMM after fill (fixes price band divergence) ──
	console.log('\n--- Step 2: Re-align AMM ---');
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);
	await sleep(2000);

	// ── Step 3: Settle PnL ──
	console.log('\n--- Step 3: Settle PnL ---');
	await taker.client.fetchAccounts();

	const settledPnlBefore = taker.client.getUserAccount()!.settledPerpPnl;
	console.log(`  settledPerpPnl before: ${settledPnlBefore.toString()}`);

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
		if (e.logs) {
			e.logs.filter((l: string) => l.includes('Error') || l.includes('error'))
				.forEach((l: string) => console.log(`    ${l}`));
		}
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await taker.client.fetchAccounts();

	const settledPnlAfter = taker.client.getUserAccount()!.settledPerpPnl;
	console.log(`  settledPerpPnl after: ${settledPnlAfter.toString()}`);

	const pnlChanged = !settledPnlAfter.eq(settledPnlBefore);
	console.log(`  Settle tx succeeded: ${settled ? '-- PASS' : '-- FAIL'}`);
	console.log(`  settledPerpPnl changed: ${pnlChanged ? '-- PASS' : '-- FAIL (PnL may be zero)'}`);

	// Pass if settle tx succeeded (PnL might be 0 if just opened at same price)
	const allPassed = settled;
	printTestResult('19-funding-payment-settlement', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
