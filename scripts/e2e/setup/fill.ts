import { Keypair, PublicKey } from '@solana/web3.js';
import { AdminClient, DriftClient } from '../../../sdk/src';
import {
	getUserAccountPublicKeySync,
	getUserStatsAccountPublicKey,
} from '../../../sdk/src/addresses/pda';
import { sleep } from './helpers';

export interface MakerInfo {
	maker: PublicKey;
	makerStats: PublicKey;
	makerUserAccount: any;
	order: any;
}

/**
 * Build MakerInfo for a fill instruction.
 */
export function buildMakerInfo(
	programId: PublicKey,
	makerKeypair: Keypair,
	makerClient: DriftClient | AdminClient,
	makerSubAccountId: number,
	makerOrder: any
): MakerInfo {
	const makerUserPubkey = getUserAccountPublicKeySync(
		programId,
		makerKeypair.publicKey,
		makerSubAccountId
	);
	return {
		maker: makerUserPubkey,
		makerStats: getUserStatsAccountPublicKey(
			programId,
			makerKeypair.publicKey
		),
		makerUserAccount: makerClient.getUserAccount()!,
		order: makerOrder,
	};
}

/**
 * Execute a direct fill: filler matches taker order against a maker.
 * Returns true if the fill succeeded.
 */
export async function directFill(
	fillerClient: AdminClient | DriftClient,
	takerUserPubkey: PublicKey,
	takerUserAccount: any,
	takerOrder: any,
	makerInfo?: MakerInfo
): Promise<boolean> {
	console.log('\n--- Direct fill ---');
	if (takerOrder) {
		console.log(
			`  Taker order: id=${takerOrder.orderId}, price=${takerOrder.price.toString()}`
		);
	}
	if (makerInfo) {
		console.log(
			`  Maker order: id=${makerInfo.order.orderId}, price=${makerInfo.order.price.toString()}`
		);
	}

	try {
		const fillTx = await fillerClient.fillPerpOrder(
			takerUserPubkey,
			takerUserAccount,
			{
				marketIndex: takerOrder.marketIndex,
				orderId: takerOrder.orderId,
			},
			makerInfo
		);
		console.log(`  Fill transaction sent. Tx: ${fillTx}`);
		await sleep(2000);
		await fillerClient.fetchAccounts();
		return true;
	} catch (e: any) {
		console.log(`  Direct fill failed: ${e.message?.slice(0, 200)}`);
		if (e.logs) {
			const errorLogs = e.logs.filter(
				(l: string) =>
					l.includes('Error') ||
					l.includes('error') ||
					l.includes('failed')
			);
			errorLogs.forEach((l: string) => console.log(`    ${l}`));
		}
		return false;
	}
}
