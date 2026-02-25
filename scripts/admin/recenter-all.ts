import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	AdminClient,
	BulkAccountLoader,
	initialize,
	BN,
} from '../../sdk/src';
import fs from 'fs';

const ENV = 'devnet' as const;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com';
const ADMIN_KEYPAIR_PATH = process.env.ADMIN_KEYPAIR_PATH || './keys/admin-keypair.json';

const MARKETS = [
	{ index: 0, name: 'SOL-PERP' },
	{ index: 1, name: 'BTC-PERP' },
	{ index: 2, name: 'ETH-PERP' },
];

async function main() {
	console.log('\n=== Recenter All Markets to Oracle Prices ===\n');

	const adminKeypairData = JSON.parse(fs.readFileSync(ADMIN_KEYPAIR_PATH, 'utf-8'));
	const adminKeypair = Keypair.fromSecretKey(Uint8Array.from(adminKeypairData));
	const connection = new Connection(RPC_ENDPOINT, 'confirmed');
	const wallet = new anchor.Wallet(adminKeypair);
	const sdkConfig = initialize({ env: ENV });
	const programId = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);

	const adminClient = new AdminClient({
		connection,
		wallet,
		programID: programId,
		opts: { commitment: 'confirmed', preflightCommitment: 'confirmed' },
		activeSubAccountId: 0,
		accountSubscription: {
			type: 'polling',
			accountLoader: new BulkAccountLoader(connection, 'confirmed', 1000),
		},
		skipLoadUsers: true,
	});

	await adminClient.subscribe();

	for (const m of MARKETS) {
		const perp = adminClient.getPerpMarketAccount(m.index);
		if (!perp) {
			console.log(`${m.name}: NOT FOUND, skipping`);
			continue;
		}

		// Get oracle price
		const oracleData = adminClient.getOracleDataForPerpMarket(m.index);
		const oraclePriceNum = Number(oracleData.price) / 1e6;

		// Get current reserve price
		const reservePrice = Number(perp.amm.quoteAssetReserve.mul(perp.amm.pegMultiplier).div(perp.amm.baseAssetReserve)) / 1e9;
		const currentPeg = Number(perp.amm.pegMultiplier) / 1e3;
		const currentSqrtK = perp.amm.sqrtK;

		console.log(`${m.name}:`);
		console.log(`  Oracle: $${oraclePriceNum.toFixed(2)}`);
		console.log(`  Reserve: $${reservePrice.toFixed(2)}`);
		console.log(`  Peg: $${currentPeg.toFixed(2)}`);

		// Check if already close enough (within 1%)
		const pctDiff = Math.abs(reservePrice - oraclePriceNum) / oraclePriceNum * 100;
		if (pctDiff < 1) {
			console.log(`  Already within 1% of oracle (${pctDiff.toFixed(2)}%), skipping\n`);
			continue;
		}

		// Recenter: set peg to oracle price, keep same sqrtK
		const newPeg = new BN(Math.round(oraclePriceNum * 1000)); // peg is price * 1e3
		console.log(`  Recentering: peg ${currentPeg.toFixed(2)} -> ${oraclePriceNum.toFixed(2)}`);

		try {
			const txSig = await adminClient.recenterPerpMarketAmm(m.index, newPeg, currentSqrtK);
			console.log(`  tx: ${txSig}`);
		} catch (err: any) {
			console.error(`  FAILED: ${err.message}`);
			if (err.logs) {
				err.logs.filter((l: string) => l.includes('Error') || l.includes('error')).forEach((l: string) => console.error(`    ${l}`));
			}
			continue;
		}

		// Also moveAmmToPrice for precise alignment
		try {
			const targetPrice = oracleData.price;
			const txSig2 = await adminClient.moveAmmToPrice(m.index, targetPrice);
			console.log(`  moveAmmToPrice tx: ${txSig2}`);
		} catch (err: any) {
			console.error(`  moveAmmToPrice FAILED: ${err.message}`);
		}

		await adminClient.fetchAccounts();
		const updated = adminClient.getPerpMarketAccount(m.index);
		if (updated) {
			const newReserve = Number(updated.amm.quoteAssetReserve.mul(updated.amm.pegMultiplier).div(updated.amm.baseAssetReserve)) / 1e9;
			console.log(`  After: reserve=$${newReserve.toFixed(2)}, peg=$${(Number(updated.amm.pegMultiplier) / 1e3).toFixed(2)}\n`);
		}
	}

	await adminClient.unsubscribe();
	console.log('Done.');
}

main().catch((err) => {
	console.error('\nFailed:', err);
	process.exit(1);
});
