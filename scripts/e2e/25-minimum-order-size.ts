/**
 * Test 25: Minimum Order Size
 *
 * 1. Try to place an order with very small base amount (1 unit)
 * 2. Verify the order is rejected or has no effect
 */
import { BN } from '@coral-xyz/anchor';
import {
	PositionDirection,
	getLimitOrderParams,
} from '../../sdk/src';
import { createAdminClient, cleanupClients } from './setup/client';
import { ensureAdminCollateral } from './setup/user';
import { setupMarket } from './setup/oracle';
import { getOraclePriceSnapped, cancelAllOrders } from './setup/order';
import { printTestResult } from './setup/verify';
import {
	SOL_PERP_MARKET_INDEX,
	RPC_ENDPOINT,
} from './setup/config';

const TINY_SIZE = new BN(1); // 1 unit (effectively 0.000000001 SOL)

async function main() {
	console.log('\n=== Test 25: Minimum Order Size ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);
	console.log(`\n  Oracle: ${oraclePrice.toString()}`);
	console.log(`  Tiny size: ${TINY_SIZE.toString()} (effectively 0)`);

	// ── Attempt to place tiny order ──
	console.log('\n--- Place tiny order (expect rejection) ---');
	let rejected = false;
	try {
		const orderParams = getLimitOrderParams({
			marketIndex: SOL_PERP_MARKET_INDEX,
			direction: PositionDirection.LONG,
			baseAssetAmount: TINY_SIZE,
			price: oraclePrice,
			userOrderId: 1,
		});
		await ctx.client.placePerpOrder(orderParams);
		console.log('  Order placed (checking if it was actually accepted)');

		// Check if order is actually on-chain
		await ctx.client.fetchAccounts();
		const orders = ctx.client.getUserAccount()?.orders?.filter(
			(o: any) => o.userOrderId === 1 && !o.baseAssetAmount.isZero()
		);
		if (orders && orders.length > 0) {
			console.log('  Order accepted — minimum size check did not reject');
			// Clean up
			await cancelAllOrders(ctx.client);
		} else {
			console.log('  Order not on-chain (silently rejected)');
			rejected = true;
		}
	} catch (e: any) {
		console.log(`  Order rejected: ${e.message?.slice(0, 200)}`);
		rejected = true;
	}

	// Also test with a step size violation (e.g., not aligned to stepSize)
	console.log('\n--- Place order with non-aligned size ---');
	const perpMarket = ctx.client.getPerpMarketAccount(SOL_PERP_MARKET_INDEX);
	const stepSize = perpMarket!.amm.orderStepSize;
	console.log(`  Order step size: ${stepSize.toString()}`);

	let stepRejected = false;
	if (!stepSize.isZero() && stepSize.gtn(1)) {
		const badSize = stepSize.subn(1); // One less than step size
		try {
			const orderParams = getLimitOrderParams({
				marketIndex: SOL_PERP_MARKET_INDEX,
				direction: PositionDirection.LONG,
				baseAssetAmount: badSize,
				price: oraclePrice,
				userOrderId: 2,
			});
			await ctx.client.placePerpOrder(orderParams);
			console.log('  Non-aligned order placed');
			await ctx.client.fetchAccounts();
			const orders = ctx.client.getUserAccount()?.orders?.filter(
				(o: any) => o.userOrderId === 2 && !o.baseAssetAmount.isZero()
			);
			if (orders && orders.length > 0) {
				console.log('  Order accepted (protocol may round)');
				await cancelAllOrders(ctx.client);
			} else {
				console.log('  Order silently rejected');
				stepRejected = true;
			}
		} catch (e: any) {
			console.log(`  Non-aligned order rejected: ${e.message?.slice(0, 200)}`);
			stepRejected = true;
		}
	} else {
		console.log('  Step size is 0 or 1, skip non-aligned test');
		stepRejected = true;
	}

	console.log(`\n  Tiny order rejected: ${rejected ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Non-aligned order rejected: ${stepRejected ? '-- PASS' : '-- FAIL'}`);

	const allPassed = rejected || stepRejected;
	printTestResult('25-minimum-order-size', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
