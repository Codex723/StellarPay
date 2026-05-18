/**
 * @stellarpay/sdk — Currency Module
 *
 * Auto-convert between assets using Stellar DEX path payments.
 * Discovers the best conversion path (order book or liquidity pool),
 * applies slippage protection, and executes the swap on-chain.
 */

import {
  Asset,
  Operation,
  Horizon,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import type { StellarClient } from './client.js';
import type { ConversionConfig, ConversionPath, ConversionResult } from './types.js';

/** Well-known asset registry: code → (code, issuer) on each network */
const ASSET_REGISTRY: Record<string, Record<string, { code: string; issuer: string }>> = {
  mainnet: {
    USDC: {
      code: 'USDC',
      issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    },
    NGNT: {
      code: 'NGNT',
      issuer: 'GAWODAROMJ33V5YDFY3CDHN4YIXEQD6ZYHFKWYWMTCOAHK7HB6GHFMG',
    },
    BRL: {
      code: 'BRL',
      issuer: 'GDVKY2GU2DRXWTBEYJJWSFXIGBZV6AZNBVVSUHEPZI54LIS6BA7DVVSP',
    },
    EURC: {
      code: 'EURC',
      issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP',
    },
  },
  testnet: {
    USDC: {
      code: 'USDC',
      issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    },
  },
  futurenet: {},
};

export class CurrencyModule {
  constructor(private readonly client: StellarClient) {}

  /**
   * Discover the best DEX path for a given conversion.
   *
   * Queries Horizon's strict-receive path payment endpoint to find
   * the optimal route, including multi-hop liquidity pool paths.
   *
   * @example
   * ```ts
   * const path = await sdk.currency.findPath({
   *   fromAsset: 'USDC',
   *   toAsset: 'NGNT',
   *   amount: 3000,
   *   slippageTolerance: 0.01, // 1%
   * });
   * console.log(path.expectedOutput, path.path);
   * ```
   */
  async findPath(config: ConversionConfig): Promise<ConversionPath> {
    validateConversionConfig(config);

    const sourceAsset = this.resolveAsset(config.fromAsset);
    const destAsset = this.resolveAsset(config.toAsset);
    const slippage = config.slippageTolerance ?? 0.005;

    // Query Horizon for strict-receive paths
    const paths = await (this.client.horizon as unknown as Horizon.Server)
      .strictReceivePaths(
        [sourceAsset],
        destAsset,
        String(config.amount.toFixed(7))
      )
      .call();

    if (!paths.records || paths.records.length === 0) {
      throw new Error(
        `No DEX path found from ${config.fromAsset} to ${config.toAsset}. ` +
          'The pair may have insufficient liquidity.'
      );
    }

    // Pick the path with the lowest source amount (best rate)
    const best = paths.records.reduce((a, b) =>
      parseFloat(a.source_amount) <= parseFloat(b.source_amount) ? a : b
    );

    const expectedOutput = config.amount;
    const inputAmount = parseFloat(best.source_amount);
    const rate = expectedOutput / inputAmount;
    const minOutput = expectedOutput * (1 - slippage);

    const intermediaryAssets: string[] = best.path.map((a: { asset_code?: string }) =>
      a.asset_code ?? 'XLM'
    );

    return {
      fromAsset: config.fromAsset,
      toAsset: config.toAsset,
      path: intermediaryAssets,
      expectedOutput,
      minOutput,
      rate,
      source: intermediaryAssets.length > 0 ? 'liquidity_pool' : 'order_book',
    };
  }

  /**
   * Execute a conversion using the provided path.
   *
   * Uses a strict-receive path payment so the recipient always gets
   * exactly the expected amount (slippage is applied to the source side).
   *
   * @example
   * ```ts
   * const path = await sdk.currency.findPath({ fromAsset: 'USDC', toAsset: 'NGNT', amount: 3000 });
   * const result = await sdk.currency.convert(path, 3000);
   * console.log(result.outputAmount, result.effectiveRate);
   * ```
   */
  async convert(path: ConversionPath, amount: number): Promise<ConversionResult> {
    if (amount <= 0) throw new Error('Conversion amount must be positive');

    const sourceAsset = this.resolveAsset(path.fromAsset);
    const destAsset = this.resolveAsset(path.toAsset);
    const slippage = 1 + 0.01; // 1% max source overspend
    const maxSourceAmount = ((amount / path.rate) * slippage).toFixed(7);
    const destAmount = amount.toFixed(7);

    const intermediaryAssets = path.path
      .filter((c) => c !== path.fromAsset && c !== path.toAsset)
      .map((code) => this.resolveAsset(code));

    const account = await this.client.loadAccount();
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.client.networkPassphrase,
    })
      .addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: sourceAsset,
          sendMax: maxSourceAmount,
          destination: this.client.publicKey,
          destAsset,
          destAmount,
          path: intermediaryAssets,
        })
      )
      .setTimeout(30)
      .build();

    const response = await this.client.submitTransaction(tx);

    return {
      txHash: response.hash,
      fromAsset: path.fromAsset,
      toAsset: path.toAsset,
      inputAmount: parseFloat(maxSourceAmount),
      outputAmount: amount,
      effectiveRate: amount / parseFloat(maxSourceAmount),
      path: path.path,
    };
  }

  /**
   * Convenience: find the best path and execute it in one call.
   *
   * @example
   * ```ts
   * const result = await sdk.currency.swap({
   *   fromAsset: 'USDC',
   *   toAsset: 'NGNT',
   *   amount: 3000,
   * });
   * ```
   */
  async swap(config: ConversionConfig): Promise<ConversionResult> {
    const path = await this.findPath(config);
    return this.convert(path, config.amount);
  }

  /**
   * Get the spot rate between two assets without executing a swap.
   * Returns how many units of `toAsset` you get per unit of `fromAsset`.
   */
  async getRate(fromAsset: string, toAsset: string): Promise<number> {
    const path = await this.findPath({ fromAsset, toAsset, amount: 1 });
    return path.rate;
  }

  /**
   * List all registered assets for the current network.
   */
  listSupportedAssets(): string[] {
    const network = this.networkName();
    return ['XLM', ...Object.keys(ASSET_REGISTRY[network] ?? {})];
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private resolveAsset(code: string): Asset {
    if (code === 'XLM') return Asset.native();
    const network = this.networkName();
    const entry = ASSET_REGISTRY[network]?.[code];
    if (!entry) {
      throw new Error(
        `Asset '${code}' is not registered for ${network}. ` +
          `Supported: ${this.listSupportedAssets().join(', ')}`
      );
    }
    return new Asset(entry.code, entry.issuer);
  }

  private networkName(): string {
    // Derive from the client's network passphrase
    const passphrase = this.client.networkPassphrase;
    if (passphrase.includes('Public')) return 'mainnet';
    if (passphrase.includes('Test')) return 'testnet';
    return 'futurenet';
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateConversionConfig(config: ConversionConfig): void {
  if (!config.fromAsset?.trim()) throw new Error('ConversionConfig.fromAsset is required');
  if (!config.toAsset?.trim()) throw new Error('ConversionConfig.toAsset is required');
  if (config.fromAsset === config.toAsset) {
    throw new Error('fromAsset and toAsset must be different');
  }
  if (config.amount <= 0) throw new Error('ConversionConfig.amount must be positive');
  if (
    config.slippageTolerance !== undefined &&
    (config.slippageTolerance < 0 || config.slippageTolerance > 0.5)
  ) {
    throw new Error('slippageTolerance must be between 0 and 0.5 (0%–50%)');
  }
}
