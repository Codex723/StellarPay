/**
 * @stellarpay/sdk — Test Suite
 *
 * Unit tests for PayrollModule, InvoiceModule, and CurrencyModule.
 * Uses jest with mocked Soroban responses.
 */

import { PayrollModule } from '../src/payroll';
import { InvoiceModule } from '../src/invoice';
import { CurrencyModule } from '../src/currency';
import type { StellarClient } from '../src/client';
import type {
  PayrollConfig,
  CreateInvoiceInput,
  ConversionConfig,
} from '../src/types';

// ─── Mock StellarClient ───────────────────────────────────────────────────────

function makeMockClient(overrides: Partial<StellarClient> = {}): StellarClient {
  return {
    publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    networkPassphrase: 'Test SDF Network ; September 2015',
    vaultContractId: 'CTEST_VAULT_CONTRACT',
    invokeContract: jest.fn().mockResolvedValue({
      txHash: 'mocktxhash123',
      returnValue: {
        toXDR: () => Buffer.from(''),
      },
    }),
    loadAccount: jest.fn(),
    submitTransaction: jest.fn(),
    ...overrides,
  } as unknown as StellarClient;
}

// ─── PayrollModule ────────────────────────────────────────────────────────────

describe('PayrollModule', () => {
  const validConfig: PayrollConfig = {
    recipients: [
      { stellarAddress: 'GABC1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 3000 },
      { stellarAddress: 'GABC2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: 4500, preferredCurrency: 'NGNT' },
    ],
    currency: 'USDC',
    disbursementDay: 1,
    autoConvert: true,
  };

  test('schedule() validates disbursementDay range', async () => {
    const client = makeMockClient();
    const payroll = new PayrollModule(client);

    await expect(
      payroll.schedule({ ...validConfig, disbursementDay: 0 })
    ).rejects.toThrow('disbursementDay must be between 1 and 28');

    await expect(
      payroll.schedule({ ...validConfig, disbursementDay: 29 })
    ).rejects.toThrow('disbursementDay must be between 1 and 28');
  });

  test('schedule() rejects empty recipients', async () => {
    const client = makeMockClient();
    const payroll = new PayrollModule(client);

    await expect(
      payroll.schedule({ ...validConfig, recipients: [] })
    ).rejects.toThrow('at least one recipient');
  });

  test('schedule() rejects more than 100 recipients', async () => {
    const client = makeMockClient();
    const payroll = new PayrollModule(client);
    const manyRecipients = Array.from({ length: 101 }, (_, i) => ({
      stellarAddress: `G${String(i).padStart(55, 'A')}`,
      amount: 100,
    }));

    await expect(
      payroll.schedule({ ...validConfig, recipients: manyRecipients })
    ).rejects.toThrow('cannot exceed 100');
  });

  test('schedule() rejects invalid Stellar addresses', async () => {
    const client = makeMockClient();
    const payroll = new PayrollModule(client);

    await expect(
      payroll.schedule({
        ...validConfig,
        recipients: [{ stellarAddress: 'INVALID_ADDRESS', amount: 100 }],
      })
    ).rejects.toThrow('Invalid Stellar address');
  });

  test('schedule() rejects negative amounts', async () => {
    const client = makeMockClient();
    const payroll = new PayrollModule(client);

    await expect(
      payroll.schedule({
        ...validConfig,
        recipients: [
          { stellarAddress: 'GABC1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', amount: -100 },
        ],
      })
    ).rejects.toThrow('amount must be positive');
  });

  test('schedule() calls invokeContract with create_payroll', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({
      txHash: 'tx_sched_001',
      returnValue: { id: 'payroll_001' },
    });
    const client = makeMockClient({ invokeContract: mockInvoke });
    const payroll = new PayrollModule(client);

    const result = await payroll.schedule(validConfig);

    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'create_payroll' })
    );
    expect(result.status).toBe('scheduled');
    expect(result.nextDisbursementAt).toBeDefined();
  });

  test('cancel() calls invokeContract with cancel_payroll', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ txHash: 'tx_cancel_001' });
    const client = makeMockClient({ invokeContract: mockInvoke });
    const payroll = new PayrollModule(client);

    const result = await payroll.cancel('payroll_001');

    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'cancel_payroll' })
    );
    expect(result.txHash).toBe('tx_cancel_001');
  });

  test('topUp() rejects non-positive amount', async () => {
    const client = makeMockClient();
    const payroll = new PayrollModule(client);

    await expect(payroll.topUp('payroll_001', 0, 'USDC')).rejects.toThrow(
      'Top-up amount must be positive'
    );
    await expect(payroll.topUp('payroll_001', -50, 'USDC')).rejects.toThrow(
      'Top-up amount must be positive'
    );
  });
});

// ─── InvoiceModule ────────────────────────────────────────────────────────────

describe('InvoiceModule', () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString();

  const validInput: CreateInvoiceInput = {
    issuerAddress: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    recipientAddress: 'GRECIPIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    amount: 2500,
    currency: 'USDC',
    dueDate: tomorrow,
    description: 'Frontend development — Sprint 12',
    metadata: { projectId: 'proj_42', hoursLogged: 40 },
  };

  test('issue() rejects same issuer and recipient', async () => {
    const client = makeMockClient();
    const invoice = new InvoiceModule(client);

    await expect(
      invoice.issue({ ...validInput, recipientAddress: validInput.issuerAddress })
    ).rejects.toThrow('cannot be the same address');
  });

  test('issue() rejects non-positive amount', async () => {
    const client = makeMockClient();
    const mod = new InvoiceModule(client);

    await expect(invoice.issue({ ...validInput, amount: 0 })).rejects.toThrow(
      'amount must be positive'
    );
  });

  test('issue() rejects past due dates', async () => {
    const client = makeMockClient();
    const mod = new InvoiceModule(client);
    const yesterday = new Date(Date.now() - 86400000).toISOString();

    await expect(
      mod.issue({ ...validInput, dueDate: yesterday })
    ).rejects.toThrow('must be in the future');
  });

  test('issue() calls invokeContract with issue_invoice', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({
      txHash: 'tx_inv_001',
      returnValue: {
        id: 'INV_001',
        tx_hash: 'tx_inv_001',
        issuer: validInput.issuerAddress,
        recipient: validInput.recipientAddress,
        amount: 25000000000n,
        currency: 'USDC',
        due_date: BigInt(new Date(tomorrow).getTime()),
        status: 'Issued',
        description: validInput.description,
        metadata: JSON.stringify(validInput.metadata),
        issued_at: BigInt(Date.now()),
        paid_at: null,
        settlement_tx_hash: null,
      },
    });

    const client = makeMockClient({ invokeContract: mockInvoke });
    const mod = new InvoiceModule(client);
    const result = await mod.issue(validInput);

    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'issue_invoice' })
    );
    expect(result.status).toBe('Issued');
  });
});

// ─── CurrencyModule ───────────────────────────────────────────────────────────

describe('CurrencyModule', () => {
  const validConfig: ConversionConfig = {
    fromAsset: 'USDC',
    toAsset: 'XLM',
    amount: 100,
    slippageTolerance: 0.01,
  };

  test('findPath() rejects same fromAsset and toAsset', async () => {
    const client = makeMockClient();
    const currency = new CurrencyModule(client);

    await expect(
      currency.findPath({ ...validConfig, toAsset: 'USDC' })
    ).rejects.toThrow('must be different');
  });

  test('findPath() rejects non-positive amount', async () => {
    const client = makeMockClient();
    const currency = new CurrencyModule(client);

    await expect(
      currency.findPath({ ...validConfig, amount: 0 })
    ).rejects.toThrow('amount must be positive');
  });

  test('findPath() rejects slippage above 50%', async () => {
    const client = makeMockClient();
    const currency = new CurrencyModule(client);

    await expect(
      currency.findPath({ ...validConfig, slippageTolerance: 0.6 })
    ).rejects.toThrow('slippageTolerance must be between 0 and 0.5');
  });

  test('listSupportedAssets() always includes XLM', () => {
    const client = makeMockClient();
    const currency = new CurrencyModule(client);

    const assets = currency.listSupportedAssets();
    expect(assets).toContain('XLM');
  });

  test('listSupportedAssets() returns testnet assets for testnet client', () => {
    const client = makeMockClient({
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    const currency = new CurrencyModule(client);
    const assets = currency.listSupportedAssets();
    expect(assets).toContain('USDC');
  });
});
