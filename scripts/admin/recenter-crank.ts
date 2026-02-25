import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	AdminClient,
	BulkAccountLoader,
	initialize,
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
	console.log('\n=== Recenter All Markets (Crank) ===\n');

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

		const oracleData = adminClient.getOracleDataForPerpMarket(m.index);
		const oraclePriceNum = Number(oracleData.price) / 1e6;
		const currentPeg = Number(perp.amm.pegMultiplier);
		const currentSqrtK = perp.amm.sqrtK;

		console.log(`${m.name}:`);
		console.log(`  Oracle: $${oraclePriceNum.toFixed(2)} (raw: ${oracleData.price.toString()})`);
		console.log(`  Current peg (raw): ${currentPeg}`);
		console.log(`  Current sqrtK: ${currentSqrtK.toString()}`);

		try {
			// recenterPerpMarketAmmCrank reads oracle price directly
			// and sets peg = oracle_price (in PRICE_PRECISION)
			const txSig = await adminClient.recenterPerpMarketAmmCrank(m.index);
			console.log(`  Recentered! tx: ${txSig}`);
		} catch (err: any) {
			console.error(`  FAILED: ${err.message}`);
			if (err.logs) {
				err.logs.filter((l: string) => l.includes('Error') || l.includes('error') || l.includes('peg')).forEach((l: string) => console.error(`    ${l}`));
			}
			continue;
		}

		await adminClient.fetchAccounts();
		const updated = adminClient.getPerpMarketAccount(m.index);
		if (updated) {
			const newPeg = Number(updated.amm.pegMultiplier);
			console.log(`  New peg (raw): ${newPeg}`);
			console.log(`  New peg (USD): $${(newPeg / 1e6).toFixed(2)}`);
		}
		console.log();
	}

	await adminClient.unsubscribe();
	console.log('Done.');
}

main().catch((err) => {
	console.error('\nFailed:', err);
	process.exit(1);
});
