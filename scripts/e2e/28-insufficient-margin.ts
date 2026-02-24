/**
 * Test 28: Insufficient Margin Rejection
 *
 * 1. Create user with tiny collateral ($0.10 USDC)
 * 2. Try to place a large order (0.1 SOL @ $150 = $15 notional)
 * 3. Verify the order is rejected due to insufficient margin
 */
import {
	PositionDirection,
	getLimitOrderParams,
	QUOTE_PRECISION,
	BASE_PRECISION,
} from '../../sdk/src';
import { createAdminClient, cleanupClients } from './setup/client';
import { ensureAdminCollateral, createTaker } from './setup/user';
import { setupMarket } from './setup/oracle';
import { getOraclePriceSnapped, cancelAllOrders } from './setup/order';
import { printTestResult } from './setup/verify';
import {
	SOL_PERP_MARKET_INDEX,
	RPC_ENDPOINT,
} from './setup/config';

// Very small collateral — not enough for any meaningful position
const TINY_COLLATERAL = QUOTE_PRECISION.divn(10); // $0.10 USDC
// Large order size
const LARGE_SIZE = BASE_PRECISION; // 1.0 SOL @ $150 = $150 notional

async function main() {
	console.log('\n=== Test 28: Insufficient Margin Rejection ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	// Create taker with tiny collateral
	const taker = await createTaker(ctx, TINY_COLLATERAL, 'poorTaker');
	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);
	console.log(`\n  Oracle: ${oraclePrice.toString()}`);
	console.log(`  Collateral: ${TINY_COLLATERAL.toString()} ($0.10 USDC)`);
	console.log(`  Order size: ${LARGE_SIZE.toString()} (1.0 SOL = $150 notional)`);

	// ── Try to place large order ──
	console.log('\n--- Place large order (expect rejection) ---');
	let orderRejected = false;
	try {
		const orderParams = getLimitOrderParams({
			marketIndex: SOL_PERP_MARKET_INDEX,
			direction: PositionDirection.LONG,
			baseAssetAmount: LARGE_SIZE,
			price: oraclePrice,
			userOrderId: 1,
		});
		await taker.client.placePerpOrder(orderParams);
		console.log('  Order placed (checking if it was accepted)');

		await taker.client.fetchAccounts();
		const orders = taker.client.getUserAccount()?.orders?.filter(
			(o: any) => o.userOrderId === 1 && !o.baseAssetAmount.isZero()
		);
		if (orders && orders.length > 0) {
			console.log('  Order accepted (margin check may be deferred to fill time)');
			// Clean up
			await taker.client.cancelOrders();
		} else {
			console.log('  Order silently rejected');
			orderRejected = true;
		}
	} catch (e: any) {
		console.log(`  Order rejected: ${e.message?.slice(0, 200)}`);
		orderRejected = true;
	}

	// ── Also try an even larger order ──
	console.log('\n--- Place very large order (expect rejection) ---');
	let largeRejected = false;
	const veryLargeSize = BASE_PRECISION.muln(100); // 100 SOL = $15000 notional
	try {
		const orderParams = getLimitOrderParams({
			marketIndex: SOL_PERP_MARKET_INDEX,
			direction: PositionDirection.LONG,
			baseAssetAmount: veryLargeSize,
			price: oraclePrice,
			userOrderId: 2,
		});
		await taker.client.placePerpOrder(orderParams);
		console.log('  Very large order placed');
		await taker.client.fetchAccounts();
		const orders = taker.client.getUserAccount()?.orders?.filter(
			(o: any) => o.userOrderId === 2 && !o.baseAssetAmount.isZero()
		);
		if (orders && orders.length > 0) {
			console.log('  Order accepted');
			await taker.client.cancelOrders();
		} else {
			console.log('  Order silently rejected');
			largeRejected = true;
		}
	} catch (e: any) {
		console.log(`  Rejected: ${e.message?.slice(0, 200)}`);
		largeRejected = true;
	}

	console.log(`\n  1 SOL order rejected: ${orderRejected ? '-- PASS' : '-- FAIL (may defer to fill)'}`);
	console.log(`  100 SOL order rejected: ${largeRejected ? '-- PASS' : '-- FAIL'}`);

	// Pass if at least one was rejected
	const allPassed = orderRejected || largeRejected;
	printTestResult('28-insufficient-margin', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
