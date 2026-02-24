import * as anchor from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';
import { mintTo, getAccount } from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import { DriftClient } from '../../../sdk/src';
import { AdminContext } from './client';
import { createDriftClient } from './client';
import { DEFAULT_COLLATERAL, USDC_SPOT_MARKET_INDEX, QUOTE_PRECISION } from './config';
import { ensureAta, fundSol } from './helpers';

/** Context returned for each taker */
export interface TakerContext {
	client: DriftClient;
	keypair: Keypair;
	wallet: anchor.Wallet;
}

/**
 * Create a taker: generate keypair, fund SOL, mint USDC, init user account,
 * deposit collateral, and return a subscribed DriftClient.
 */
export async function createTaker(
	ctx: AdminContext,
	collateral: BN = DEFAULT_COLLATERAL,
	name = 'taker'
): Promise<TakerContext> {
	const takerKeypair = Keypair.generate();
	console.log(`\n--- Setting up ${name} ---`);
	console.log(`  ${name}: ${takerKeypair.publicKey.toBase58()}`);

	// Fund SOL for tx fees
	console.log(`  Funding ${name} with 0.5 SOL for tx fees...`);
	await fundSol(
		ctx.connection,
		takerKeypair.publicKey,
		500_000_000,
		ctx.keypair
	);

	// Create ATA and mint USDC
	const takerAta = await ensureAta(
		ctx.connection,
		ctx.keypair,
		ctx.usdcMint,
		takerKeypair.publicKey
	);
	console.log(`  ${name} ATA: ${takerAta.toBase58()}`);

	console.log(`  Minting ${collateral.div(QUOTE_PRECISION).toString()} USDC to ${name}...`);
	await mintTo(
		ctx.connection,
		ctx.keypair,
		ctx.usdcMint,
		takerAta,
		ctx.keypair,
		BigInt(collateral.toString())
	);
	console.log('  Minted.');

	const takerWallet = new anchor.Wallet(takerKeypair);

	// Initialize user account + deposit (using temp client with skipLoadUsers)
	const tempClient = createDriftClient(
		takerWallet,
		ctx.programId,
		ctx.connection,
		ctx.accountLoader,
		0,
		true
	);
	await tempClient.subscribe();

	const [initTxSig] =
		await tempClient.initializeUserAccountAndDepositCollateral(
			collateral,
			takerAta,
			USDC_SPOT_MARKET_INDEX,
			0,
			name
		);
	console.log(`  ${name} initialized + deposited. Tx: ${initTxSig}`);
	await tempClient.unsubscribe();

	// Create the real client that loads the user
	const takerClient = createDriftClient(
		takerWallet,
		ctx.programId,
		ctx.connection,
		ctx.accountLoader
	);
	await takerClient.subscribe();
	console.log(`  ${name} DriftClient subscribed.`);

	return {
		client: takerClient,
		keypair: takerKeypair,
		wallet: takerWallet,
	};
}

/**
 * Ensure admin has USDC collateral deposited.
 */
export async function ensureAdminCollateral(
	ctx: AdminContext,
	amount: BN = DEFAULT_COLLATERAL
): Promise<void> {
	console.log('\n--- Admin USDC collateral ---');
	const adminAta = await ensureAta(
		ctx.connection,
		ctx.keypair,
		ctx.usdcMint,
		ctx.keypair.publicKey
	);
	console.log(`  Admin ATA: ${adminAta.toBase58()}`);

	// Check existing balance
	let adminAtaInfo;
	try {
		adminAtaInfo = await getAccount(ctx.connection, adminAta);
	} catch {
		adminAtaInfo = null;
	}
	const adminAtaBalance = adminAtaInfo
		? new BN(adminAtaInfo.amount.toString())
		: new BN(0);
	console.log(
		`  Admin ATA balance: ${adminAtaBalance.div(QUOTE_PRECISION).toString()} USDC`
	);

	// Mint USDC if balance is low
	if (adminAtaBalance.lt(amount)) {
		const mintAmount = amount.sub(adminAtaBalance);
		console.log(
			`  Minting ${mintAmount.div(QUOTE_PRECISION).toString()} USDC to admin...`
		);
		try {
			await mintTo(
				ctx.connection,
				ctx.keypair,
				ctx.usdcMint,
				adminAta,
				ctx.keypair,
				BigInt(mintAmount.toString())
			);
			console.log('  Minted successfully.');
		} catch (e: any) {
			console.error(
				`  Failed to mint USDC (admin may not have mint authority): ${e.message}`
			);
			throw e;
		}
	}

	// Deposit into Drift if needed
	const adminUser = ctx.client.getUser();
	const adminSpotPosition = adminUser.getSpotPosition(USDC_SPOT_MARKET_INDEX);
	const adminCollateral = adminSpotPosition
		? adminSpotPosition.scaledBalance
		: new BN(0);
	console.log(`  Admin Drift USDC (scaled): ${adminCollateral.toString()}`);

	if (adminCollateral.isZero()) {
		console.log('  Depositing USDC into Drift for admin...');
		const depositTx = await ctx.client.deposit(
			amount,
			USDC_SPOT_MARKET_INDEX,
			adminAta
		);
		console.log(`  Deposited. Tx: ${depositTx}`);
	}
}
