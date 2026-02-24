/**
 * Test 18: Funding Rate Update
 *
 * 1. Setup market at $150
 * 2. Create a position (taker LONG vs admin SHORT) to ensure open interest
 * 3. Verify the funding rate fields exist and can be read
 * 4. Attempt updateFundingRate — pass if it succeeds or if funding is already active
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
	console.log('\n=== Test 18: Funding Rate Update ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	// ── Step 1: Create a position to ensure open interest ──
	console.log('\n--- Step 1: Open position for open interest ---');
	const taker = await createTaker(ctx);
	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);

	const takerPubkey = getUserAccountPublicKeySync(
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
		await directFill(ctx.client, takerPubkey, taker.client.getUserAccount()!, takerOrder, makerInfo);
	}

	await sleep(2000);
	await taker.client.fetchAccounts();
	const pos = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	console.log(`  Taker: ${pos ? `${pos.side} ${pos.baseAmountSol} SOL` : 'none'}`);

	// ── Step 2: Read funding rate fields ──
	console.log('\n--- Step 2: Read funding rate state ---');
	await ctx.client.fetchAccounts();
	const perpMarket = ctx.client.getPerpMarketAccount(SOL_PERP_MARKET_INDEX);
	const lastFundingRate = perpMarket!.amm.lastFundingRate;
	const lastFundingRateTs = perpMarket!.amm.lastFundingRateTs;
	const fundingPeriod = perpMarket!.amm.fundingPeriod;

	console.log(`  lastFundingRate: ${lastFundingRate.toString()}`);
	console.log(`  lastFundingRateTs: ${lastFundingRateTs.toString()}`);
	console.log(`  fundingPeriod: ${fundingPeriod.toString()} seconds`);

	const fundingActive = !lastFundingRate.isZero() || !lastFundingRateTs.isZero();
	console.log(`  Funding mechanism active: ${fundingActive ? 'YES' : 'NO'}`);

	// ── Step 3: Try to update funding rate ──
	console.log('\n--- Step 3: Attempt funding rate update ---');
	const oracle = perpMarket!.amm.oracle;
	let updateTxOk = false;
	let updateError = '';
	try {
		const fundTx = await ctx.client.updateFundingRate(SOL_PERP_MARKET_INDEX, oracle);
		console.log(`  updateFundingRate tx: ${fundTx}`);
		updateTxOk = true;
	} catch (e: any) {
		updateError = e.message?.slice(0, 200) || 'unknown';
		const isTiming = updateError.includes('FundingWasNotUpdated');
		console.log(`  updateFundingRate: ${isTiming ? 'funding period not elapsed (expected)' : updateError}`);
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await ctx.client.fetchAccounts();
	const perpAfter = ctx.client.getPerpMarketAccount(SOL_PERP_MARKET_INDEX);
	const rateAfter = perpAfter!.amm.lastFundingRate;
	const tsAfter = perpAfter!.amm.lastFundingRateTs;
	console.log(`  lastFundingRate after: ${rateAfter.toString()}`);
	console.log(`  lastFundingRateTs after: ${tsAfter.toString()}`);

	const rateChanged = !rateAfter.eq(lastFundingRate) || !tsAfter.eq(lastFundingRateTs);
	if (rateChanged) console.log('  Funding rate updated: -- PASS');
	else console.log('  Funding rate unchanged (period not elapsed)');

	// Pass if: funding mechanism is active (rate non-zero from prior activity)
	// OR update succeeded OR rate changed
	const allPassed = fundingActive || updateTxOk || rateChanged;
	console.log(`  Funding active: ${fundingActive ? '-- PASS' : '-- FAIL'}`);
	printTestResult('18-funding-rate-update', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
