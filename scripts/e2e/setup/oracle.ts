import { BN } from '@coral-xyz/anchor';
import {
	AdminClient,
	PRICE_PRECISION,
	ContractTier,
	OracleGuardRails,
} from '../../../sdk/src';

/**
 * Update a prelaunch oracle to a given price.
 */
export async function refreshOracle(
	adminClient: AdminClient,
	marketIndex: number,
	priceUsd: number
): Promise<void> {
	const price = new BN(priceUsd).mul(PRICE_PRECISION);
	console.log(`\n--- Refreshing oracle for market ${marketIndex} to $${priceUsd} ---`);
	try {
		const txSig = await adminClient.updatePrelaunchOracleParams(
			marketIndex,
			price
		);
		console.log(`  Updated prelaunch oracle. Tx: ${txSig}`);
		await adminClient.fetchAccounts();
	} catch (e: any) {
		console.log(`  Oracle update failed: ${e.message?.slice(0, 200)}`);
		console.log('  Make sure you ran fix-oracles.ts first!');
	}
}

/**
 * Fix AMM state: move to price, reset TWAP, set contract tier, update guard rails.
 */
export async function fixAmmState(
	adminClient: AdminClient,
	marketIndex: number,
	priceUsd: number
): Promise<void> {
	const price = new BN(priceUsd).mul(PRICE_PRECISION);

	console.log(`\n--- Fixing AMM state for market ${marketIndex} ---`);
	try {
		// 1. Move AMM reserves to target price
		console.log(`  Moving AMM to $${priceUsd}...`);
		const moveTx = await adminClient.moveAmmToPrice(marketIndex, price);
		console.log(`  AMM moved. Tx: ${moveTx}`);

		// 2. Reset oracle TWAP to mark TWAP
		console.log('  Resetting AMM oracle TWAP...');
		const resetTx = await adminClient.resetPerpMarketAmmOracleTwap(marketIndex);
		console.log(`  Oracle TWAP reset. Tx: ${resetTx}`);

		// 3. Set contract tier to Speculative
		console.log('  Setting contract tier to Speculative...');
		const tierTx = await adminClient.updatePerpMarketContractTier(
			marketIndex,
			ContractTier.SPECULATIVE
		);
		console.log(`  Contract tier updated. Tx: ${tierTx}`);

		// 4. Increase oracle guard rails confidence interval (50% max)
		console.log('  Updating oracle guard rails (50% confidence max)...');
		const state = adminClient.getStateAccount();
		const newGuardRails: OracleGuardRails = {
			priceDivergence: state.oracleGuardRails.priceDivergence,
			validity: {
				...state.oracleGuardRails.validity,
				confidenceIntervalMaxSize: new BN(500_000), // 50%
			},
		};
		const grTx = await adminClient.updateOracleGuardRails(newGuardRails);
		console.log(`  Oracle guard rails updated. Tx: ${grTx}`);

		await adminClient.fetchAccounts();
		console.log('  AMM state fixes applied.');
	} catch (e: any) {
		console.log(`  AMM fix failed: ${e.message?.slice(0, 300)}`);
		if (e.logs) {
			const relevant = e.logs.filter(
				(l: string) =>
					l.includes('Error') ||
					l.includes('error') ||
					l.includes('failed') ||
					l.includes('Custom')
			);
			relevant.forEach((l: string) => console.log(`    ${l}`));
		}
	}
}

/**
 * Combined: refresh oracle + fix AMM state in one call.
 */
export async function setupMarket(
	adminClient: AdminClient,
	marketIndex: number,
	priceUsd: number
): Promise<void> {
	await refreshOracle(adminClient, marketIndex, priceUsd);
	await fixAmmState(adminClient, marketIndex, priceUsd);
}
