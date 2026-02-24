/**
 * Test 10: Immediate-or-Cancel (IOC)
 *
 * IOC orders must use placeAndTakePerpOrder.
 * 1. Maker SELL 0.05 SOL at oracle
 * 2. Taker places IOC BUY 0.1 SOL via placeAndTakePerpOrder
 *    → fills 0.05 SOL against maker, unfilled portion cancelled
 * 3. Verify taker has LONG 0.05 SOL (not 0.1)
 */
import { BN } from '@coral-xyz/anchor';
import {
	PositionDirection,
	PostOnlyParams,
	getLimitOrderParams,
	BASE_PRECISION,
	OrderParamsBitFlag,
} from '../../sdk/src';
import { createAdminClient, cleanupClients } from './setup/client';
import { ensureAdminCollateral, createTaker } from './setup/user';
import { setupMarket } from './setup/oracle';
import {
	getOraclePriceSnapped,
	placeLimitOrder,
	cancelAllOrders,
} from './setup/order';
import { buildMakerInfo } from './setup/fill';
import { printTestResult, getPosition } from './setup/verify';
import { sleep } from './setup/helpers';
import {
	SOL_PERP_MARKET_INDEX,
	RPC_ENDPOINT,
} from './setup/config';

const MAKER_SIZE = BASE_PRECISION.divn(20); // 0.05 SOL
const TAKER_SIZE = BASE_PRECISION.divn(10); // 0.1 SOL

async function main() {
	console.log('\n=== Test 10: Immediate-or-Cancel (IOC) ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);
	await setupMarket(ctx.client, SOL_PERP_MARKET_INDEX, 150);

	const taker = await createTaker(ctx);
	const { oraclePrice } = getOraclePriceSnapped(ctx.client, SOL_PERP_MARKET_INDEX);
	console.log(`\n  Oracle: ${oraclePrice.toString()}`);
	console.log(`  Maker SELL size: ${MAKER_SIZE.toString()} (0.05 SOL)`);
	console.log(`  Taker IOC BUY size: ${TAKER_SIZE.toString()} (0.1 SOL)`);

	// Record admin position before
	await ctx.client.fetchAccounts();
	const adminPosBefore = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseBefore = adminPosBefore ? new BN(adminPosBefore.baseAmount) : new BN(0);

	// ── Maker: SELL 0.05 SOL at oracle ──
	console.log('\n--- Maker SELL 0.05 SOL ---');
	const makerOrderId = await placeLimitOrder(ctx.client, {
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: MAKER_SIZE,
		price: oraclePrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 1,
	});

	// ── Taker: IOC BUY 0.1 SOL via placeAndTakePerpOrder ──
	console.log('\n--- Taker IOC BUY 0.1 SOL (placeAndTake) ---');
	await ctx.client.fetchAccounts();

	// Build maker info for the placeAndTake call
	const makerOrder = ctx.client.getUserAccount()?.orders?.find(
		(o: any) => !o.baseAssetAmount.isZero() && o.userOrderId === makerOrderId
	);
	const makerInfo = makerOrder ? buildMakerInfo(
		ctx.programId,
		ctx.keypair,
		ctx.client,
		ctx.adminSubAccountId,
		makerOrder
	) : undefined;

	const iocOrderParams = getLimitOrderParams({
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: TAKER_SIZE,
		price: oraclePrice,
		userOrderId: 1,
		bitFlags: OrderParamsBitFlag.ImmediateOrCancel,
	});

	try {
		const tx = await taker.client.placeAndTakePerpOrder(
			iocOrderParams,
			makerInfo
		);
		console.log(`  placeAndTake tx: ${tx}`);
	} catch (e: any) {
		console.log(`  placeAndTake failed: ${e.message?.slice(0, 150)}`);
		if (e.logs) {
			const errorLogs = e.logs.filter(
				(l: string) => l.includes('Error') || l.includes('error')
			);
			errorLogs.forEach((l: string) => console.log(`    ${l}`));
		}
	}

	// ── Verify ──
	console.log('\n--- Verification ---');
	await sleep(2000);
	await ctx.client.fetchAccounts();
	await taker.client.fetchAccounts();

	// Taker should have LONG <= 0.05 SOL (only maker portion)
	const takerPos = getPosition(taker.client, SOL_PERP_MARKET_INDEX);
	console.log('\n  Taker position:');
	let takerOk = false;
	if (takerPos) {
		console.log(`    Side: ${takerPos.side}`);
		console.log(`    Base: ${takerPos.baseAmount} (${takerPos.baseAmountSol} SOL)`);
		const takerBase = new BN(takerPos.baseAmount).abs();
		takerOk = takerPos.side === 'LONG' && takerBase.lte(MAKER_SIZE);
		console.log(`    Expected: LONG <= ${MAKER_SIZE.toString()} ${takerOk ? '-- PASS' : '-- FAIL'}`);
	} else {
		console.log('    No position (IOC may not have matched)');
	}

	// IOC order: check that the unfilled portion was NOT filled (no extra position)
	// IOC should only fill what's available, rest is discarded
	const takerBase = takerPos ? new BN(takerPos.baseAmount).abs() : new BN(0);
	const iocPartialOk = takerBase.lte(MAKER_SIZE); // didn't fill more than maker had
	console.log(`\n  IOC partial fill (no overfill): ${iocPartialOk ? '-- PASS' : '-- FAIL'}`);
	console.log(`    Filled: ${takerBase.toString()}, Maker had: ${MAKER_SIZE.toString()}, IOC wanted: ${TAKER_SIZE.toString()}`);

	// Maker delta
	const adminPosAfter = getPosition(ctx.client, SOL_PERP_MARKET_INDEX);
	const adminBaseAfter = adminPosAfter ? new BN(adminPosAfter.baseAmount) : new BN(0);
	const adminDelta = adminBaseAfter.sub(adminBaseBefore);
	const makerOk = adminDelta.abs().eq(MAKER_SIZE);
	console.log(`\n  Maker delta: ${adminDelta.toString()} (expected: -${MAKER_SIZE.toString()}) ${makerOk ? '-- PASS' : '-- FAIL'}`);

	const allPassed = takerOk && iocPartialOk && makerOk;
	printTestResult('10-immediate-or-cancel', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, taker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
