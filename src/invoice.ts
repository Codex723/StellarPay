/**
 * @stellarpay/sdk — Invoice Module
 *
 * Issue, track, and settle contractor/freelance invoices on-chain.
 * Invoice records are stored immutably via the Soroban vault contract,
 * giving both parties a verifiable, tamper-proof payment trail.
 */

import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import type { StellarClient } from './client.js';
import type {
  CreateInvoiceInput,
  InvoiceRecord,
  InvoiceFilter,
  InvoiceStatus,
  PaginatedResponse,
} from './types.js';

export class InvoiceModule {
  constructor(private readonly client: StellarClient) {}

  /**
   * Issue a new invoice and record it on-chain.
   *
   * The invoice is immutably recorded in the Soroban vault.
   * Both issuer and recipient can verify it by querying the contract.
   *
   * @example
   * ```ts
   * const invoice = await sdk.invoice.issue({
   *   issuerAddress: 'GABC...',
   *   recipientAddress: 'GDEF...',
   *   amount: 2500,
   *   currency: 'USDC',
   *   dueDate: '2025-08-01',
   *   description: 'Frontend development — July 2025',
   *   metadata: { projectId: 'proj_42', hoursLogged: 40 },
   * });
   * ```
   */
  async issue(input: CreateInvoiceInput): Promise<InvoiceRecord> {
    validateCreateInvoiceInput(input);

    const args = [
      nativeToScVal(input.issuerAddress),
      nativeToScVal(input.recipientAddress),
      nativeToScVal(BigInt(Math.round(input.amount * 1e7)), { type: 'i128' }),
      nativeToScVal(input.currency),
      nativeToScVal(new Date(input.dueDate).getTime(), { type: 'u64' }),
      nativeToScVal(input.description ?? null),
      nativeToScVal(input.metadata ? JSON.stringify(input.metadata) : null),
    ];

    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'issue_invoice',
      args,
    });

    const data = scValToNative(result.returnValue!);
    return deserializeInvoice(data);
  }

  /**
   * Fetch a single invoice by its on-chain ID.
   */
  async get(invoiceId: string): Promise<InvoiceRecord> {
    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'get_invoice',
      args: [nativeToScVal(invoiceId)],
    });

    return deserializeInvoice(scValToNative(result.returnValue!));
  }

  /**
   * Settle (pay) an invoice.
   *
   * Transfers the invoice amount from the payer to the issuer and marks
   * the invoice as 'paid' on-chain. The payer must call this method.
   *
   * @example
   * ```ts
   * const settled = await sdk.invoice.settle('INV_abc123');
   * console.log(settled.status); // 'paid'
   * console.log(settled.settlementTxHash);
   * ```
   */
  async settle(invoiceId: string): Promise<InvoiceRecord> {
    if (!invoiceId) throw new Error('invoiceId is required');

    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'settle_invoice',
      args: [nativeToScVal(invoiceId)],
    });

    return deserializeInvoice(scValToNative(result.returnValue!));
  }

  /**
   * Cancel a draft or issued invoice.
   * Only the original issuer can cancel.
   */
  async cancel(invoiceId: string): Promise<InvoiceRecord> {
    if (!invoiceId) throw new Error('invoiceId is required');

    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'cancel_invoice',
      args: [nativeToScVal(invoiceId)],
    });

    return deserializeInvoice(scValToNative(result.returnValue!));
  }

  /**
   * List invoices with optional filters.
   *
   * @example
   * ```ts
   * // All pending invoices for a specific recipient
   * const { items } = await sdk.invoice.list({
   *   status: 'pending',
   *   recipientAddress: 'GDEF...',
   * });
   * ```
   */
  async list(filter: InvoiceFilter = {}): Promise<PaginatedResponse<InvoiceRecord>> {
    const args = [
      nativeToScVal(filter.status ?? null),
      nativeToScVal(filter.issuerAddress ?? null),
      nativeToScVal(filter.recipientAddress ?? null),
      nativeToScVal(
        filter.dueBefore ? new Date(filter.dueBefore).getTime() : null,
        { type: 'u64' }
      ),
      nativeToScVal(
        filter.dueAfter ? new Date(filter.dueAfter).getTime() : null,
        { type: 'u64' }
      ),
      nativeToScVal(filter.limit ?? 50, { type: 'u32' }),
      nativeToScVal(filter.cursor ?? null),
    ];

    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'list_invoices',
      args,
    });

    const data = scValToNative(result.returnValue!) as {
      items: unknown[];
      total: number;
      cursor?: string;
    };

    return {
      items: data.items.map(deserializeInvoice),
      total: data.total,
      cursor: data.cursor,
      hasMore: !!data.cursor,
    };
  }

  /**
   * Mark overdue invoices automatically.
   * Queries all 'pending' invoices past their due date and updates status.
   * Intended for use in a background job or cron.
   *
   * @returns number of invoices marked overdue
   */
  async markOverdue(): Promise<number> {
    const result = await this.client.invokeContract({
      contractId: this.client.vaultContractId,
      method: 'mark_overdue',
      args: [nativeToScVal(Date.now(), { type: 'u64' })],
    });

    return Number(scValToNative(result.returnValue!));
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateCreateInvoiceInput(input: CreateInvoiceInput): void {
  if (!input.issuerAddress?.startsWith('G')) {
    throw new Error(`Invalid issuer Stellar address: ${input.issuerAddress}`);
  }
  if (!input.recipientAddress?.startsWith('G')) {
    throw new Error(`Invalid recipient Stellar address: ${input.recipientAddress}`);
  }
  if (input.issuerAddress === input.recipientAddress) {
    throw new Error('Issuer and recipient cannot be the same address');
  }
  if (input.amount <= 0) {
    throw new Error('Invoice amount must be positive');
  }
  if (!input.currency?.trim()) {
    throw new Error('Invoice currency is required');
  }
  const due = new Date(input.dueDate);
  if (isNaN(due.getTime())) {
    throw new Error(`Invalid dueDate: ${input.dueDate}`);
  }
  if (due <= new Date()) {
    throw new Error('Invoice dueDate must be in the future');
  }
}

// ─── Deserializer ─────────────────────────────────────────────────────────────

function deserializeInvoice(data: unknown): InvoiceRecord {
  const d = data as Record<string, unknown>;
  return {
    id: d.id as string,
    txHash: d.tx_hash as string,
    issuer: d.issuer as string,
    recipient: d.recipient as string,
    amount: Number(d.amount) / 1e7,
    currency: d.currency as string,
    dueDate: new Date(Number(d.due_date)).toISOString(),
    status: d.status as InvoiceStatus,
    description: d.description as string | undefined,
    metadata: d.metadata
      ? (JSON.parse(d.metadata as string) as Record<string, string | number | boolean>)
      : undefined,
    issuedAt: new Date(Number(d.issued_at)).toISOString(),
    paidAt: d.paid_at ? new Date(Number(d.paid_at)).toISOString() : undefined,
    settlementTxHash: d.settlement_tx_hash as string | undefined,
  };
}
