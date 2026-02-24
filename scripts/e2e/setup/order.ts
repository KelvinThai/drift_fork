import { BN } from '@coral-xyz/anchor';
import {
	AdminClient,
	DriftClient,
	PositionDirection,
	PostOnlyParams,
	getLimitOrderParams,
	getMarketOrderParams,
} from '../../../sdk/src';

/**
 * Get oracle price for a perp market, snapped to the tick size grid.
 * Returns { oraclePrice, tickSize } with raw BN values.
 */
export function getOraclePriceSnapped(
	client: DriftClient | AdminClient,
	marketIndex: number
): { oraclePrice: BN; tickSize: BN } {
	const oracleData = client.getOracleDataForPerpMarket(marketIndex);
	const perpMarket = client.getPerpMarketAccount(marketIndex);
	const tickSize = perpMarket!.amm.orderTickSize;
	const oraclePrice = oracleData.price.div(tickSize).mul(tickSize);
	return { oraclePrice, tickSize };
}

export interface LimitOrderParams {
	marketIndex: number;
	direction: PositionDirection;
	baseAssetAmount: BN;
	price: BN;
	postOnly?: PostOnlyParams;
	userOrderId?: number;
}

/**
 * Place a limit order and verify it on-chain.
 * Returns the order's userOrderId.
 */
export async function placeLimitOrder(
	client: DriftClient | AdminClient,
	params: LimitOrderParams
): Promise<number> {
	const userOrderId = params.userOrderId ?? Math.floor(Math.random() * 250) + 1;
	const orderParams = getLimitOrderParams({
		marketIndex: params.marketIndex,
		direction: params.direction,
		baseAssetAmount: params.baseAssetAmount,
		price: params.price,
		postOnly: params.postOnly ?? PostOnlyParams.NONE,
		userOrderId,
	});

	const tx = await client.placePerpOrder(orderParams);
	const side = params.direction === PositionDirection.LONG ? 'BUY' : 'SELL';
	console.log(`  Placed LIMIT ${side} order (userOrderId=${userOrderId}). Tx: ${tx}`);

	// Verify on-chain
	await client.fetchAccounts();
	const orders = client.getUserAccount()?.orders;
	const order = orders?.find((o: any) => o.userOrderId === userOrderId);
	if (order && !order.baseAssetAmount.isZero()) {
		console.log(
			`  Confirmed on-chain: orderId=${order.orderId}, ` +
			`baseAmount=${order.baseAssetAmount.toString()}, ` +
			`price=${order.price.toString()}`
		);
	}

	return userOrderId;
}

export interface MarketOrderParams {
	marketIndex: number;
	direction: PositionDirection;
	baseAssetAmount: BN;
	price?: BN;
	auctionStartPrice?: BN;
	auctionEndPrice?: BN;
	auctionDuration?: number;
	userOrderId?: number;
}

/**
 * Place a market order and verify it on-chain.
 * Returns the order's userOrderId.
 */
export async function placeMarketOrder(
	client: DriftClient | AdminClient,
	params: MarketOrderParams
): Promise<number> {
	const userOrderId = params.userOrderId ?? Math.floor(Math.random() * 250) + 1;
	const orderParams = getMarketOrderParams({
		marketIndex: params.marketIndex,
		direction: params.direction,
		baseAssetAmount: params.baseAssetAmount,
		price: params.price,
		auctionStartPrice: params.auctionStartPrice,
		auctionEndPrice: params.auctionEndPrice,
		auctionDuration: params.auctionDuration,
		userOrderId,
	});

	const tx = await client.placePerpOrder(orderParams);
	const side = params.direction === PositionDirection.LONG ? 'BUY' : 'SELL';
	console.log(`  Placed MARKET ${side} order (userOrderId=${userOrderId}). Tx: ${tx}`);

	// Verify on-chain
	await client.fetchAccounts();
	const orders = client.getUserAccount()?.orders;
	const order = orders?.find((o: any) => o.userOrderId === userOrderId);
	if (order && !order.baseAssetAmount.isZero()) {
		console.log(
			`  Confirmed on-chain: orderId=${order.orderId}, ` +
			`baseAmount=${order.baseAssetAmount.toString()}, ` +
			`price=${order.price.toString()}, ` +
			`auctionDuration=${order.auctionDuration}`
		);
	}

	return userOrderId;
}

/**
 * Find an open order by userOrderId.
 */
export function findOpenOrder(
	client: DriftClient | AdminClient,
	userOrderId: number
): any | null {
	const orders = client.getUserAccount()?.orders;
	return orders?.find(
		(o: any) => !o.baseAssetAmount.isZero() && o.userOrderId === userOrderId
	) ?? null;
}

/**
 * Cancel all open orders for a client.
 */
export async function cancelAllOrders(
	client: DriftClient | AdminClient
): Promise<void> {
	const userAccount = client.getUserAccount();
	const existingOrders = userAccount?.orders?.filter(
		(o: any) => !o.baseAssetAmount.isZero()
	);
	if (existingOrders && existingOrders.length > 0) {
		console.log(`  Cancelling ${existingOrders.length} existing order(s)...`);
		await client.cancelOrders();
		console.log('  Cancelled.');
	}
}
