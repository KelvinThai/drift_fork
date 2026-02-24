/**
 * Test 22: Cross-Margin Leverage
 *
 * 1. Setup SOL-PERP ($150) and BTC-PERP ($60000)
 * 2. Create taker with $100 USDC
 * 3. Open LONG 0.1 SOL (~$15) and LONG 0.0002 BTC (~$12)
 * 4. Verify margin is calculated across both positions
 * 5. Check health, leverage, and total collateral
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

const COLLATERAL = new BN(100).mul(QUOTE_PRECISION);
const BTC_ORDER_SIZE = BASE_PRECISION.divn(5000); // 0.0002 BTC

async function main() {
	console.log('\n=== Test 22: Cross-Margin Leverage ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);

	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);
	await setupMarket(ctx.client, BTC_PERP_MARKET_INDEX, 60000);

	const taker = await createTaker(ctx, COLLATERAL);
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
	const solPos = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	console.log(`  SOL: ${solPos ? `${solPos.side} ${solPos.baseAmountSol} SOL` : 'none'}`);

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
	const btcPos = getPosition(taker.client, BTC_PERP_MARKET_INDEX);
	console.log(`  BTC: ${btcPos ? `${btcPos.side} ${btcPos.baseAmountSol}` : 'none'}`);

	const bothPositions = solPos?.side === 'LONG' && btcPos?.side === 'LONG';

	// ── Step 3: Verify cross-margin ──
	console.log('\n--- Step 3: Cross-margin verification ---');
	const takerUser = taker.client.getUser();
	const health = takerUser.getHealth();
	const totalCollateral = takerUser.getTotalCollateral('Initial');
	const marginRatio = takerUser.getMarginRatio();
	const liqStatus = takerUser.canBeLiquidated();

	console.log(`  Health: ${health}`);
	console.log(`  Total collateral (Initial): ${totalCollateral.toString()}`);
	console.log(`  Margin ratio: ${marginRatio.toString()}`);
	console.log(`  canBeLiquidated: ${liqStatus.canBeLiquidated}`);

	console.log(`\n  Both positions open: ${bothPositions ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Health > 0: ${health > 0 ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Not liquidatable: ${!liqStatus.canBeLiquidated ? '-- PASS' : '-- FAIL'}`);

	const allPassed = bothPositions && health > 0 && !liqStatus.canBeLiquidated;
	printTestResult('22-cross-margin-leverage', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
