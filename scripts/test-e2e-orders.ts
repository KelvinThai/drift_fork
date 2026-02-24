import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	Transaction,
	sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddress,
	createAssociatedTokenAccountIdempotentInstruction,
	mintTo,
	getAccount,
} from '@solana/spl-token';
import {
	AdminClient,
	DriftClient,
	BulkAccountLoader,
	initialize,
	BASE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	PositionDirection,
	PostOnlyParams,
	getLimitOrderParams,
	ContractTier,
	OracleGuardRails,
} from '../sdk/src';
import {
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
} from '../sdk/src/addresses/pda';
import fs from 'fs';
import http from 'http';

// ============================================================================
// CONFIGURATION
// ============================================================================

const ENV = (process.env.DRIFT_ENV || 'devnet') as 'devnet' | 'mainnet-beta';
const RPC_ENDPOINT =
	process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com';
const ADMIN_KEYPAIR_PATH =
	process.env.ADMIN_KEYPAIR_PATH || './keys/admin-keypair.json';
const DLOB_SERVER = process.env.DLOB_SERVER || 'http://localhost:6969';

const SOL_PERP_MARKET_INDEX = 0;
const USDC_SPOT_MARKET_INDEX = 0;
const ORDER_SIZE = BASE_PRECISION.divn(10); // 0.1 SOL
const COLLATERAL_AMOUNT = new BN(1000).mul(QUOTE_PRECISION); // 1000 USDC

// ============================================================================
// HELPERS
// ============================================================================

function httpGet(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => {
			let data = '';
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () => resolve(data));
			res.on('error', reject);
		}).on('error', reject);
	});
}

async function queryDlobL3(marketIndex: number): Promise<any> {
	const url = `${DLOB_SERVER}/l3?marketIndex=${marketIndex}&marketType=perp`;
	try {
		const raw = await httpGet(url);
		return JSON.parse(raw);
	} catch (e: any) {
		console.log(`  DLOB query failed: ${e.message}`);
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureAta(
	connection: Connection,
	payer: Keypair,
	mint: PublicKey,
	owner: PublicKey
): Promise<PublicKey> {
	const ata = await getAssociatedTokenAddress(mint, owner);
	const ix = createAssociatedTokenAccountIdempotentInstruction(
		payer.publicKey,
		ata,
		owner,
		mint
	);
	const tx = new Transaction().add(ix);
	await sendAndConfirmTransaction(connection, tx, [payer], {
		commitment: 'confirmed',
	});
	return ata;
}

async function fundSol(
	connection: Connection,
	recipient: PublicKey,
	lamports: number,
	fallbackPayer?: Keypair
): Promise<void> {
	// Try devnet faucet first
	try {
		const sig = await connection.requestAirdrop(recipient, lamports);
		await connection.confirmTransaction(sig, 'confirmed');
		console.log('  Airdrop succeeded.');
		return;
	} catch (e: any) {
		console.log(`  Airdrop failed: ${e.message}`);
	}

	// Fall back to transfer from payer (e.g. admin wallet)
	if (!fallbackPayer) {
		throw new Error('Airdrop failed and no fallback payer provided');
	}
	console.log(
		`  Transferring ${lamports / LAMPORTS_PER_SOL} SOL from ${fallbackPayer.publicKey.toBase58().slice(0, 8)}...`
	);
	const tx = new Transaction().add(
		SystemProgram.transfer({
			fromPubkey: fallbackPayer.publicKey,
			toPubkey: recipient,
			lamports,
		})
	);
	await sendAndConfirmTransaction(connection, tx, [fallbackPayer], {
		commitment: 'confirmed',
	});
	console.log('  Transfer confirmed.');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	console.log('\n=== E2E Test: Place Orders → DLOB Verify → Keeper Fill ===');
	console.log(`RPC: ${RPC_ENDPOINT}`);
	console.log(`DLOB: ${DLOB_SERVER}\n`);

	// ------------------------------------------------------------------
	// 1. Load admin keypair, set up connection
	// ------------------------------------------------------------------
	console.log('--- Step 1: Setting up admin DriftClient ---');
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

	// First create a temporary client to read state and initialize user if needed
	let adminSubAccountId = 0;
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

	// ------------------------------------------------------------------
	// 2. Get USDC mint from on-chain spot market 0
	// ------------------------------------------------------------------
	console.log('\n--- Step 2: Reading on-chain USDC mint ---');
	const spotMarket = tempClient.getSpotMarketAccount(USDC_SPOT_MARKET_INDEX);
	if (!spotMarket) {
		throw new Error('Spot market 0 not found — is the protocol initialized?');
	}
	const usdcMint = spotMarket.mint;
	console.log(`  USDC mint: ${usdcMint.toBase58()}`);

	// ------------------------------------------------------------------
	// 3. Check if admin user account exists; initialize if needed
	// ------------------------------------------------------------------
	console.log('\n--- Step 3: Ensuring admin user account ---');
	// Try to initialize user — the program tells us the correct sub-account ID
	let needsInit = true;
	for (const tryId of [0, 1, 2]) {
		const { getUserAccountPublicKeySync } = await import('../sdk/src/addresses/pda');
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
		// Try sub-account IDs 0, 1, 2 until one works
		for (const tryId of [0, 1, 2, 3]) {
			try {
				const [txSig] = await tempClient.initializeUserAccount(tryId);
				console.log(`  Initialized admin user (sub-account ${tryId}). Tx: ${txSig}`);
				adminSubAccountId = tryId;
				break;
			} catch (e: any) {
				if (e.message?.includes('InvalidUserSubAccountId') || e.logs?.some((l: string) => l.includes('InvalidUserSubAccountId'))) {
					console.log(`  Sub-account ${tryId} unavailable, trying next...`);
					continue;
				}
				throw e;
			}
		}
	}
	await tempClient.unsubscribe();

	// Now create the real admin client (AdminClient for oracle updates)
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
	// Force-load accounts to ensure user is available
	await adminClient.fetchAccounts();
	await sleep(2000);
	await adminClient.fetchAccounts();
	console.log('  Admin DriftClient subscribed.');
	const adminUserAccount = adminClient.getUserAccount();

	// Cancel any stale orders from previous runs
	const existingOrders = adminUserAccount?.orders?.filter(
		(o: any) => !o.baseAssetAmount.isZero()
	);
	if (existingOrders && existingOrders.length > 0) {
		console.log(`  Cancelling ${existingOrders.length} existing admin order(s)...`);
		await adminClient.cancelOrders();
		console.log('  Cancelled.');
	}

	// Note: admin may have a position from previous runs — that's OK
	const existingPos = adminClient.getUser().getPerpPosition(SOL_PERP_MARKET_INDEX);
	if (existingPos && !existingPos.baseAssetAmount.isZero()) {
		const side = existingPos.baseAssetAmount.isNeg() ? 'SHORT' : 'LONG';
		console.log(`  Admin has existing ${side} position: ${existingPos.baseAssetAmount.toString()} (will accumulate)`);
	}

	// ------------------------------------------------------------------
	// 4. Mint USDC and deposit for admin
	// ------------------------------------------------------------------
	console.log('\n--- Step 4: Admin USDC collateral ---');
	const adminAta = await ensureAta(
		connection,
		adminKeypair,
		usdcMint,
		adminKeypair.publicKey
	);
	console.log(`  Admin ATA: ${adminAta.toBase58()}`);

	// Check existing balance
	let adminAtaInfo;
	try {
		adminAtaInfo = await getAccount(connection, adminAta);
	} catch {
		adminAtaInfo = null;
	}
	const adminAtaBalance = adminAtaInfo
		? new BN(adminAtaInfo.amount.toString())
		: new BN(0);
	console.log(
		`  Admin ATA balance: ${adminAtaBalance.div(QUOTE_PRECISION).toString()} USDC`
	);

	// Mint USDC if balance is low (admin must have mint authority)
	if (adminAtaBalance.lt(COLLATERAL_AMOUNT)) {
		const mintAmount = COLLATERAL_AMOUNT.sub(adminAtaBalance);
		console.log(
			`  Minting ${mintAmount.div(QUOTE_PRECISION).toString()} USDC to admin...`
		);
		try {
			await mintTo(
				connection,
				adminKeypair, // payer
				usdcMint,
				adminAta,
				adminKeypair, // mint authority
				BigInt(mintAmount.toString())
			);
			console.log('  Minted successfully.');
		} catch (e: any) {
			console.error(
				`  Failed to mint USDC (admin may not have mint authority): ${e.message}`
			);
			console.error(
				'  Please fund the admin ATA manually and re-run the script.'
			);
			await adminClient.unsubscribe();
			process.exit(1);
		}
	}

	// Check admin's Drift collateral (spot position)
	const adminUser = adminClient.getUser();
	const adminSpotPosition = adminUser.getSpotPosition(USDC_SPOT_MARKET_INDEX);
	const adminCollateral = adminSpotPosition
		? adminSpotPosition.scaledBalance
		: new BN(0);
	console.log(`  Admin Drift USDC (scaled): ${adminCollateral.toString()}`);

	if (adminCollateral.isZero()) {
		console.log('  Depositing USDC into Drift for admin...');
		const depositTx = await adminClient.deposit(
			COLLATERAL_AMOUNT,
			USDC_SPOT_MARKET_INDEX,
			adminAta
		);
		console.log(`  Deposited. Tx: ${depositTx}`);
	}

	// ------------------------------------------------------------------
	// 5. Generate taker keypair, airdrop SOL for fees
	// ------------------------------------------------------------------
	console.log('\n--- Step 5: Setting up taker ---');
	const takerKeypair = Keypair.generate();
	console.log(`  Taker: ${takerKeypair.publicKey.toBase58()}`);

	console.log('  Funding taker with 0.5 SOL for tx fees...');
	await fundSol(
		connection,
		takerKeypair.publicKey,
		500_000_000,
		adminKeypair // fallback: transfer from admin if airdrop fails
	);

	// ------------------------------------------------------------------
	// 6. Mint USDC to taker and set up taker DriftClient
	// ------------------------------------------------------------------
	console.log('\n--- Step 6: Taker USDC + DriftClient ---');
	const takerAta = await ensureAta(
		connection,
		adminKeypair, // admin pays for ATA creation
		usdcMint,
		takerKeypair.publicKey
	);
	console.log(`  Taker ATA: ${takerAta.toBase58()}`);

	console.log(
		`  Minting ${COLLATERAL_AMOUNT.div(QUOTE_PRECISION).toString()} USDC to taker...`
	);
	await mintTo(
		connection,
		adminKeypair,
		usdcMint,
		takerAta,
		adminKeypair,
		BigInt(COLLATERAL_AMOUNT.toString())
	);
	console.log('  Minted.');

	const takerWallet = new anchor.Wallet(takerKeypair);

	// ------------------------------------------------------------------
	// 7. Initialize taker user account + deposit collateral
	// ------------------------------------------------------------------
	console.log('\n--- Step 7: Initialize taker user + deposit ---');

	// Create a temp client with skipLoadUsers to initialize the user account
	const takerTempClient = new DriftClient({
		connection,
		wallet: takerWallet,
		programID: programId,
		opts: {
			commitment: 'confirmed',
			preflightCommitment: 'confirmed',
		},
		activeSubAccountId: 0,
		accountSubscription: {
			type: 'polling',
			accountLoader,
		},
		skipLoadUsers: true,
	});
	await takerTempClient.subscribe();

	const [initTxSig] =
		await takerTempClient.initializeUserAccountAndDepositCollateral(
			COLLATERAL_AMOUNT,
			takerAta,
			USDC_SPOT_MARKET_INDEX,
			0, // subAccountId
			'taker'
		);
	console.log(`  Taker initialized + deposited. Tx: ${initTxSig}`);
	await takerTempClient.unsubscribe();

	// Now create the real taker client that loads the user
	const takerClient = new DriftClient({
		connection,
		wallet: takerWallet,
		programID: programId,
		opts: {
			commitment: 'confirmed',
			preflightCommitment: 'confirmed',
		},
		activeSubAccountId: 0,
		accountSubscription: {
			type: 'polling',
			accountLoader,
		},
	});
	await takerClient.subscribe();
	console.log('  Taker DriftClient subscribed.');

	// ------------------------------------------------------------------
	// 7b. Refresh prelaunch oracle price
	// ------------------------------------------------------------------
	console.log('\n--- Step 7b: Refreshing prelaunch oracle ---');
	try {
		// Set SOL-PERP oracle price to $150 (update keeps it fresh)
		const solPrice = new BN(150).mul(PRICE_PRECISION);
		const txSig = await adminClient.updatePrelaunchOracleParams(
			SOL_PERP_MARKET_INDEX,
			solPrice
		);
		console.log(`  Updated SOL-PERP prelaunch oracle to $150. Tx: ${txSig}`);
		await adminClient.fetchAccounts();
	} catch (e: any) {
		console.log(`  Oracle update failed: ${e.message?.slice(0, 200)}`);
		console.log('  Make sure you ran fix-oracles.ts first!');
	}

	// ------------------------------------------------------------------
	// 7c. Fix AMM state to reduce oracle confidence
	// ------------------------------------------------------------------
	console.log('\n--- Step 7c: Fixing AMM state (move to price + reset TWAPs) ---');
	try {
		const solPrice = new BN(150).mul(PRICE_PRECISION);

		// 1. Move AMM reserves to target price
		console.log('  Moving AMM to $150...');
		const moveTx = await adminClient.moveAmmToPrice(SOL_PERP_MARKET_INDEX, solPrice);
		console.log(`  AMM moved. Tx: ${moveTx}`);

		// 2. Reset oracle TWAP to mark TWAP
		console.log('  Resetting AMM oracle TWAP...');
		const resetTx = await adminClient.resetPerpMarketAmmOracleTwap(SOL_PERP_MARKET_INDEX);
		console.log(`  Oracle TWAP reset. Tx: ${resetTx}`);

		// 3. Set contract tier to Speculative (10x confidence multiplier: 20% threshold)
		console.log('  Setting contract tier to Speculative...');
		const tierTx = await adminClient.updatePerpMarketContractTier(
			SOL_PERP_MARKET_INDEX,
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
				confidenceIntervalMaxSize: new BN(500_000), // 50% (up from 2%)
			},
		};
		const grTx = await adminClient.updateOracleGuardRails(newGuardRails);
		console.log(`  Oracle guard rails updated. Tx: ${grTx}`);

		await adminClient.fetchAccounts();
		console.log('  AMM state fixes applied.');
	} catch (e: any) {
		console.log(`  AMM fix failed: ${e.message?.slice(0, 300)}`);
		if (e.logs) {
			const relevant = e.logs.filter((l: string) =>
				l.includes('Error') || l.includes('error') || l.includes('failed') || l.includes('Custom')
			);
			relevant.forEach((l: string) => console.log(`    ${l}`));
		}
	}

	// ------------------------------------------------------------------
	// 8. Get oracle price for SOL-PERP
	// ------------------------------------------------------------------
	console.log('\n--- Step 8: Oracle price ---');
	const oracleData = adminClient.getOracleDataForPerpMarket(
		SOL_PERP_MARKET_INDEX
	);
	const oraclePriceRaw = oracleData.price;

	// Round oracle price to the order tick size grid
	const perpMarket = adminClient.getPerpMarketAccount(SOL_PERP_MARKET_INDEX);
	const tickSize = perpMarket!.amm.orderTickSize; // e.g. 10

	// Price the maker SELL 2% above oracle so it rests (doesn't fill against AMM)
	const buffer = oraclePriceRaw.divn(50); // 2%
	const makerPriceRaw = oraclePriceRaw.add(buffer);
	const makerPrice = makerPriceRaw.div(tickSize).mul(tickSize); // snap to tick
	// Taker BUY at same price to guarantee crossing
	const takerPrice = makerPrice;
	console.log(
		`  SOL oracle price: $${oraclePriceRaw.div(PRICE_PRECISION).toString()} (raw: ${oraclePriceRaw.toString()})`
	);
	console.log(`  Maker ask price: ${makerPrice.toString()} (~2% above oracle)`);
	console.log(`  Taker bid price: ${takerPrice.toString()} (crosses maker)`);

	// ------------------------------------------------------------------
	// 9. Place maker LIMIT SELL order (admin)
	// ------------------------------------------------------------------
	console.log('\n--- Step 9: Placing maker LIMIT SELL (admin) ---');
	const makerOrderParams = getLimitOrderParams({
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.SHORT,
		baseAssetAmount: ORDER_SIZE,
		price: makerPrice,
		postOnly: PostOnlyParams.NONE,
		userOrderId: 1,
	});

	const makerTx = await adminClient.placePerpOrder(makerOrderParams);
	console.log(`  Maker order placed. Tx: ${makerTx}`);

	// Verify order on-chain
	await adminClient.fetchAccounts();
	const adminOrders = adminClient.getUserAccount()?.orders;
	const makerOrder = adminOrders?.find((o) => o.userOrderId === 1);
	if (makerOrder && !makerOrder.baseAssetAmount.isZero()) {
		console.log(
			`  Confirmed on-chain: orderId=${makerOrder.orderId}, ` +
				`baseAmount=${makerOrder.baseAssetAmount.toString()}, ` +
				`price=${makerOrder.price.toString()}`
		);
	}

	// ------------------------------------------------------------------
	// 10. Query DLOB — should see maker order
	// ------------------------------------------------------------------
	console.log('\n--- Step 10: DLOB check (after maker order) ---');
	await sleep(3000); // give DLOB server time to pick up
	const dlob1 = await queryDlobL3(SOL_PERP_MARKET_INDEX);
	if (dlob1) {
		const bids = dlob1.bids?.length || 0;
		const asks = dlob1.asks?.length || 0;
		console.log(`  DLOB L3: ${bids} bids, ${asks} asks`);
		if (dlob1.asks?.length > 0) {
			console.log(
				`  Top ask: price=${dlob1.asks[0].price}, size=${dlob1.asks[0].size}`
			);
		}
	}

	// ------------------------------------------------------------------
	// 11. Place taker LIMIT BUY order (crosses maker)
	// ------------------------------------------------------------------
	console.log('\n--- Step 11: Placing taker LIMIT BUY (crosses maker) ---');
	const takerOrderParams = getLimitOrderParams({
		marketIndex: SOL_PERP_MARKET_INDEX,
		direction: PositionDirection.LONG,
		baseAssetAmount: ORDER_SIZE,
		price: takerPrice,
		userOrderId: 1,
	});

	const takerTx = await takerClient.placePerpOrder(takerOrderParams);
	console.log(`  Taker order placed. Tx: ${takerTx}`);

	// Verify taker order on-chain
	await takerClient.fetchAccounts();
	const takerOrders = takerClient.getUserAccount()?.orders;
	const takerOrder = takerOrders?.find((o) => o.userOrderId === 1);
	if (takerOrder && !takerOrder.baseAssetAmount.isZero()) {
		console.log(
			`  Confirmed on-chain: orderId=${takerOrder.orderId}, ` +
				`baseAmount=${takerOrder.baseAssetAmount.toString()}, ` +
				`price=${takerOrder.price.toString()}`
		);
	}

	// ------------------------------------------------------------------
	// 12. Query DLOB — should see both orders
	// ------------------------------------------------------------------
	console.log('\n--- Step 12: DLOB check (after taker order) ---');
	await sleep(3000);
	const dlob2 = await queryDlobL3(SOL_PERP_MARKET_INDEX);
	if (dlob2) {
		const bids = dlob2.bids?.length || 0;
		const asks = dlob2.asks?.length || 0;
		console.log(`  DLOB L3: ${bids} bids, ${asks} asks`);
	}

	// ------------------------------------------------------------------
	// 13. Direct fill (admin acts as filler to match taker ↔ maker)
	// ------------------------------------------------------------------
	console.log('\n--- Step 13: Direct fill (admin as filler) ---');
	let _filled = false;

	// Refresh accounts to get the latest order data
	await adminClient.fetchAccounts();
	await takerClient.fetchAccounts();

	const takerUserAcct = takerClient.getUserAccount();
	const takerUserPubkey = getUserAccountPublicKeySync(
		programId,
		takerKeypair.publicKey,
		0
	);
	const adminUserPubkey = getUserAccountPublicKeySync(
		programId,
		adminKeypair.publicKey,
		adminSubAccountId
	);

	// Find the taker's open order
	const takerOpenOrder = takerUserAcct?.orders?.find(
		(o: any) => !o.baseAssetAmount.isZero() && o.userOrderId === 1
	);
	// Find the maker's (admin's) open order
	const adminUserAcctNow = adminClient.getUserAccount();
	const makerOpenOrder = adminUserAcctNow?.orders?.find(
		(o: any) => !o.baseAssetAmount.isZero() && o.userOrderId === 1
	);

	if (takerOpenOrder && makerOpenOrder) {
		console.log(
			`  Taker order: id=${takerOpenOrder.orderId}, price=${takerOpenOrder.price.toString()}`
		);
		console.log(
			`  Maker order: id=${makerOpenOrder.orderId}, price=${makerOpenOrder.price.toString()}`
		);

		// Build MakerInfo
		const makerInfo = {
			maker: adminUserPubkey,
			makerStats: getUserStatsAccountPublicKey(
				programId,
				adminKeypair.publicKey
			),
			makerUserAccount: adminUserAcctNow!,
			order: makerOpenOrder,
		};

		try {
			// Admin fills the taker's order against the maker's order
			const fillTx = await adminClient.fillPerpOrder(
				takerUserPubkey,
				takerUserAcct!,
				{ marketIndex: takerOpenOrder.marketIndex, orderId: takerOpenOrder.orderId },
				makerInfo
			);
			console.log(`  Fill transaction sent. Tx: ${fillTx}`);
			await sleep(2000);
			await adminClient.fetchAccounts();
			await takerClient.fetchAccounts();
			_filled = true;
		} catch (e: any) {
			console.log(`  Direct fill failed: ${e.message?.slice(0, 200)}`);
			if (e.logs) {
				const errorLogs = e.logs.filter((l: string) =>
					l.includes('Error') || l.includes('error') || l.includes('failed')
				);
				errorLogs.forEach((l: string) => console.log(`    ${l}`));
			}
		}
	} else {
		console.log('  Could not find open orders for fill.');
		if (!takerOpenOrder) console.log('    Missing taker order');
		if (!makerOpenOrder) console.log('    Missing maker order');
	}

	// ------------------------------------------------------------------
	// 14. Verify results
	// ------------------------------------------------------------------
	console.log('\n--- Step 14: Verification ---');

	// Query DLOB — orders should be gone
	const dlob3 = await queryDlobL3(SOL_PERP_MARKET_INDEX);
	if (dlob3) {
		const bids = dlob3.bids?.length || 0;
		const asks = dlob3.asks?.length || 0;
		console.log(`  DLOB L3 (post-fill): ${bids} bids, ${asks} asks`);
	}

	// Check positions
	await adminClient.fetchAccounts();
	await takerClient.fetchAccounts();

	const adminPosition = adminClient
		.getUser()
		.getPerpPosition(SOL_PERP_MARKET_INDEX);
	const takerPosition = takerClient
		.getUser()
		.getPerpPosition(SOL_PERP_MARKET_INDEX);

	console.log('\n  Admin (maker) SOL-PERP position:');
	if (adminPosition && !adminPosition.baseAssetAmount.isZero()) {
		const side = adminPosition.baseAssetAmount.isNeg() ? 'SHORT' : 'LONG';
		console.log(`    Side: ${side}`);
		console.log(
			`    Base amount: ${adminPosition.baseAssetAmount.toString()} (${adminPosition.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber()} SOL)`
		);
		console.log(
			`    Quote entry: ${adminPosition.quoteEntryAmount.toString()}`
		);
	} else {
		console.log('    No position (order may not have filled)');
	}

	console.log('\n  Taker LONG SOL-PERP position:');
	if (takerPosition && !takerPosition.baseAssetAmount.isZero()) {
		const side = takerPosition.baseAssetAmount.isNeg() ? 'SHORT' : 'LONG';
		console.log(`    Side: ${side}`);
		console.log(
			`    Base amount: ${takerPosition.baseAssetAmount.toString()} (${takerPosition.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber()} SOL)`
		);
		console.log(
			`    Quote entry: ${takerPosition.quoteEntryAmount.toString()}`
		);
	} else {
		console.log('    No position (order may not have filled)');
	}

	// ------------------------------------------------------------------
	// 15. Summary
	// ------------------------------------------------------------------
	console.log('\n=== Test Summary ===');
	// Taker position is the key indicator (taker is always fresh)
	const takerFilled =
		takerPosition && !takerPosition.baseAssetAmount.isZero();
	if (takerFilled) {
		const takerSide = takerPosition.baseAssetAmount.isNeg()
			? 'SHORT'
			: 'LONG';
		const takerOk = takerSide === 'LONG';
		const adminSide = adminPosition?.baseAssetAmount.isNeg()
			? 'SHORT'
			: 'LONG';
		console.log(
			`  Maker (admin): ${adminSide} (position includes previous runs)`
		);
		console.log(
			`  Taker:         ${takerSide} ${takerOk ? '✓' : '✗ UNEXPECTED'}`
		);
		console.log(`  Result:        ${takerOk ? 'PASS' : 'FAIL'}`);
	} else {
		console.log('  Taker has no position — fill did not succeed.');
		console.log('  Result: FAIL');
	}

	// Cleanup
	await adminClient.unsubscribe();
	await takerClient.unsubscribe();
	console.log('\nDone.\n');
}

main().catch((err) => {
	console.error('\nTest failed:', err);
	process.exit(1);
});
