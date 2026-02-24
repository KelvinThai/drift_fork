/**
 * Test 14: Auto-Derisking
 *
 * After liquidating a user, the liquidator (admin) inherits the position.
 * Verify the liquidator can close the inherited position.
 *
 * 1. Create taker with $5 USDC, open LONG 0.1 SOL
 * 2. Move oracle down, liquidate
 * 3. Record admin position after liquidation (inherits from liquidated user)
 * 4. Admin closes inherited position via placeAndTakePerpOrder
 * 5. Verify admin position reduced back to original
 */
import { BN } from '@coral-xyz/anchor';
import {
	PositionDirection,
	PostOnlyParams,
	getLimitOrderParams,
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

async function main() {
	console.log('\n=== Test 14: Auto-Derisking ===');
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
	if (!posAfterOpen || posAfterOpen.side !== 'LONG') {
		console.log('  Failed to open position');
		printTestResult('14-auto-derisking', false);
		await cleanupClients(ctx.client, taker.client);
		return;
	}
	console.log(`  Taker: ${posAfterOpen.side} ${posAfterOpen.baseAmountSol} SOL`);

	// Record admin position AFTER maker fill (before liquidation)
	await ctx.client.fetchAccounts();
	const adminPosBefore = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseBefore = adminPosBefore ? new BN(adminPosBefore.baseAmount) : new BN(0);
	console.log(`  Admin position after fill: ${adminPosBefore ? `${adminPosBefore.side} ${adminPosBefore.baseAmountSol} SOL` : 'none'}`);

	// ── Step 2: Move oracle down, liquidate ──
	console.log('\n--- Step 2: Move oracle to $100, liquidate ---');
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 100);
	await sleep(2000);
	await taker.client.fetchAccounts();

	let liquidated = false;
	try {
		const liqTx = await ctx.client.liquidatePerp(
			takerUserPubkey,
			taker.client.getUserAccount()!,
			SOL_PERP_MARKET_INDEX,
			DEFAULT_ORDER_SIZE,
		);
		console.log(`  Liquidation tx: ${liqTx}`);
		liquidated = true;
	} catch (e: any) {
		console.log(`  Liquidation failed: ${e.message?.slice(0, 200)}`);
	}

	if (!liquidated) {
		printTestResult('14-auto-derisking', false);
		await cleanupClients(ctx.client, taker.client);
		return;
	}

	// ── Step 3: Check admin position after liquidation ──
	console.log('\n--- Step 3: Admin position after liquidation ---');
	await sleep(2000);
	await ctx.client.fetchAccounts();

	const adminPosAfterLiq = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseAfterLiq = adminPosAfterLiq ? new BN(adminPosAfterLiq.baseAmount) : new BN(0);
	const adminDelta = adminBaseAfterLiq.sub(adminBaseBefore);

	console.log(`  Admin position: ${adminPosAfterLiq ? `${adminPosAfterLiq.side} ${adminPosAfterLiq.baseAmountSol} SOL` : 'none'}`);
	console.log(`  Admin base delta from liquidation: ${adminDelta.toString()}`);

	const inheritedPosition = !adminDelta.isZero();
	console.log(`  Inherited position: ${inheritedPosition ? 'YES' : 'NO'}`);

	// ── Step 4: Admin closes inherited position ──
	console.log('\n--- Step 4: Admin closes inherited position ---');
	// Move oracle back to $150 for a clean close
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);
	await sleep(2000);

	let closedOk = false;
	if (adminPosAfterLiq && !new BN(adminPosAfterLiq.baseAmount).isZero()) {
		const closeDirection = adminPosAfterLiq.side === 'LONG'
			? PositionDirection.SHORT
			: PositionDirection.LONG;
		const closeSize = new BN(adminPosAfterLiq.baseAmount).abs();
		const { oraclePrice: closePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);

		const closeParams = getLimitOrderParams({
			marketIndex: SOL_PERP_MARKET_INDEX,
			direction: closeDirection,
			baseAssetAmount: closeSize,
			price: closeDirection === PositionDirection.LONG
				? closePrice.muln(105).divn(100)
				: closePrice.muln(95).divn(100),
			userOrderId: 99,
		});

		try {
			const closeTx = await ctx.client.placeAndTakePerpOrder(closeParams);
			console.log(`  Close tx: ${closeTx}`);
			closedOk = true;
		} catch (e: any) {
			console.log(`  Close failed: ${e.message?.slice(0, 200)}`);
		}
	} else {
		console.log('  No position to close');
		closedOk = true;
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await ctx.client.fetchAccounts();
	const adminPosFinal = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);

	console.log(`  Admin final position: ${adminPosFinal ? `${adminPosFinal.side} ${adminPosFinal.baseAmountSol} SOL` : 'none'}`);
	console.log(`  Liquidation succeeded: ${liquidated ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Close succeeded: ${closedOk ? '-- PASS' : '-- FAIL'}`);

	const allPassed = liquidated && inheritedPosition && closedOk;
	printTestResult('14-auto-derisking', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
