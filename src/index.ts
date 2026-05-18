/**
 * @stellarpay/sdk
 *
 * Decentralized payroll & invoicing SDK built on Stellar and Soroban.
 * Plug employee payroll, contractor invoicing, and multi-currency
 * disbursements into any app in a few lines of code.
 *
 * @example
 * ```ts
 * import { StellarPay } from '@stellarpay/sdk';
 *
 * const sdk = new StellarPay({
 *   network: 'testnet',
 *   signerKey: process.env.STELLAR_SECRET!,
 * });
 *
 * // Schedule monthly payroll
 * const schedule = await sdk.payroll.schedule({
 *   recipients: [{ stellarAddress: 'GABC...', amount: 3000 }],
 *   currency: 'USDC',
 *   disbursementDay: 1,
 * });
 *
 * // Issue a contractor invoice
 * const invoice = await sdk.invoice.issue({
 *   issuerAddress: 'GABC...',
 *   recipientAddress: 'GDEF...',
 *   amount: 1500,
 *   currency: 'USDC',
 *   dueDate: '2025-08-01',
 * });
 *
 * // Swap USDC → NGNT via DEX
 * const result = await sdk.currency.swap({ fromAsset: 'USDC', toAsset: 'NGNT', amount: 500 });
 * ```
 */

import { StellarClient } from './client.js';
import { PayrollModule } from './payroll.js';
import { InvoiceModule } from './invoice.js';
import { CurrencyModule } from './currency.js';
import type { StellarPayConfig } from './types.js';

export class StellarPay {
  /** Payroll scheduling and batch disbursements */
  readonly payroll: PayrollModule;
  /** On-chain invoice issuance, tracking, and settlement */
  readonly invoice: InvoiceModule;
  /** DEX path payment discovery and auto-conversion */
  readonly currency: CurrencyModule;

  /** Underlying Stellar/Soroban client (advanced use) */
  readonly client: StellarClient;

  constructor(config: StellarPayConfig) {
    this.client = new StellarClient(config);
    this.payroll = new PayrollModule(this.client);
    this.invoice = new InvoiceModule(this.client);
    this.currency = new CurrencyModule(this.client);
  }

  /** The public key derived from the configured signer key */
  get publicKey(): string {
    return this.client.publicKey;
  }
}

// Re-export all types for consumer convenience
export type {
  StellarPayConfig,
  StellarNetwork,
  PayrollConfig,
  PayrollRecipient,
  PayrollSchedule,
  PayrollStatus,
  DisbursementResult,
  RecipientOutcome,
  CreateInvoiceInput,
  InvoiceRecord,
  InvoiceFilter,
  InvoiceStatus,
  ConversionConfig,
  ConversionPath,
  ConversionResult,
  PaginatedResponse,
} from './types.js';

export { PayrollModule } from './payroll.js';
export { InvoiceModule } from './invoice.js';
export { CurrencyModule } from './currency.js';
export { StellarClient } from './client.js';
