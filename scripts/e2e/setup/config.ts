import { BN } from '@coral-xyz/anchor';
import { BASE_PRECISION, PRICE_PRECISION, QUOTE_PRECISION } from '../../../sdk/src';

// ============================================================================
// ENVIRONMENT
// ============================================================================

export const ENV = (process.env.DRIFT_ENV || 'devnet') as 'devnet' | 'mainnet-beta';
export const RPC_ENDPOINT =
	process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com';
export const ADMIN_KEYPAIR_PATH =
	process.env.ADMIN_KEYPAIR_PATH || './keys/admin-keypair.json';
export const DLOB_SERVER = process.env.DLOB_SERVER || 'http://localhost:6969';

// ============================================================================
// MARKET INDICES
// ============================================================================

export const SOL_PERP_MARKET_INDEX = 0;
export const BTC_PERP_MARKET_INDEX = 1;
export const ETH_PERP_MARKET_INDEX = 2;
export const USDC_SPOT_MARKET_INDEX = 0;

// ============================================================================
// DEFAULTS
// ============================================================================

export const DEFAULT_ORDER_SIZE = BASE_PRECISION.divn(10); // 0.1 SOL
export const DEFAULT_COLLATERAL = new BN(1000).mul(QUOTE_PRECISION); // 1000 USDC

// ============================================================================
// RE-EXPORTS (convenience)
// ============================================================================

export { BASE_PRECISION, PRICE_PRECISION, QUOTE_PRECISION };
