/**
 * Test 04: Multiple Makers
 *
 * Maker #1 (admin): SELL 0.2 SOL at oracle price
 * Maker #2 (new account): SELL 0.3 SOL at oracle price
 * Taker: BUY 0.5 SOL at oracle price (crosses both makers, but NOT the AMM)
 *
 * Two sequential fills:
 *   Fill #1: taker vs maker #1 → 0.2 SOL (no AMM because taker limit = oracle ≤ AMM ask)
 *   Fill #2: taker vs maker #2 → 0.3 SOL
 *
 * Verify: taker LONG 0.5 SOL, maker #1 SHORT delta -0.2, maker #2 SHORT 0.3 SOL.
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
import { printTestResult, getPosition } from './setup/verify';
import {
	SOL_PERP_MARKET_INDEX,
	RPC_ENDPOINT,
} from './setup/config';
import { sleep } from './setup/helpers';

const MAKER1_SIZE = BASE_PRECISION.muln(2).divn(10); // 0.2 SOL
const MAKER2_SIZE = BASE_PRECISION.muln(3).divn(10); // 0.3 SOL
const TAKER_SIZE = BASE_PRECISION.muln(5).divn(10); // 0.5 SOL

async function main() {
	console.log('\n=== Test 04: Multiple Makers (2 makers, 1 taker) ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	// 1. Set up admin client + collateral
	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);

	// 2. Setup market oracle + AMM at $150
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	// 3. Create maker #2 and taker
	const maker2 = await createTaker(ctx, undefined, 'maker2');
	const taker = await createTaker(ctx, undefined, 'taker');

	// 4. All orders at oracle price
	//    Maker prices at oracle → competitive with AMM (better for taker)
	//    Taker BUY at oracle → AMM ask is slightly above oracle, so AMM won't fill
	console.log('\n--- Order prices ---');
	const { oraclePrice } = getOraclePriceSnapped(
		ctx.client,
		SOL_PERP_MARKET_INDEX
	);
	console.log(`  Oracle:        ${oraclePrice.toString()}`);
	console.log(`  Maker #1 SELL: ${oraclePrice.toString()} (at oracle)`);
	console.log(`  Maker #2 SELL: ${oraclePrice.toString()} (at oracle)`);
	console.log(`  Taker BUY:     ${oraclePrice.toString()} (at oracle — no AMM fill)`);

	// 5. Record admin position before fill
	await ctx.client.fetchAccounts();
	const adminPosBefore = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseBefore = adminPosBefore
		? new BN(adminPosBefore.baseAmount)
		: new BN(0);
	console.log(`\n  Admin position before: ${adminBaseBefore.toString()}`);

	// 6. Maker #1 (admin): SELL 0.2 SOL at oracle
	console.log('\n--- Maker #1 (admin): SELL 0.2 SOL ---');
	const maker1OrderId = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: MAKER1_SIZE,
		price: oraclePrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 1,
	});

	// 7. Maker #2: SELL 0.3 SOL at oracle
	console.log('\n--- Maker #2: SELL 0.3 SOL ---');
	const maker2OrderId = await placeLimitOrder(maker2.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: MAKER2_SIZE,
		price: oraclePrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 1,
	});

	// 8. Taker: BUY 0.5 SOL at oracle (won't fill vs AMM since AMM ask > oracle)
	console.log('\n--- Taker: BUY 0.5 SOL ---');
	const takerOrderId = await placeLimitOrder(taker.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: TAKER_SIZE,
		price: oraclePrice,
		userOrderId: 1,
	});

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId,
		taker.keypair.publicKey,
		0
	);

	// 9. Fill #1: taker vs maker #1
	console.log('\n--- Fill #1: taker vs maker #1 ---');
	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();

	const takerOrder1 = findOpenOrder(taker.client, takerOrderId);
	const maker1Order = findOpenOrder(ctx.client, maker1OrderId);

	if (takerOrder1 && maker1Order) {
		const makerInfo1 = buildMakerInfo(
			ctx.programId,
			ctx.keypair,
			ctx.client,
			ctx.adminSubAccountId,
			maker1Order
		);
		await directFill(
			ctx.client,
			takerUserPubkey,
			taker.client.getUserAccount()!,
			takerOrder1,
			makerInfo1
		);
	} else {
		console.log('  Missing orders for fill #1');
	}

	// 10. Fill #2: taker remaining vs maker #2
	console.log('\n--- Fill #2: taker vs maker #2 ---');
	await sleep(2000);
	await ctx.client.fetchAccounts();
	await maker2.client.fetchAccounts();
	await taker.client.fetchAccounts();

	const takerOrder2 = findOpenOrder(taker.client, takerOrderId);
	const maker2Order = findOpenOrder(maker2.client, maker2OrderId);

	if (takerOrder2 && maker2Order) {
		const makerInfo2 = buildMakerInfo(
			ctx.programId,
			maker2.keypair,
			maker2.client,
			0,
			maker2Order
		);
		await directFill(
			ctx.client,
			takerUserPubkey,
			taker.client.getUserAccount()!,
			takerOrder2,
			makerInfo2
		);
	} else {
		console.log('  Missing orders for fill #2');
		if (!takerOrder2) console.log('    Taker order fully consumed after fill #1');
		if (!maker2Order) console.log('    Maker #2 order not found');
	}

	// 11. Wait and refresh all accounts
	await sleep(2000);
	await ctx.client.fetchAccounts();
	await maker2.client.fetchAccounts();
	await taker.client.fetchAccounts();

	// 12. Verify taker position: LONG 0.5 SOL
	console.log('\n--- Verification ---');

	const takerPos = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	const takerBaseAbs = takerPos ? new BN(takerPos.baseAmount).abs() : new BN(0);
	console.log(`\n  Taker position:`);
	if (takerPos) {
		console.log(`    Side: ${takerPos.side}`);
		console.log(`    Base amount: ${takerPos.baseAmount} (${takerPos.baseAmountSol} SOL)`);
	} else {
		console.log('    No position');
	}
	const takerOk = takerPos?.side === 'LONG' && takerBaseAbs.eq(TAKER_SIZE);
	console.log(`    Expected: LONG ${TAKER_SIZE.toString()} ${takerOk ? '-- PASS' : '-- FAIL'}`);

	// 13. Verify maker #1 (admin) position delta: -0.2 SOL
	const adminPosAfter = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseAfter = adminPosAfter
		? new BN(adminPosAfter.baseAmount)
		: new BN(0);
	const adminDelta = adminBaseAfter.sub(adminBaseBefore);
	console.log(`\n  Maker #1 (admin) position delta:`);
	console.log(`    Before: ${adminBaseBefore.toString()}`);
	console.log(`    After:  ${adminBaseAfter.toString()}`);
	console.log(`    Delta:  ${adminDelta.toString()} (expected: -${MAKER1_SIZE.toString()})`);
	const maker1Ok = adminDelta.abs().eq(MAKER1_SIZE);
	console.log(`    ${maker1Ok ? '-- PASS' : '-- FAIL'}`);

	// 14. Verify maker #2 position: SHORT 0.3 SOL (fresh account)
	const maker2Pos = getPosition(maker2.client, SOL_PERP_MARKET_INDEX);
	console.log(`\n  Maker #2 position:`);
	if (maker2Pos) {
		console.log(`    Side: ${maker2Pos.side}`);
		console.log(`    Base amount: ${maker2Pos.baseAmount} (${maker2Pos.baseAmountSol} SOL)`);
	} else {
		console.log('    No position');
	}
	const maker2Ok = maker2Pos?.side === 'SHORT'
		&& new BN(maker2Pos.baseAmount).abs().eq(MAKER2_SIZE);
	console.log(`    Expected: SHORT ${MAKER2_SIZE.toString()} ${maker2Ok ? '-- PASS' : '-- FAIL'}`);

	const allPassed = takerOk && maker1Ok && maker2Ok;
	printTestResult('04-multiple-makers', allPassed);

	// Cleanup
	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, maker2.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
