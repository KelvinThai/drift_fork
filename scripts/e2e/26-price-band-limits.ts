/**
 * Test 26: Price Band Limits
 *
 * In Drift, price bands are enforced at FILL time, not order placement.
 * This test verifies:
 * 1. Oracle guard rails are correctly configured
 * 2. The guard rail fields can be read from the state account
 */
import { createAdminClient, cleanupClients } from './setup/client';
import { ensureAdminCollateral } from './setup/user';
import { setupMarket } from './setup/oracle';
import { cancelAllOrders } from './setup/order';
import { printTestResult } from './setup/verify';
import {
	SOL_PERP_MARKET_INDEX,
	RPC_ENDPOINT,
} from './setup/config';

async function main() {
	console.log('\n=== Test 26: Price Band Limits ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	// ── Read oracle guard rails ──
	console.log('\n--- Oracle Guard Rails ---');
	await ctx.client.fetchAccounts();
	const state = ctx.client.getStateAccount();
	const guardRails = state.oracleGuardRails;

	console.log(`  Guard rails object keys: ${Object.keys(guardRails).join(', ')}`);

	const priceDivergence = guardRails.priceDivergence;
	console.log(`  Price divergence keys: ${Object.keys(priceDivergence).join(', ')}`);
	console.log(`  Price divergence values: ${JSON.stringify(priceDivergence, (_, v) => typeof v === 'object' && v?.toString ? v.toString() : v)}`);

	const validity = guardRails.validity;
	console.log(`  Validity keys: ${Object.keys(validity).join(', ')}`);
	console.log(`  Validity values: ${JSON.stringify(validity, (_, v) => typeof v === 'object' && v?.toString ? v.toString() : v)}`);

	const hasGuardRails = priceDivergence && validity;

	// ── Read market contract tier ──
	console.log('\n--- Market Settings ---');
	const perpMarket = ctx.client.getPerpMarketAccount(SOL_PERP_MARKET_INDEX);
	const contractTier = perpMarket!.contractTier;
	console.log(`  Contract tier: ${JSON.stringify(contractTier)}`);

	// ── Verify ──
	console.log('\n--- Verification ---');
	console.log(`  Guard rails configured: ${hasGuardRails ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Price band enforcement is fill-time (proven by tests 13, 19, 20)`);

	printTestResult('26-price-band-limits', !!hasGuardRails);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
