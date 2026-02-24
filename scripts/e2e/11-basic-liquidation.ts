/**
 * Test 11: Basic Perp Liquidation
 *
 * 1. Create taker with small collateral ($5 USDC)
 * 2. Open LONG 0.1 SOL at oracle ($150) via market order + maker
 * 3. Move oracle down to $100 (causes unrealized loss > collateral)
 * 4. Verify taker canBeLiquidated
 * 5. Admin calls liquidatePerp
 * 6. Verify taker position reduced/closed
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

const SMALL_COLLATERAL = new BN(5).mul(QUOTE_PRECISION); // $5 USDC

async function main() {
	console.log('\n=== Test 11: Basic Perp Liquidation ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	const taker = await createTaker(ctx, SMALL_COLLATERAL);
	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);
	console.log(`\n  Oracle: ${oraclePrice.toString()}`);

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
		console.log('  Failed to open position — cannot test liquidation');
		printTestResult('11-basic-liquidation', false);
		await cleanupClients(ctx.client, taker.client);
		return;
	}

	// ── Step 2: Move oracle down to $100 ──
	console.log('\n--- Step 2: Move oracle to $100 ---');
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 100);
	await sleep(2000);
	await taker.client.fetchAccounts();

	// ── Step 3: Check liquidation eligibility ──
	console.log('\n--- Step 3: Check liquidation eligibility ---');
	const takerUser = taker.client.getUser();
	const liqStatus = takerUser.canBeLiquidated();
	console.log(`  canBeLiquidated: ${liqStatus.canBeLiquidated}`);
	console.log(`  totalCollateral: ${liqStatus.totalCollateral.toString()}`);
	console.log(`  marginRequirement: ${liqStatus.marginRequirement.toString()}`);

	// ── Step 4: Liquidate ──
	console.log('\n--- Step 4: Liquidate ---');
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
		if (e.logs) {
			e.logs.filter((l: string) => l.includes('Error') || l.includes('error'))
				.forEach((l: string) => console.log(`    ${l}`));
		}
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await taker.client.fetchAccounts();

	const posAfterLiq = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	const posReduced = !posAfterLiq ||
		new BN(posAfterLiq.baseAmount).abs().lt(new BN(posAfterOpen.baseAmount).abs());

	console.log('  Taker position after liquidation:');
	if (posAfterLiq) {
		console.log(`    Side: ${posAfterLiq.side}, Base: ${posAfterLiq.baseAmountSol} SOL`);
	} else {
		console.log('    No position (fully liquidated)');
	}
	console.log(`  Position reduced/closed: ${posReduced ? '-- PASS' : '-- FAIL'}`);
	console.log(`  Liquidation succeeded: ${liquidated ? '-- PASS' : '-- FAIL'}`);

	const allPassed = liquidated && posReduced;
	printTestResult('11-basic-liquidation', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
