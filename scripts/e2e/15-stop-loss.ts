/**
 * Test 15: Stop-Loss (Trigger Market Order)
 *
 * 1. Open LONG 0.1 SOL at $150
 * 2. Place trigger SELL (stop-loss) with triggerCondition=BELOW, triggerPrice=$130
 * 3. Move oracle to $125 (below trigger)
 * 4. Call triggerOrder to fire the trigger
 * 5. Fill the triggered order against AMM
 * 6. Verify position closed/reduced
 */
import { BN } from '@coral-xyz/anchor';
import {
	PositionDirection,
	PostOnlyParams,
	OrderTriggerCondition,
	getTriggerMarketOrderParams,
	PRICE_PRECISION,
	MarketType,
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
	console.log('\n=== Test 15: Stop-Loss (Trigger Market) ===');
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
	if (!posAfterOpen || posAfterOpen.side !== 'LONG') {
		console.log('  Failed to open position');
		printTestResult('15-stop-loss', false);
		await cleanupClients(ctx.client, taker.client);
		return;
	}
	console.log(`  Position: ${posAfterOpen.side} ${posAfterOpen.baseAmountSol} SOL`);

	// ── Step 2: Place trigger SELL (stop-loss) ──
	console.log('\n--- Step 2: Place stop-loss trigger SELL at $130 ---');
	const triggerPrice = new BN(130).mul(PRICE_PRECISION).div(tickSize).mul(tickSize);
	console.log(`  Trigger price: ${triggerPrice.toString()} (condition: BELOW)`);

	const triggerParams = getTriggerMarketOrderParams({
		marketType: MarketType.PERP,
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: DEFAULT_ORDER_SIZE,
		triggerCondition: OrderTriggerCondition.BELOW,
		triggerPrice,
		reduceOnly: true,
		userOrderId: 2,
	});

	const triggerTx = await taker.client.placePerpOrder(triggerParams);
	console.log(`  Trigger order placed. Tx: ${triggerTx}`);

	await taker.client.fetchAccounts();
	const triggerOrder = findOpenOrder(taker.client, 2);
	const orderPlaced = triggerOrder !== null;
	console.log(`  Order on-chain: ${orderPlaced ? 'YES' : 'NO'}`);
	if (triggerOrder) {
		console.log(`  triggerPrice: ${triggerOrder.triggerPrice.toString()}`);
	}

	// ── Step 3: Move oracle to $125 ──
	console.log('\n--- Step 3: Move oracle to $125 ---');
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 125);
	await sleep(2000);

	// ── Step 4: Trigger the order ──
	console.log('\n--- Step 4: Trigger the stop-loss ---');
	await taker.client.fetchAccounts();
	const orderToTrigger = findOpenOrder(taker.client, 2);

	let triggered = false;
	if (orderToTrigger) {
		try {
			const trigTx = await ctx.client.triggerOrder(
				takerUserPubkey,
				taker.client.getUserAccount()!,
				orderToTrigger,
			);
			console.log(`  Trigger tx: ${trigTx}`);
			triggered = true;
		} catch (e: any) {
			console.log(`  Trigger failed: ${e.message?.slice(0, 200)}`);
			if (e.logs) {
				e.logs.filter((l: string) => l.includes('Error') || l.includes('error'))
					.forEach((l: string) => console.log(`    ${l}`));
			}
		}
	} else {
		console.log('  Trigger order not found');
	}

	// ── Step 5: Fill the triggered order ──
	console.log('\n--- Step 5: Fill triggered order ---');
	await sleep(2000);
	await taker.client.fetchAccounts();
	const triggeredOrder = findOpenOrder(taker.client, 2);

	if (triggeredOrder) {
		await directFill(
			ctx.client,
			takerUserPubkey,
			taker.client.getUserAccount()!,
			triggeredOrder
		);
	} else {
		console.log('  Order already consumed or not found');
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await taker.client.fetchAccounts();

	const posAfterStop = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	const posReduced = !posAfterStop ||
		new BN(posAfterStop.baseAmount).abs().lt(new BN(posAfterOpen.baseAmount).abs());

	console.log('  Position after stop-loss:');
	if (posAfterStop) {
		console.log(`    Side: ${posAfterStop.side}, Base: ${posAfterStop.baseAmountSol} SOL`);
	} else {
		console.log('    No position (closed by stop-loss)');
	}
	console.log(`  Trigger order placed: ${orderPlaced ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Order triggered: ${triggered ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Position reduced/closed: ${posReduced ? '-- PASS' : '-- FAIL'}`);

	const allPassed = orderPlaced && triggered && posReduced;
	printTestResult('15-stop-loss', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
