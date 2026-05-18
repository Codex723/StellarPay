/**
 * @stellarpay/sdk — Core Types
 * Strict TypeScript interfaces for all SDK data structures.
 */

// ─── Network ───────────────────────────────────────────────────────────────

/** Stellar network to connect to */
export type StellarNetwork = 'mainnet' | 'testnet' | 'futurenet';

/** Top-level SDK configuration */
export interface StellarPayConfig {
  /** Stellar network environment */
  network: StellarNetwork;
  /** Employer's Stellar secret key (keep server-side only) */
  signerKey: string;
  /** Optional: override RPC endpoint */
  rpcUrl?: string;
  /** Optional: override Horizon endpoint */
  horizonUrl?: string;
  /** Optional: Soroban vault contract ID (defaults to deployed address) */
  vaultContractId?: string;
}

// ─── Payroll ────────────────────────────────────────────────────────────────

/** A single payroll recipient */
export interface PayrollRecipient {
  /** Stellar public key (G...) of the employee/contractor */
  stellarAddress: string;
  /** Gross payment amount in the payroll's base currency */
  amount: number;
  /**
   * Override currency for this recipient.
   * If set, funds are auto-converted via DEX before delivery.
   * Falls back to PayrollConfig.currency when omitted.
   */
  preferredCurrency?: string;
  /** Human-readable label (name, employee ID, etc.) — stored off-chain */
  label?: string;
}

/** Configuration for scheduling a recurring payroll */
export interface PayrollConfig {
  /**
   * List of recipients for this payroll run.
   * Minimum 1, maximum 100 recipients per batch.
   */
  recipients: PayrollRecipient[];
  /**
   * Base disbursement currency asset code.
   * Use 'USDC', 'XLM', or any Stellar asset code.
   */
  currency: string;
  /**
   * Day of month to disburse (1–28).
   * Use 28 to safely cover all months including February.
   */
  disbursementDay: number;
  /**
   * Automatically convert to each recipient's preferredCurrency
   * via Stellar DEX path payments before delivery.
   * @default false
   */
  autoConvert?: boolean;
  /**
   * ISO 4217 memo to attach to each payment transaction.
   * Max 28 bytes when encoded as text.
   */
  memo?: string;
}

/** Payroll schedule status */
export type PayrollStatus =
  | 'scheduled'   // Vault funded, awaiting disbursement day
  | 'processing'  // Disbursement in progress
  | 'completed'   // All recipients paid this cycle
  | 'failed'      // One or more payments failed
  | 'cancelled';  // Cancelled before disbursement

/** A created payroll schedule returned from payroll.schedule() */
export interface PayrollSchedule {
  /** Unique on-chain identifier for this payroll schedule */
  id: string;
  /** Soroban transaction hash that created this schedule */
  txHash: string;
  config: PayrollConfig;
  status: PayrollStatus;
  /** ISO 8601 timestamp of next scheduled disbursement */
  nextDisbursementAt: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
}

/** Result of a single disbursement run */
export interface DisbursementResult {
  payrollId: string;
  /** Number of recipients successfully paid */
  successCount: number;
  /** Number of recipients that failed */
  failureCount: number;
  /** Per-recipient outcomes */
  outcomes: RecipientOutcome[];
  /** ISO 8601 timestamp of disbursement */
  disbursedAt: string;
}

/** Outcome for one recipient in a disbursement */
export interface RecipientOutcome {
  stellarAddress: string;
  amount: number;
  currency: string;
  txHash: string;
  success: boolean;
  errorMessage?: string;
}

// ─── Invoice ────────────────────────────────────────────────────────────────

/** Invoice status lifecycle */
export type InvoiceStatus = 'draft' | 'issued' | 'pending' | 'paid' | 'overdue' | 'cancelled';

/** Input for creating a new invoice */
export interface CreateInvoiceInput {
  /** Stellar address of the invoice issuer (contractor/freelancer) */
  issuerAddress: string;
  /** Stellar address of the payer (client/employer) */
  recipientAddress: string;
  /** Invoice amount */
  amount: number;
  /** Asset code for the invoice currency */
  currency: string;
  /** ISO 8601 due date */
  dueDate: string;
  /** Human-readable description of work/services */
  description?: string;
  /** Arbitrary key-value metadata stored in the contract */
  metadata?: Record<string, string | number | boolean>;
}

/** A fully resolved on-chain invoice record */
export interface InvoiceRecord {
  /** Unique on-chain invoice ID (contract-generated hash) */
  id: string;
  /** Soroban transaction hash that issued this invoice */
  txHash: string;
  /** Stellar address of the issuer */
  issuer: string;
  /** Stellar address of the payer */
  recipient: string;
  /** Invoice amount */
  amount: number;
  /** Asset code */
  currency: string;
  /** ISO 8601 due date */
  dueDate: string;
  /** Current lifecycle status */
  status: InvoiceStatus;
  /** Optional work description */
  description?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, string | number | boolean>;
  /** ISO 8601 issue timestamp */
  issuedAt: string;
  /** ISO 8601 payment timestamp (set when status = 'paid') */
  paidAt?: string;
  /** Transaction hash of the settlement payment */
  settlementTxHash?: string;
}

/** Filters for listing invoices */
export interface InvoiceFilter {
  status?: InvoiceStatus;
  issuerAddress?: string;
  recipientAddress?: string;
  /** Return invoices due before this ISO 8601 date */
  dueBefore?: string;
  /** Return invoices due after this ISO 8601 date */
  dueAfter?: string;
  /** Max results to return (default 50) */
  limit?: number;
  /** Pagination cursor */
  cursor?: string;
}

// ─── Currency / DEX ─────────────────────────────────────────────────────────

/** Configuration for a DEX conversion */
export interface ConversionConfig {
  /** Source asset code (e.g. 'USDC') */
  fromAsset: string;
  /** Target asset code (e.g. 'NGNT', 'BRL') */
  toAsset: string;
  /** Amount of fromAsset to convert */
  amount: number;
  /**
   * Maximum acceptable slippage as a decimal fraction.
   * e.g. 0.005 = 0.5%
   * @default 0.005
   */
  slippageTolerance?: number;
}

/** A discovered DEX path for a conversion */
export interface ConversionPath {
  fromAsset: string;
  toAsset: string;
  /** Intermediate asset hops, empty for direct pair */
  path: string[];
  /** Expected output amount before slippage */
  expectedOutput: number;
  /** Minimum output amount after slippage applied */
  minOutput: number;
  /** Effective exchange rate */
  rate: number;
  /** Path source: 'order_book' | 'liquidity_pool' */
  source: 'order_book' | 'liquidity_pool';
}

/** Result of an executed conversion */
export interface ConversionResult {
  txHash: string;
  fromAsset: string;
  toAsset: string;
  inputAmount: number;
  outputAmount: number;
  effectiveRate: number;
  path: string[];
}

// ─── Shared ─────────────────────────────────────────────────────────────────

/** Generic paginated response wrapper */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  cursor?: string;
  hasMore: boolean;
}
