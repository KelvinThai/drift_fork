/**
 * Test 23: BTC-PERP and ETH-PERP Fills
 *
 * 1. Setup BTC-PERP ($60000) and ETH-PERP ($3000)
 * 2. Do a cross fill on BTC-PERP (maker SELL + taker BUY)
 * 3. Do a cross fill on ETH-PERP (maker SELL + taker BUY)
 * 4. Verify positions on both markets
 */
import {
	PositionDirection,
	PostOnlyParams,
	BASE_PRECISION,
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
	BTC_PERP_MARKET_INDEX,
	ETH_PERP_MARKET_INDEX,
	RPC_ENDPOINT,
} from './setup/config';

const BTC_SIZE = BASE_PRECISION.divn(5000);  // 0.0002 BTC
const ETH_SIZE = BASE_PRECISION.divn(10);    // 0.1 ETH

async function main() {
	console.log('\n=== Test 23: BTC-PERP and ETH-PERP Fills ===');
	console.log(`RPC: ${RPC_ENDPOINT}\n`);

	const ctx = await createAdminClient();
	await ensureAdminCollateral(ctx);
	await cancelAllOrders(ctx.client);

	await setupMarket(ctx.client, BTC_PERP_MARKET_INDEX, 60000);
	await setupMarket(ctx.client, ETH_PERP_MARKET_INDEX, 3000);

	// ── BTC-PERP Fill ──
	console.log('\n--- BTC-PERP: Cross fill ---');
	const btcTaker = await createTaker(ctx, undefined, 'btcTaker');
	const btcTakerPubkey = getUserAccountPublicKeySync(
		ctx.programId, btcTaker.keypair.publicKey, 0
	);
	const { oraclePrice: btcPrice } = getOraclePriceSnapped(ctx.client, BTC_PERP_MARKET_INDEX);
	console.log(`  BTC oracle: ${btcPrice.toString()}`);

	const btcMakerOid = await placeLimitOrder(ctx.client, {
		marketIndex: BTC_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: BTC_SIZE,
		price: btcPrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 1,
	});

	const btcAuctionEnd = btcPrice.muln(102).divn(100);
	const btcTakerOid = await placeMarketOrder(btcTaker.client, {
		marketIndex: BTC_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: BTC_SIZE,
		price: btcAuctionEnd,
		auctionStartPrice: btcPrice,
		auctionEndPrice: btcAuctionEnd,
		auctionDuration: 10,
		userOrderId: 1,
	});

	await ctx.client.fetchAccounts();
	await btcTaker.client.fetchAccounts();
	const btcTO = findOpenOrder(btcTaker.client, btcTakerOid);
	const btcMO = findOpenOrder(ctx.client, btcMakerOid);

	if (btcTO && btcMO) {
		const makerInfo = buildMakerInfo(
			ctx.programId, ctx.keypair, ctx.client, ctx.adminSubAccountId, btcMO
		);
		await directFill(ctx.client, btcTakerPubkey, btcTaker.client.getUserAccount()!, btcTO, makerInfo);
	}

	await sleep(2000);
	await btcTaker.client.fetchAccounts();
	const btcPos = getPosition(btcTaker.client, BTC_PERP_MARKET_INDEX);
	const btcOk = btcPos?.side === 'LONG';
	console.log(`  BTC position: ${btcPos ? `${btcPos.side} ${btcPos.baseAmountSol}` : 'none'} ${btcOk ? '-- PASS' : '-- FAIL'}`);

	// ── ETH-PERP Fill ──
	console.log('\n--- ETH-PERP: Cross fill ---');
	await cancelAllOrders(ctx.client);
	const ethTaker = await createTaker(ctx, undefined, 'ethTaker');
	const ethTakerPubkey = getUserAccountPublicKeySync(
		ctx.programId, ethTaker.keypair.publicKey, 0
	);
	const { oraclePrice: ethPrice } = getOraclePriceSnapped(ctx.client, ETH_PERP_MARKET_INDEX);
	console.log(`  ETH oracle: ${ethPrice.toString()}`);

	const ethMakerOid = await placeLimitOrder(ctx.client, {
		marketIndex: ETH_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: ETH_SIZE,
		price: ethPrice,
		postOnly: PostOnlyParams.MUST_POST_ONLY,
		userOrderId: 2,
	});

	const ethAuctionEnd = ethPrice.muln(102).divn(100);
	const ethTakerOid = await placeMarketOrder(ethTaker.client, {
		marketIndex: ETH_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: ETH_SIZE,
		price: ethAuctionEnd,
		auctionStartPrice: ethPrice,
		auctionEndPrice: ethAuctionEnd,
		auctionDuration: 10,
		userOrderId: 1,
	});

	await ctx.client.fetchAccounts();
	await ethTaker.client.fetchAccounts();
	const ethTO = findOpenOrder(ethTaker.client, ethTakerOid);
	const ethMO = findOpenOrder(ctx.client, ethMakerOid);

	if (ethTO && ethMO) {
		const makerInfo = buildMakerInfo(
			ctx.programId, ctx.keypair, ctx.client, ctx.adminSubAccountId, ethMO
		);
		await directFill(ctx.client, ethTakerPubkey, ethTaker.client.getUserAccount()!, ethTO, makerInfo);
	}

	await sleep(2000);
	await ethTaker.client.fetchAccounts();
	const ethPos = getPosition(ethTaker.client, ETH_PERP_MARKET_INDEX);
	const ethOk = ethPos?.side === 'LONG';
	console.log(`  ETH position: ${ethPos ? `${ethPos.side} ${ethPos.baseAmountSol}` : 'none'} ${ethOk ? '-- PASS' : '-- FAIL'}`);

	const allPassed = btcOk && ethOk;
	printTestResult('23-btc-eth-fills', allPassed);

	await cancelAllOrders(ctx.client);
	await cleanupClients(ctx.client, btcTaker.client, ethTaker.client);
	console.log('Done.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
