# StellarPay/SDK

**Decentralized payroll & invoicing SDK built on Stellar and Soroban.**

Plug employee payroll, contractor invoicing, and multi-currency disbursements into any app in a few lines of code. No payment logic required.

[![npm](https://img.shields.io/npm/v/@stellarpay/sdk)](https://www.npmjs.com/package/@stellarpay/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stellar Wave Approved](https://img.shields.io/badge/Stellar%20Wave-Approved-brightgreen)](https://drips.network/wave/stellar)

---

## Installation

```bash
npm install @stellarpay/sdk
```

## Quick start

```typescript
import { StellarPay } from '@stellarpay/sdk';

const sdk = new StellarPay({
  network: 'testnet',
  signerKey: process.env.STELLAR_SECRET!,
});

// Schedule monthly payroll
const schedule = await sdk.payroll.schedule({
  recipients: [
    { stellarAddress: 'GABC...', amount: 3000 },
    { stellarAddress: 'GDEF...', amount: 4500, preferredCurrency: 'NGNT' },
  ],
  currency: 'USDC',
  disbursementDay: 1,       // 1st of each month
  autoConvert: true,         // DEX path payments for local currencies
});

// Issue a contractor invoice
const invoice = await sdk.invoice.issue({
  issuerAddress: 'GFREELANCER...',
  recipientAddress: sdk.publicKey,
  amount: 1800,
  currency: 'USDC',
  dueDate: '2025-08-15',
  description: 'Brand design — Q3 2025',
});

// Settle an invoice
await sdk.invoice.settle(invoice.id);

// Swap USDC → NGNT via Stellar DEX
const result = await sdk.currency.swap({ fromAsset: 'USDC', toAsset: 'NGNT', amount: 500 });
```

---

## Modules

### `sdk.payroll`

| Method | Description |
|---|---|
| `schedule(config)` | Create a recurring payroll schedule; funds held in Soroban vault |
| `getStatus(id)` | Get current status of a payroll schedule |
| `disburse(id)` | Manually trigger disbursement (useful for testing) |
| `cancel(id)` | Cancel schedule and refund vault balance to employer |
| `topUp(id, amount, currency)` | Add funds to an existing vault before disbursement |
| `list(filter?)` | List all payroll schedules for the current signer |

### `sdk.invoice`

| Method | Description |
|---|---|
| `issue(input)` | Issue an on-chain invoice; immutably recorded in Soroban |
| `get(id)` | Fetch a single invoice by ID |
| `settle(id)` | Pay an invoice; transfers funds from payer to issuer |
| `cancel(id)` | Cancel a draft/issued invoice (issuer only) |
| `list(filter?)` | List invoices with optional status/address/date filters |
| `markOverdue()` | Update status of all past-due invoices (for background jobs) |

### `sdk.currency`

| Method | Description |
|---|---|
| `findPath(config)` | Discover the best DEX path for a conversion |
| `convert(path, amount)` | Execute a swap using a previously found path |
| `swap(config)` | Find path and execute in one call |
| `getRate(from, to)` | Get spot exchange rate without executing |
| `listSupportedAssets()` | List registered assets for the current network |

---

## Architecture

```
Your App (HR tool / gig marketplace / freelance platform)
    │
    ▼
@stellarpay/sdk  (npm)
    │
    ├── payroll.ts    ──► stellarpay_vault.rs (Soroban)
    ├── invoice.ts    ──► stellarpay_vault.rs (Soroban)
    └── currency.ts   ──► Stellar DEX path payments (Horizon)
                               │
                               ▼
                        Stellar Network
```

The `stellarpay_vault.rs` Soroban contract holds employer funds in escrow and releases them on the scheduled disbursement day. Invoice records are stored immutably in contract storage.

---

## Network support

| Network | Status |
|---|---|
| Testnet | ✅ Active |
| Mainnet | 🚧 Vault contract pending audit |
| Futurenet | ✅ Active |

---

## License

MIT © StellarPay Contributors
