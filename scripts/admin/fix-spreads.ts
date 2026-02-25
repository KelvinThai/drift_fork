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

// maxSpread is in basis points * 100 (i.e., 1000 = 0.1% = 10 bps)
// Drift mainnet SOL-PERP uses ~2000 (20 bps). Let's use 2000 for all.
const TARGET_MAX_SPREAD = 2000; // 20 bps = 0.2%

async function main() {
	console.log('\n=== Fix AMM Spreads ===\n');

	const adminKeypairData = JSON.parse(fs.readFileSync(ADMIN_KEYPAIR_PATH, 'utf-8'));
	const adminKeypair = Keypair.fromSecretKey(Uint8Array.from(adminKeypairData));
	console.log(`Admin: ${adminKeypair.publicKey.toBase58()}`);

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

	// Step 1: Read current state
	console.log('--- Current Market State ---\n');
	for (const m of MARKETS) {
		const perp = adminClient.getPerpMarketAccount(m.index);
		if (!perp) {
			console.log(`  ${m.name}: NOT FOUND`);
			continue;
		}
		console.log(`  ${m.name}:`);
		console.log(`    baseSpread: ${perp.amm.baseSpread}`);
		console.log(`    maxSpread: ${perp.amm.maxSpread}`);
		console.log(`    longSpread: ${perp.amm.longSpread}`);
		console.log(`    shortSpread: ${perp.amm.shortSpread}`);
		console.log(`    lastMarkPriceTwap: ${Number(perp.amm.lastMarkPriceTwap) / 1e6}`);
		console.log(`    lastMarkPriceTwap5min: ${Number(perp.amm.lastMarkPriceTwap5min) / 1e6}`);
		console.log(`    lastBidPriceTwap: ${Number(perp.amm.lastBidPriceTwap) / 1e6}`);
		console.log(`    lastAskPriceTwap: ${Number(perp.amm.lastAskPriceTwap) / 1e6}`);
		console.log(`    curveUpdateIntensity: ${perp.amm.curveUpdateIntensity}`);
		console.log(`    ammSpreadAdjustment: ${perp.amm.ammSpreadAdjustment}`);
		console.log();
	}

	// Step 2: Update max spread for SOL-PERP (the problematic one)
	console.log('--- Updating Max Spreads ---\n');
	for (const m of MARKETS) {
		const perp = adminClient.getPerpMarketAccount(m.index);
		if (!perp) continue;

		if (perp.amm.maxSpread === TARGET_MAX_SPREAD) {
			console.log(`  ${m.name}: maxSpread already ${TARGET_MAX_SPREAD}, skipping`);
			continue;
		}

		try {
			console.log(`  ${m.name}: updating maxSpread ${perp.amm.maxSpread} -> ${TARGET_MAX_SPREAD}`);
			const txSig = await adminClient.updatePerpMarketMaxSpread(m.index, TARGET_MAX_SPREAD);
			console.log(`    tx: ${txSig}`);
		} catch (err: any) {
			console.error(`    FAILED: ${err.message}`);
			if (err.logs) {
				err.logs.filter((l: string) => l.includes('Error') || l.includes('error')).forEach((l: string) => console.error(`      ${l}`));
			}
		}
	}

	// Step 3: Verify
	await adminClient.fetchAccounts();
	console.log('\n--- After Update ---\n');
	for (const m of MARKETS) {
		const perp = adminClient.getPerpMarketAccount(m.index);
		if (!perp) continue;
		console.log(`  ${m.name}: maxSpread=${perp.amm.maxSpread}, longSpread=${perp.amm.longSpread}, shortSpread=${perp.amm.shortSpread}`);
	}

	await adminClient.unsubscribe();
	console.log('\nDone.');
}

main().catch((err) => {
	console.error('\nFailed:', err);
	process.exit(1);
});
