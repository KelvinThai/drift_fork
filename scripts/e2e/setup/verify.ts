import { BN } from '@coral-xyz/anchor';
import { DriftClient, AdminClient, BASE_PRECISION } from '../../../sdk/src';

export interface PositionInfo {
	side: 'LONG' | 'SHORT';
	baseAmount: string;
	baseAmountSol: number;
	quoteEntry: string;
}

/**
 * Get the current perp position for a market, or null if none.
 */
export function getPosition(
	client: DriftClient | AdminClient,
	marketIndex: number
): PositionInfo | null {
	const position = client.getUser().getPerpPosition(marketIndex);
	if (!position || position.baseAssetAmount.isZero()) {
		return null;
	}
	return {
		side: position.baseAssetAmount.isNeg() ? 'SHORT' : 'LONG',
		baseAmount: position.baseAssetAmount.toString(),
		baseAmountSol:
			position.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber(),
		quoteEntry: position.quoteEntryAmount.toString(),
	};
}

/**
 * Assert that a client has a position on the expected side.
 * Logs details and returns true if the assertion passes.
 */
export async function assertPosition(
	client: DriftClient | AdminClient,
	marketIndex: number,
	expectedSide: 'LONG' | 'SHORT',
	label: string
): Promise<boolean> {
	await client.fetchAccounts();
	const pos = getPosition(client, marketIndex);

	console.log(`\n  ${label} position:`);
	if (!pos) {
		console.log('    No position (order may not have filled)');
		return false;
	}

	console.log(`    Side: ${pos.side}`);
	console.log(`    Base amount: ${pos.baseAmount} (${pos.baseAmountSol} SOL)`);
	console.log(`    Quote entry: ${pos.quoteEntry}`);

	const ok = pos.side === expectedSide;
	console.log(`    Expected: ${expectedSide} ${ok ? '-- PASS' : '-- FAIL'}`);
	return ok;
}

/**
 * Assert that an order has the expected remaining (unfilled) base amount.
 * remaining = baseAssetAmount - baseAssetAmountFilled
 * Returns true if the assertion passes.
 */
export function assertOrderRemaining(
	order: any,
	expectedRemaining: BN,
	label: string
): boolean {
	if (!order) {
		console.log(`\n  ${label}: Order not found`);
		return false;
	}

	const remaining = order.baseAssetAmount.sub(order.baseAssetAmountFilled);
	const filled = order.baseAssetAmountFilled;

	console.log(`\n  ${label} order:`);
	console.log(`    Total size: ${order.baseAssetAmount.toString()} (${order.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber()} SOL)`);
	console.log(`    Filled:     ${filled.toString()} (${filled.toNumber() / BASE_PRECISION.toNumber()} SOL)`);
	console.log(`    Remaining:  ${remaining.toString()} (${remaining.toNumber() / BASE_PRECISION.toNumber()} SOL)`);

	const ok = remaining.eq(expectedRemaining);
	console.log(`    Expected remaining: ${expectedRemaining.toString()} ${ok ? '-- PASS' : '-- FAIL'}`);
	return ok;
}

/**
 * Print a test result summary line.
 */
export function printTestResult(testName: string, passed: boolean): void {
	console.log(`\n=== ${testName}: ${passed ? 'PASS' : 'FAIL'} ===\n`);
	if (!passed) {
		process.exitCode = 1;
	}
}
