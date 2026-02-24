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
} from '@solana/spl-token';
import http from 'http';
import { DLOB_SERVER } from './config';

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function httpGet(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => {
			let data = '';
			res.on('data', (chunk) => (data += chunk));
			res.on('end', () => resolve(data));
			res.on('error', reject);
		}).on('error', reject);
	});
}

export async function queryDlobL3(marketIndex: number): Promise<any> {
	const url = `${DLOB_SERVER}/l3?marketIndex=${marketIndex}&marketType=perp`;
	try {
		const raw = await httpGet(url);
		return JSON.parse(raw);
	} catch (e: any) {
		console.log(`  DLOB query failed: ${e.message}`);
		return null;
	}
}

export async function ensureAta(
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

export async function fundSol(
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
