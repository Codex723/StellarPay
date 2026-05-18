/**
 * StellarPay SDK — Example: HR Payroll Integration
 *
 * Shows how an HR tool would integrate StellarPay to run monthly
 * payroll for a team of employees, some preferring local stablecoins.
 *
 * Run on testnet: ts-node examples/hr-payroll.ts
 */

import { StellarPay } from '../src/index';

async function main() {
  const sdk = new StellarPay({
    network: 'testnet',
    signerKey: process.env.STELLAR_SECRET!,
  });

  console.log('StellarPay SDK initialized');
  console.log('Employer address:', sdk.publicKey);

  // 1. Schedule monthly payroll
  console.log('\n--- Scheduling payroll ---');
  const schedule = await sdk.payroll.schedule({
    recipients: [
      {
        stellarAddress: 'GABC1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        amount: 4000,
        label: 'Alice — Engineering',
      },
      {
        stellarAddress: 'GABC2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        amount: 3500,
        label: 'Bob — Design',
        preferredCurrency: 'NGNT', // Bob prefers Nigerian Naira stablecoin
      },
      {
        stellarAddress: 'GABC3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        amount: 5000,
        label: 'Carol — Product',
      },
    ],
    currency: 'USDC',
    disbursementDay: 1,
    autoConvert: true,
    memo: 'Payroll July 2025',
  });

  console.log('Schedule created:', schedule.id);
  console.log('Next disbursement:', schedule.nextDisbursementAt);
  console.log('Status:', schedule.status);

  // 2. Check status
  const status = await sdk.payroll.getStatus(schedule.id);
  console.log('\n--- Payroll status ---');
  console.log('Status:', status.status);

  // 3. Issue a contractor invoice
  console.log('\n--- Issuing contractor invoice ---');
  const invoice = await sdk.invoice.issue({
    issuerAddress: 'GFREELANCER_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    recipientAddress: sdk.publicKey,
    amount: 1800,
    currency: 'USDC',
    dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
    description: 'Brand identity design — Q3 2025',
    metadata: {
      projectCode: 'BRAND_2025_Q3',
      deliverables: 3,
      revisionRounds: 2,
    },
  });

  console.log('Invoice issued:', invoice.id);
  console.log('Due:', invoice.dueDate);
  console.log('Status:', invoice.status);

  // 4. List pending invoices
  const { items: pending } = await sdk.invoice.list({ status: 'pending' });
  console.log(`\n--- ${pending.length} pending invoices ---`);
  pending.forEach((inv) =>
    console.log(`  ${inv.id}: ${inv.amount} ${inv.currency} due ${inv.dueDate}`)
  );

  // 5. Check USDC → NGNT conversion rate
  console.log('\n--- Currency rates ---');
  const rate = await sdk.currency.getRate('USDC', 'XLM');
  console.log(`USDC → XLM rate: ${rate.toFixed(4)}`);

  console.log('\nDone.');
}

main().catch(console.error);
