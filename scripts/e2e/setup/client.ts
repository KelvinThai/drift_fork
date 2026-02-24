import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	AdminClient,
	DriftClient,
	BulkAccountLoader,
	initialize,
} from '../../../sdk/src';
import {
	getUserAccountPublicKeySync,
} from '../../../sdk/src/addresses/pda';
import fs from 'fs';
import { ENV, RPC_ENDPOINT, ADMIN_KEYPAIR_PATH, USDC_SPOT_MARKET_INDEX } from './config';
import { sleep } from './helpers';

/** Shared context returned by createAdminClient */
export interface AdminContext {
	client: AdminClient;
	keypair: Keypair;
	programId: PublicKey;
	connection: Connection;
	usdcMint: PublicKey;
	accountLoader: BulkAccountLoader;
	adminSubAccountId: number;
}

/**
 * Load admin keypair, create AdminClient, subscribe, and return a context
 * object that other modules can use.
 */
export async function createAdminClient(): Promise<AdminContext> {
	console.log('--- Setting up admin DriftClient ---');
	const adminKeypairData = JSON.parse(
		fs.readFileSync(ADMIN_KEYPAIR_PATH, 'utf-8')
	);
	const adminKeypair = Keypair.fromSecretKey(
		Uint8Array.from(adminKeypairData)
	);
	console.log(`  Admin: ${adminKeypair.publicKey.toBase58()}`);

	const connection = new Connection(RPC_ENDPOINT, 'confirmed');
	const adminWallet = new anchor.Wallet(adminKeypair);
	const sdkConfig = initialize({ env: ENV });
	const programId = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);
	console.log(`  Program: ${programId.toBase58()}`);

	const accountLoader = new BulkAccountLoader(connection, 'confirmed', 1000);

	// Temp client to find/create admin user account
	const tempClient = new DriftClient({
		connection,
		wallet: adminWallet,
		programID: programId,
		opts: { commitment: 'confirmed', preflightCommitment: 'confirmed' },
		activeSubAccountId: 0,
		accountSubscription: { type: 'polling', accountLoader },
		skipLoadUsers: true,
	});
	await tempClient.subscribe();

	// Read USDC mint from on-chain spot market 0
	const spotMarket = tempClient.getSpotMarketAccount(USDC_SPOT_MARKET_INDEX);
	if (!spotMarket) {
		throw new Error('Spot market 0 not found — is the protocol initialized?');
	}
	const usdcMint = spotMarket.mint;
	console.log(`  USDC mint: ${usdcMint.toBase58()}`);

	// Find existing admin sub-account or create one
	let adminSubAccountId = 0;
	let needsInit = true;
	for (const tryId of [0, 1, 2]) {
		const userPda = getUserAccountPublicKeySync(programId, adminKeypair.publicKey, tryId);
		const acctInfo = await connection.getAccountInfo(userPda);
		if (acctInfo) {
			console.log(`  Admin user account found at sub-account ${tryId}.`);
			adminSubAccountId = tryId;
			needsInit = false;
			break;
		}
	}
	if (needsInit) {
		console.log('  Admin user account not found, initializing...');
		for (const tryId of [0, 1, 2, 3]) {
			try {
				const [txSig] = await tempClient.initializeUserAccount(tryId);
				console.log(`  Initialized admin user (sub-account ${tryId}). Tx: ${txSig}`);
				adminSubAccountId = tryId;
				break;
			} catch (e: any) {
				if (
					e.message?.includes('InvalidUserSubAccountId') ||
					e.logs?.some((l: string) => l.includes('InvalidUserSubAccountId'))
				) {
					console.log(`  Sub-account ${tryId} unavailable, trying next...`);
					continue;
				}
				throw e;
			}
		}
	}
	await tempClient.unsubscribe();

	// Create the real AdminClient
	console.log(`  Using admin sub-account: ${adminSubAccountId}`);
	const adminClient = new AdminClient({
		connection,
		wallet: adminWallet,
		programID: programId,
		opts: {
			commitment: 'confirmed',
			preflightCommitment: 'confirmed',
		},
		activeSubAccountId: adminSubAccountId,
		subAccountIds: [adminSubAccountId],
		accountSubscription: {
			type: 'polling',
			accountLoader,
		},
	});
	await adminClient.subscribe();
	await adminClient.fetchAccounts();
	await sleep(2000);
	await adminClient.fetchAccounts();
	console.log('  Admin DriftClient subscribed.');

	return {
		client: adminClient,
		keypair: adminKeypair,
		programId,
		connection,
		usdcMint,
		accountLoader,
		adminSubAccountId,
	};
}

/**
 * Create a generic DriftClient for a given wallet.
 */
export function createDriftClient(
	wallet: anchor.Wallet,
	programId: PublicKey,
	connection: Connection,
	accountLoader: BulkAccountLoader,
	subAccountId = 0,
	skipLoadUsers = false
): DriftClient {
	return new DriftClient({
		connection,
		wallet,
		programID: programId,
		opts: {
			commitment: 'confirmed',
			preflightCommitment: 'confirmed',
		},
		activeSubAccountId: subAccountId,
		accountSubscription: {
			type: 'polling',
			accountLoader,
		},
		skipLoadUsers,
	});
}

/**
 * Unsubscribe all provided clients.
 */
export async function cleanupClients(...clients: (DriftClient | AdminClient)[]): Promise<void> {
	for (const c of clients) {
		try {
			await c.unsubscribe();
		} catch {
			// ignore
		}
	}
}
