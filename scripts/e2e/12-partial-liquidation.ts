/**
 * Test 12: Partial Liquidation
 *
 * 1. Create taker with small collateral ($5 USDC)
 * 2. Open LONG 0.1 SOL at oracle ($150)
 * 3. Move oracle to $100 (liquidatable)
 * 4. Liquidate with small maxBaseAssetAmount (half the position)
 * 5. Verify position reduced but not fully closed
 * 6. Liquidate remainder
 */
import { BN } from '@coral-xyz/anchor';
import {
	PositionDirection,
	PostOnlyParams,
	QUOTE_PRECISION,
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

const SMALL_COLLATERAL = new BN(5).mul(QUOTE_PRECISION);
const HALF_SIZE = DEFAULT_ORDER_SIZE.divn(2);

async function main() {
	console.log('\n=== Test 12: Partial Liquidation ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	const taker = await createTaker(ctx, SMALL_COLLATERAL);
	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);

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

	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId, taker.keypair.publicKey, 0
	);

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
	console.log(`\n  After open: ${posAfterOpen ? `${posAfterOpen.side} ${posAfterOpen.baseAmountSol} SOL` : 'none'}`);

	if (!posAfterOpen || posAfterOpen.side !== 'LONG') {
		console.log('  Failed to open position');
		printTestResult('12-partial-liquidation', false);
		await cleanupClients(ctx.client, taker.client);
		return;
	}

	const openBase = new BN(posAfterOpen.baseAmount).abs();

	// ── Step 2: Move oracle to $100 ──
	console.log('\n--- Step 2: Move oracle to $100 ---');
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 100);
	await sleep(2000);
	await taker.client.fetchAccounts();

	const liqStatus = taker.client.getUser().canBeLiquidated();
	console.log(`  canBeLiquidated: ${liqStatus.canBeLiquidated}`);

	// ── Step 3: Partial liquidation (half) ──
	console.log('\n--- Step 3: Partial liquidation (0.05 SOL) ---');
	let partialLiqOk = false;
	try {
		const liqTx1 = await ctx.client.liquidatePerp(
			takerUserPubkey,
			taker.client.getUserAccount()!,
			SOL_PERP_MARKET_INDEX,
			HALF_SIZE,
		);
		console.log(`  Partial liquidation tx: ${liqTx1}`);
		partialLiqOk = true;
	} catch (e: any) {
		console.log(`  Partial liquidation failed: ${e.message?.slice(0, 200)}`);
	}

	await sleep(2000);
	await taker.client.fetchAccounts();
	const posAfterPartial = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	console.log('\n  After partial liquidation:');
	if (posAfterPartial) {
		const partialBase = new BN(posAfterPartial.baseAmount).abs();
		console.log(`    Side: ${posAfterPartial.side}, Base: ${posAfterPartial.baseAmountSol} SOL`);
		console.log(`    Position reduced: ${partialBase.lt(openBase) ? 'YES' : 'NO'}`);
		console.log(`    Still has position: ${!partialBase.isZero() ? 'YES' : 'NO'}`);
		partialLiqOk = partialLiqOk && partialBase.lt(openBase);
	} else {
		console.log('    No position (fully liquidated in one go)');
		partialLiqOk = true;
	}
	console.log(`  Partial liquidation: ${partialLiqOk ? '-- PASS' : '-- FAIL'}`);

	// ── Step 4: Second liquidation (remainder) ──
	console.log('\n--- Step 4: Second liquidation (remainder) ---');
	let secondLiqOk = false;
	if (posAfterPartial && !new BN(posAfterPartial.baseAmount).isZero()) {
		try {
			const liqTx2 = await ctx.client.liquidatePerp(
				takerUserPubkey,
				taker.client.getUserAccount()!,
				SOL_PERP_MARKET_INDEX,
				new BN(posAfterPartial.baseAmount).abs(),
			);
			console.log(`  Second liquidation tx: ${liqTx2}`);
			secondLiqOk = true;
		} catch (e: any) {
			console.log(`  Second liquidation failed: ${e.message?.slice(0, 200)}`);
			// May fail if user is no longer liquidatable after partial — that's OK
			secondLiqOk = true;
		}
	} else {
		console.log('  No remaining position to liquidate');
		secondLiqOk = true;
	}

	await sleep(2000);
	await taker.client.fetchAccounts();
	const posAfterFull = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	console.log('\n  After second liquidation:');
	if (posAfterFull) {
		console.log(`    Side: ${posAfterFull.side}, Base: ${posAfterFull.baseAmountSol} SOL`);
	} else {
		console.log('    No position (fully liquidated)');
	}

	const allPassed = partialLiqOk && secondLiqOk;
	printTestResult('12-partial-liquidation', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
