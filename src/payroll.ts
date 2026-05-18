/**
 * @stellarpay/sdk — Payroll Module
 *
 * Handles batch salary disbursement with date scheduling via the
 * StellarPay Soroban vault contract. Supports multi-recipient batches,
 * recurring schedules, and optional per-recipient currency conversion.
 */

import { xdr, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import type { StellarClient } from './client.js';
import type {
  PayrollConfig,
  PayrollSchedule,
  PayrollStatus,
  DisbursementResult,
  RecipientOutcome,
  PaginatedResponse,
} from './types.js';

export class PayrollModule {
  constructor(private readonly client: StellarClient) {}

  /**
   * Schedule a recurring payroll.
   *
   * Deposits the total payroll amount into the Soroban vault and registers
   * the disbursement schedule. Funds are held in escrow and released
   * automatically on `disbursementDay` each month.
   *
   * @example
   * ```ts
   * const schedule = await sdk.payroll.schedule({
   *   recipients: [
   *     { stellarAddress: 'GABC...', amount: 3000 },
   *     { stellarAddress: 'GDEF...', amount: 4500, preferredCurrency: 'NGNT' },
   *   ],
   *   currency: 'USDC',
   *   disbursementDay: 1,
   *   autoConvert: true,
   * });
   * console.log(schedule.id, schedule.nextDisbursementAt);
   * ```
   */
  async schedule(config: PayrollConfig): Promise<PayrollSchedule> {
    validatePayrollConfig(config);

    const totalAmount = config.recipients.reduce((sum, r) => sum + r.amount, 0);

    // Build Soroban args: (recipients_vec, currency, disbursement_day, auto_convert)
    const args: xdr.ScVal[] = [
      nativeToScVal(
        config.recipients.map((r) => ({
          address: r.stellarAddress,
          amount: BigInt(Math.round(r.amount * 1e7)), // stroops
          preferred_currency: r.preferredCurrency ?? null,
          label: r.label ?? null,
        }))
      ),
      nativeToScVal(config.currency),
      nativeToScVal(config.disbursementDay, { type: 'u32' }),
      nativeToScVal(config.autoConvert ?? false),
      nativeToScVal(config.memo ?? null),
    ];

    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'create_payroll',
      args,
    });

    const returnValue = scValToNative(result.returnValue!);

    return {
      id: returnValue.id as string,
      txHash: result.txHash,
      config,
      status: 'scheduled',
      nextDisbursementAt: nextDisbursementDate(config.disbursementDay).toISOString(),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Get the current status of a payroll schedule.
   */
  async getStatus(payrollId: string): Promise<PayrollSchedule> {
    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'get_payroll',
      args: [nativeToScVal(payrollId)],
    });

    const data = scValToNative(result.returnValue!);
    return deserializeSchedule(data);
  }

  /**
   * Manually trigger disbursement for a payroll (if disbursement day has passed).
   * Normally disbursement is automatic — use this for testing or recovery.
   */
  async disburse(payrollId: string): Promise<DisbursementResult> {
    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'disburse',
      args: [nativeToScVal(payrollId)],
    });

    const data = scValToNative(result.returnValue!);
    return deserializeDisbursementResult(data, payrollId, result.txHash);
  }

  /**
   * Cancel a scheduled payroll and refund remaining vault balance to employer.
   */
  async cancel(payrollId: string): Promise<{ txHash: string }> {
    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'cancel_payroll',
      args: [nativeToScVal(payrollId)],
    });

    return { txHash: result.txHash };
  }

  /**
   * Top up the vault for an existing payroll schedule.
   * Use this before the disbursement day if the vault balance is insufficient.
   */
  async topUp(payrollId: string, amount: number, currency: string): Promise<{ txHash: string }> {
    if (amount <= 0) throw new Error('Top-up amount must be positive');

    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'top_up',
      args: [
        nativeToScVal(payrollId),
        nativeToScVal(BigInt(Math.round(amount * 1e7)), { type: 'i128' }),
        nativeToScVal(currency),
      ],
    });

    return { txHash: result.txHash };
  }

  /**
   * List all payroll schedules created by the current signer key.
   */
  async list(filter?: {
    status?: PayrollStatus;
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResponse<PayrollSchedule>> {
    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'list_payrolls',
      args: [
        nativeToScVal(this.client.publicKey),
        nativeToScVal(filter?.status ?? null),
        nativeToScVal(filter?.limit ?? 50, { type: 'u32' }),
        nativeToScVal(filter?.cursor ?? null),
      ],
    });

    const data = scValToNative(result.returnValue!) as {
      items: unknown[];
      total: number;
      cursor?: string;
    };

    return {
      items: data.items.map(deserializeSchedule),
      total: data.total,
      cursor: data.cursor,
      hasMore: !!data.cursor,
    };
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validatePayrollConfig(config: PayrollConfig): void {
  if (!config.recipients || config.recipients.length === 0) {
    throw new Error('PayrollConfig.recipients must contain at least one recipient');
  }
  if (config.recipients.length > 100) {
    throw new Error('PayrollConfig.recipients cannot exceed 100 entries per batch');
  }
  if (config.disbursementDay < 1 || config.disbursementDay > 28) {
    throw new Error('PayrollConfig.disbursementDay must be between 1 and 28');
  }
  if (!config.currency || config.currency.trim() === '') {
    throw new Error('PayrollConfig.currency is required');
  }
  for (const r of config.recipients) {
    if (!r.stellarAddress || !r.stellarAddress.startsWith('G')) {
      throw new Error(`Invalid Stellar address: ${r.stellarAddress}`);
    }
    if (r.amount <= 0) {
      throw new Error(`Recipient amount must be positive (got ${r.amount})`);
    }
  }
  if (config.memo && Buffer.byteLength(config.memo, 'utf8') > 28) {
    throw new Error('PayrollConfig.memo must be at most 28 bytes');
  }
}

// ─── Deserializers ───────────────────────────────────────────────────────────

function deserializeSchedule(data: unknown): PayrollSchedule {
  const d = data as Record<string, unknown>;
  return {
    id: d.id as string,
    txHash: d.tx_hash as string,
    config: d.config as PayrollSchedule['config'],
    status: d.status as PayrollStatus,
    nextDisbursementAt: d.next_disbursement_at as string,
    createdAt: d.created_at as string,
  };
}

function deserializeDisbursementResult(
  data: unknown,
  payrollId: string,
  txHash: string
): DisbursementResult {
  const d = data as Record<string, unknown>;
  const outcomes = (d.outcomes as unknown[]).map((o) => {
    const outcome = o as Record<string, unknown>;
    return {
      stellarAddress: outcome.address as string,
      amount: Number(outcome.amount) / 1e7,
      currency: outcome.currency as string,
      txHash: outcome.tx_hash as string,
      success: outcome.success as boolean,
      errorMessage: outcome.error_message as string | undefined,
    } satisfies RecipientOutcome;
  });

  return {
    payrollId,
    successCount: outcomes.filter((o) => o.success).length,
    failureCount: outcomes.filter((o) => !o.success).length,
    outcomes,
    disbursedAt: (d.disbursed_at as string) ?? new Date().toISOString(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Calculate the next disbursement date for a given day-of-month */
function nextDisbursementDate(day: number): Date {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), day);
  if (candidate <= now) {
    candidate.setMonth(candidate.getMonth() + 1);
  }
  return candidate;
}
