import { execSync } from 'child_process';
import path from 'path';

const TESTS = [
	'01-cross-limit-orders',
	'02-market-orders',
	'03-partial-fills',
	'04-multiple-makers',
	'05-jit-auction-fill',
	'06-post-only-rejection',
	'07-expired-orders',
	'08-oracle-pegged-orders',
	'09-reduce-only',
	'10-immediate-or-cancel',
	'11-basic-liquidation',
	'12-partial-liquidation',
	'13-multi-position-liquidation',
	'14-auto-derisking',
	'15-stop-loss',
	'16-take-profit',
	'17-triggered-with-crossing',
	'18-funding-rate-update',
	'19-funding-payment-settlement',
	'20-settle-positive-pnl',
	'21-settle-negative-pnl',
	'22-cross-margin-leverage',
	'23-btc-eth-fills',
	'24-self-trade-prevention',
	'25-minimum-order-size',
	'26-price-band-limits',
	'27-concurrent-takers',
	'28-insufficient-margin',
];

// Parse CLI args: allow filtering (e.g. `run-all.ts 01 02 03`)
const filter = process.argv.slice(2);
const testsToRun = filter.length > 0
	? TESTS.filter((t) => filter.some((f) => t.startsWith(f)))
	: TESTS;

interface Result {
	name: string;
	status: 'PASS' | 'FAIL' | 'SKIP';
	duration: number;
}

async function main() {
	console.log(`\n=== E2E Test Runner ===`);
	console.log(`Running ${testsToRun.length} of ${TESTS.length} tests\n`);

	const results: Result[] = [];
	const e2eDir = path.resolve(__dirname);

	for (const test of testsToRun) {
		const testFile = path.join(e2eDir, `${test}.ts`);
		console.log(`\n${'='.repeat(60)}`);
		console.log(`Running: ${test}`);
		console.log('='.repeat(60));

		const start = Date.now();
		try {
			execSync(
				`npx ts-node --transpile-only ${testFile}`,
				{
					stdio: 'inherit',
					cwd: path.resolve(__dirname, '../..'), // protocol-v2 root
					timeout: 120_000, // 2 minute timeout per test
				}
			);
			const duration = Date.now() - start;
			results.push({ name: test, status: 'PASS', duration });
		} catch (e: any) {
			const duration = Date.now() - start;
			if (e.status === 0) {
				// TODO stubs exit(0)
				results.push({ name: test, status: 'SKIP', duration });
			} else {
				results.push({ name: test, status: 'FAIL', duration });
			}
		}
	}

	// Print summary
	console.log(`\n${'='.repeat(60)}`);
	console.log('TEST RESULTS SUMMARY');
	console.log('='.repeat(60));

	const passed = results.filter((r) => r.status === 'PASS');
	const failed = results.filter((r) => r.status === 'FAIL');
	const skipped = results.filter((r) => r.status === 'SKIP');

	for (const r of results) {
		const icon = r.status === 'PASS' ? 'PASS' : r.status === 'FAIL' ? 'FAIL' : 'SKIP';
		const time = `${(r.duration / 1000).toFixed(1)}s`;
		console.log(`  [${icon}] ${r.name} (${time})`);
	}

	console.log(`\nTotal: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length} | Skipped: ${skipped.length}`);

	if (failed.length > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Runner failed:', err);
	process.exit(1);
});
