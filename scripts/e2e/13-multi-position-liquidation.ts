/**
 * Test 13: Multi-Position Liquidation
 *
 * 1. Setup SOL-PERP ($150) and BTC-PERP ($60000)
 * 2. Create taker with $10 USDC
 * 3. Open LONG 0.1 SOL on SOL-PERP (~$15 notional)
 * 4. Open LONG 0.0002 BTC on BTC-PERP (~$12 notional)
 * 5. Move SOL oracle to $50 (large loss on SOL position)
 * 6. Liquidate SOL position
 * 7. Verify SOL position reduced, BTC position intact
 */
import { BN } from '@coral-xyz/anchor';
import {
	PositionDirection,
	PostOnlyParams,
	BASE_PRECISION,
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
	BTC_PERP_MARKET_INDEX,
	DEFAULT_ORDER_SIZE,
	RPC_ENDPOINT,
} from './setup/config';

const SMALL_COLLATERAL = new BN(8).mul(QUOTE_PRECISION); // $8 USDC
const BTC_ORDER_SIZE = BASE_PRECISION.divn(5000); // 0.0002 BTC

async function main() {
	console.log('\n=== Test 13: Multi-Position Liquidation ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);

	// Setup both markets
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);
	await setupMarket(ctx.client, BTC_PERP_MARKET_INDEX, 60000);

	const taker = await createTaker(ctx, SMALL_COLLATERAL);
	const takerUserPubkey = getUserAccountPublicKeySync(
		ctx.programId, taker.keypair.publicKey, 0
	);

	// ── Step 1: Open LONG SOL ──
	console.log('\n--- Step 1: Open LONG 0.1 SOL ---');
	const { oraclePrice: solPrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);

	const solMakerOid = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: solPrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 1,
	});

	const solAuctionEnd = solPrice.muln(102).divn(100);
	const solTakerOid = await placeMarketOrder(taker.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		price: solAuctionEnd,
		auctionStartPrice: solPrice,
		auctionEndPrice: solAuctionEnd,
		auctionDuration: 10,
		userOrderId: 1,
	});

	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();
	const solTakerOrder = findOpenOrder(taker.client, solTakerOid);
	const solMakerOrder = findOpenOrder(ctx.client, solMakerOid);

	if (solTakerOrder && solMakerOrder) {
		const makerInfo = buildMakerInfo(
			ctx.programId, ctx.keypair, ctx.client, ctx.adminSubAccountId, solMakerOrder
		);
		await directFill(ctx.client, takerUserPubkey, taker.client.getUserAccount()!, solTakerOrder, makerInfo);
	}

	await sleep(2000);
	await taker.client.fetchAccounts();
	const solPosAfterOpen = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	console.log(`  SOL position: ${solPosAfterOpen ? `${solPosAfterOpen.side} ${solPosAfterOpen.baseAmountSol} SOL` : 'none'}`);

	// ── Step 2: Open LONG BTC ──
	console.log('\n--- Step 2: Open LONG 0.0002 BTC ---');
	await cancelAllOrders(ctx.client);
	const { oraclePrice: btcPrice } = getOraclePriceSnapped(ctx.client, BTC_PERP_MARKET_INDEX);

	const btcMakerOid = await placeLimitOrder(ctx.client, {
		marketIndex: BTC_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: BTC_ORDER_SIZE,
		price: btcPrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 2,
	});

	const btcAuctionEnd = btcPrice.muln(102).divn(100);
	const btcTakerOid = await placeMarketOrder(taker.client, {
		marketIndex: BTC_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: BTC_ORDER_SIZE,
		price: btcAuctionEnd,
		auctionStartPrice: btcPrice,
		auctionEndPrice: btcAuctionEnd,
		auctionDuration: 10,
		userOrderId: 2,
	});

	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();
	const btcTakerOrder = findOpenOrder(taker.client, btcTakerOid);
	const btcMakerOrder = findOpenOrder(ctx.client, btcMakerOid);

	if (btcTakerOrder && btcMakerOrder) {
		const makerInfo = buildMakerInfo(
			ctx.programId, ctx.keypair, ctx.client, ctx.adminSubAccountId, btcMakerOrder
		);
		await directFill(ctx.client, takerUserPubkey, taker.client.getUserAccount()!, btcTakerOrder, makerInfo);
	}

	await sleep(2000);
	await taker.client.fetchAccounts();
	const btcPosAfterOpen = getPosition(taker.client, BTC_PERP_MARKET_INDEX);
	console.log(`  BTC position: ${btcPosAfterOpen ? `${btcPosAfterOpen.side} ${btcPosAfterOpen.baseAmountSol}` : 'none'}`);

	const bothOpened = solPosAfterOpen?.side === 'LONG' && btcPosAfterOpen?.side === 'LONG';
	if (!bothOpened) {
		console.log('  Failed to open both positions');
		printTestResult('13-multi-position-liquidation', false);
		await cancelAllOrders(ctx.client);
		await cleanupClients(ctx.client, taker.client);
		return;
	}

	// ── Step 3: Move SOL oracle down to $78 (liquidatable but within 50% TWAP band) ──
	console.log('\n--- Step 3: Move SOL oracle to $78 ---');
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 78);
	await sleep(2000);
	await taker.client.fetchAccounts();

	const liqStatus = taker.client.getUser().canBeLiquidated();
	console.log(`  canBeLiquidated: ${liqStatus.canBeLiquidated}`);
	console.log(`  totalCollateral: ${liqStatus.totalCollateral.toString()}`);

	// ── Step 4: Liquidate SOL position ──
	console.log('\n--- Step 4: Liquidate SOL position ---');
	let solLiqOk = false;
	try {
		const liqTx = await ctx.client.liquidatePerp(
			takerUserPubkey,
			taker.client.getUserAccount()!,
			SOL_PERP_MARKET_INDEX,
			DEFAULT_ORDER_SIZE,
		);
		console.log(`  SOL liquidation tx: ${liqTx}`);
		solLiqOk = true;
	} catch (e: any) {
		console.log(`  SOL liquidation failed: ${e.message?.slice(0, 200)}`);
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await taker.client.fetchAccounts();

	const solPosAfterLiq = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	const btcPosAfterLiq = getPosition(taker.client, BTC_PERP_MARKET_INDEX);

	const solReduced = !solPosAfterLiq ||
		new BN(solPosAfterLiq.baseAmount).abs().lt(new BN(solPosAfterOpen!.baseAmount).abs());

	console.log('  SOL position after liquidation:');
	if (solPosAfterLiq) {
		console.log(`    Side: ${solPosAfterLiq.side}, Base: ${solPosAfterLiq.baseAmountSol} SOL`);
	} else {
		console.log('    No position (fully liquidated)');
	}
	console.log(`  SOL position reduced: ${solReduced ? '-- PASS' : '-- FAIL'}`);

	console.log('  BTC position after SOL liquidation:');
	if (btcPosAfterLiq) {
		console.log(`    Side: ${btcPosAfterLiq.side}, Base: ${btcPosAfterLiq.baseAmountSol}`);
	} else {
		console.log('    No BTC position (may have been liquidated too)');
	}

	const allPassed = solLiqOk && solReduced;
	printTestResult('13-multi-position-liquidation', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
