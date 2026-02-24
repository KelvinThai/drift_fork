/**
 * Test 27: Concurrent Taker Orders
 *
 * 1. Maker places SELL 0.1 SOL at oracle
 * 2. Two takers each place BUY 0.1 SOL
 * 3. Fill both takers vs maker
 * 4. Only one should fully fill (maker has only 0.1 SOL)
 * 5. Verify no double-fill (total filled <= maker size)
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
	console.log('\n=== Test 27: Concurrent Taker Orders ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);

	// Record admin position before
	await ctx.client.fetchAccounts();
	const adminPosBefore = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseBefore = adminPosBefore ? new BN(adminPosBefore.baseAmount) : new BN(0);

	// ── Step 1: Maker SELL 0.1 SOL ──
	console.log('\n--- Step 1: Maker SELL 0.1 SOL ---');
	const makerOid = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: oraclePrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 1,
	});

	// ── Step 2: Two takers BUY 0.1 SOL each ──
	console.log('\n--- Step 2: Two takers place BUY 0.1 SOL ---');
	const taker1 = await createTaker(ctx, undefined, 'taker1');
	const taker2 = await createTaker(ctx, undefined, 'taker2');

	const taker1Pubkey = getUserAccountPublicKeySync(ctx.programId, taker1.keypair.publicKey, 0);
	const taker2Pubkey = getUserAccountPublicKeySync(ctx.programId, taker2.keypair.publicKey, 0);

	const auctionEnd = oraclePrice.muln(102).divn(100);

	const t1Oid = await placeMarketOrder(taker1.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: auctionEnd,
		auctionStartPrice: oraclePrice,
		auctionEndPrice: auctionEnd,
		auctionDuration: 10,
		userOrderId: 1,
	});

	const t2Oid = await placeMarketOrder(taker2.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: auctionEnd,
		auctionStartPrice: oraclePrice,
		auctionEndPrice: auctionEnd,
		auctionDuration: 10,
		userOrderId: 1,
	});

	// ── Step 3: Fill both takers vs maker ──
	console.log('\n--- Step 3: Fill taker1 vs maker ---');
	await ctx.client.fetchAccounts();
	await taker1.client.fetchAccounts();
	const t1Order = findOpenOrder(taker1.client, t1Oid);
	const makerOrder1 = findOpenOrder(ctx.client, makerOid);

	if (t1Order && makerOrder1) {
		const makerInfo = buildMakerInfo(
			ctx.programId, ctx.keypair, ctx.client, ctx.adminSubAccountId, makerOrder1
		);
		await directFill(ctx.client, taker1Pubkey, taker1.client.getUserAccount()!, t1Order, makerInfo);
	}

	console.log('\n--- Fill taker2 vs maker (may fail — maker depleted) ---');
	await sleep(2000);
	await ctx.client.fetchAccounts();
	await taker2.client.fetchAccounts();
	const t2Order = findOpenOrder(taker2.client, t2Oid);
	const makerOrder2 = findOpenOrder(ctx.client, makerOid);

	if (t2Order && makerOrder2) {
		const makerInfo = buildMakerInfo(
			ctx.programId, ctx.keypair, ctx.client, ctx.adminSubAccountId, makerOrder2
		);
		await directFill(ctx.client, taker2Pubkey, taker2.client.getUserAccount()!, t2Order, makerInfo);
	} else if (t2Order) {
		// Try fill vs AMM as fallback
		await directFill(ctx.client, taker2Pubkey, taker2.client.getUserAccount()!, t2Order);
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await taker1.client.fetchAccounts();
	await taker2.client.fetchAccounts();
	await ctx.client.fetchAccounts();

	const t1Pos = getPosition(taker1.client, SOL_PERP_MARKET_INDEX);
	const t2Pos = getPosition(taker2.client, SOL_PERP_MARKET_INDEX);

	const t1Base = t1Pos ? new BN(t1Pos.baseAmount).abs() : new BN(0);
	const t2Base = t2Pos ? new BN(t2Pos.baseAmount).abs() : new BN(0);
	const totalFilled = t1Base.add(t2Base);

	const adminPosAfter = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseAfter = adminPosAfter ? new BN(adminPosAfter.baseAmount) : new BN(0);
	const adminDelta = adminBaseAfter.sub(adminBaseBefore).abs();

	console.log(`  Taker1: ${t1Pos ? `${t1Pos.side} ${t1Pos.baseAmountSol} SOL` : 'none'}`);
	console.log(`  Taker2: ${t2Pos ? `${t2Pos.side} ${t2Pos.baseAmountSol} SOL` : 'none'}`);
	console.log(`  Total taker fills: ${totalFilled.toString()}`);
	console.log(`  Maker delta: ${adminDelta.toString()}`);
	console.log(`  Maker order size: ${DEFAULT_ORDER_SIZE.toString()}`);

	// Key check: maker should not have filled more than its order size
	// Note: taker2 may have filled against AMM, so we check maker delta specifically
	const noDoubleFill = adminDelta.lte(DEFAULT_ORDER_SIZE);
	console.log(`  No maker double-fill: ${noDoubleFill ? '-- PASS' : '-- FAIL'}`);

	// At least one taker should have filled
	const atLeastOneFilled = !t1Base.isZero() || !t2Base.isZero();
	console.log(`  At least one taker filled: ${atLeastOneFilled ? '-- PASS' : '-- FAIL'}`);

	const allPassed = noDoubleFill && atLeastOneFilled;
	printTestResult('27-concurrent-takers', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker1.client, taker2.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
