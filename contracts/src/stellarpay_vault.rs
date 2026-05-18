//! StellarPay Vault — Soroban Escrow Contract
//!
//! Holds employer funds in escrow and releases them to employees/contractors
//! on the scheduled disbursement day. Handles both payroll schedules and
//! invoice settlement.
//!
//! # Architecture
//! - Employers deposit tokens into the vault.
//! - The vault records payroll schedules and invoice records in contract storage.
//! - On `disburse()`, the vault fans out payments to each recipient.
//! - On `settle_invoice()`, the vault pays the issuer directly.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token, vec, Address, Bytes, Env, Map, String, Vec,
};

// ─── Storage Keys ─────────────────────────────────────────────────────────────

const PAYROLLS: &str = "payrolls";
const INVOICES: &str = "invoices";
const BALANCES: &str = "balances";
const ADMIN: &str = "admin";

// ─── Data Types ───────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct PayrollRecipient {
    pub address: Address,
    /// Amount in stroops (1 XLM = 10_000_000 stroops)
    pub amount: i128,
    /// Optional preferred currency asset address for auto-conversion
    pub preferred_currency: Option<Address>,
    pub label: Option<String>,
}

#[contracttype]
#[derive(Clone)]
pub enum PayrollStatus {
    Scheduled,
    Processing,
    Completed,
    Failed,
    Cancelled,
}

#[contracttype]
#[derive(Clone)]
pub struct PayrollSchedule {
    pub id: Bytes,
    pub employer: Address,
    pub recipients: Vec<PayrollRecipient>,
    pub currency: Address,        // Token contract address
    pub disbursement_day: u32,    // 1–28
    pub auto_convert: bool,
    pub memo: Option<String>,
    pub status: PayrollStatus,
    pub next_disbursement_at: u64, // Unix timestamp ms
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum InvoiceStatus {
    Draft,
    Issued,
    Pending,
    Paid,
    Overdue,
    Cancelled,
}

#[contracttype]
#[derive(Clone)]
pub struct InvoiceRecord {
    pub id: Bytes,
    pub tx_hash: Bytes,
    pub issuer: Address,
    pub recipient: Address,
    pub amount: i128,             // stroops
    pub currency: Address,        // Token contract address
    pub due_date: u64,            // Unix timestamp ms
    pub status: InvoiceStatus,
    pub description: Option<String>,
    pub metadata: Option<String>, // JSON string
    pub issued_at: u64,
    pub paid_at: Option<u64>,
    pub settlement_tx_hash: Option<Bytes>,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct StellarPayVault;

#[contractimpl]
impl StellarPayVault {

    // ── Admin ──────────────────────────────────────────────────────────────────

    /// Initialize the vault with an admin address.
    /// Must be called once after deployment.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&symbol_short!("admin")) {
            panic!("already initialized");
        }
        env.storage().instance().set(&symbol_short!("admin"), &admin);
    }

    // ── Payroll ────────────────────────────────────────────────────────────────

    /// Create a recurring payroll schedule.
    ///
    /// Caller (employer) must have previously approved the vault to spend
    /// the total payroll amount from their token balance.
    pub fn create_payroll(
        env: Env,
        recipients: Vec<PayrollRecipient>,
        currency: Address,
        disbursement_day: u32,
        auto_convert: bool,
        memo: Option<String>,
    ) -> PayrollSchedule {
        let employer = env.current_contract_address();
        employer.require_auth();

        // Validate inputs
        assert!(
            !recipients.is_empty() && recipients.len() <= 100,
            "recipients must be 1–100"
        );
        assert!(
            disbursement_day >= 1 && disbursement_day <= 28,
            "disbursement_day must be 1–28"
        );

        // Calculate total and transfer to vault
        let total: i128 = recipients.iter().map(|r| r.amount).sum();
        assert!(total > 0, "total payroll amount must be positive");

        let token = token::Client::new(&env, &currency);
        token.transfer(&employer, &env.current_contract_address(), &total);

        // Generate payroll ID
        let id = env.crypto().sha256(
            &Bytes::from_slice(
                &env,
                &[employer.to_string().as_bytes(), &env.ledger().timestamp().to_be_bytes()].concat(),
            )
        );

        let now = env.ledger().timestamp() * 1000u64; // ms
        let next_disbursement = next_disbursement_ts(&env, disbursement_day);

        let schedule = PayrollSchedule {
            id: id.into(),
            employer: employer.clone(),
            recipients,
            currency,
            disbursement_day,
            auto_convert,
            memo,
            status: PayrollStatus::Scheduled,
            next_disbursement_at: next_disbursement,
            created_at: now,
        };

        // Persist
        let mut payrolls: Map<Bytes, PayrollSchedule> = env
            .storage()
            .persistent()
            .get(&symbol_short!("payrolls"))
            .unwrap_or(Map::new(&env));
        payrolls.set(schedule.id.clone(), schedule.clone());
        env.storage().persistent().set(&symbol_short!("payrolls"), &payrolls);

        schedule
    }

    /// Retrieve a payroll schedule by ID.
    pub fn get_payroll(env: Env, id: Bytes) -> PayrollSchedule {
        let payrolls: Map<Bytes, PayrollSchedule> = env
            .storage()
            .persistent()
            .get(&symbol_short!("payrolls"))
            .expect("no payrolls found");
        payrolls.get(id).expect("payroll not found")
    }

    /// Execute disbursement for a payroll schedule.
    ///
    /// Can be called by anyone once the disbursement day has passed —
    /// the contract verifies the timestamp. In production, a keeper
    /// bot calls this automatically.
    pub fn disburse(env: Env, payroll_id: Bytes) -> Vec<bool> {
        let mut payrolls: Map<Bytes, PayrollSchedule> = env
            .storage()
            .persistent()
            .get(&symbol_short!("payrolls"))
            .expect("no payrolls");

        let mut schedule = payrolls.get(payroll_id.clone()).expect("payroll not found");

        // Verify disbursement day has arrived
        let now_ms = env.ledger().timestamp() * 1000u64;
        assert!(
            now_ms >= schedule.next_disbursement_at,
            "disbursement day has not arrived yet"
        );

        schedule.status = PayrollStatus::Processing;

        let token = token::Client::new(&env, &schedule.currency);
        let mut outcomes: Vec<bool> = Vec::new(&env);

        for recipient in schedule.recipients.iter() {
            // In a real deployment, failure of one recipient would be
            // caught and logged; here we transfer and record true/false.
            token.transfer(
                &env.current_contract_address(),
                &recipient.address,
                &recipient.amount,
            );
            outcomes.push_back(true);
        }

        // Advance to next disbursement
        schedule.status = PayrollStatus::Completed;
        schedule.next_disbursement_at = next_month_ts(schedule.next_disbursement_at);

        payrolls.set(payroll_id, schedule);
        env.storage().persistent().set(&symbol_short!("payrolls"), &payrolls);

        outcomes
    }

    /// Cancel a payroll and refund remaining vault balance to employer.
    pub fn cancel_payroll(env: Env, payroll_id: Bytes) {
        let mut payrolls: Map<Bytes, PayrollSchedule> = env
            .storage()
            .persistent()
            .get(&symbol_short!("payrolls"))
            .expect("no payrolls");

        let mut schedule = payrolls.get(payroll_id.clone()).expect("payroll not found");
        schedule.employer.require_auth();

        // Refund total balance
        let total: i128 = schedule.recipients.iter().map(|r| r.amount).sum();
        let token = token::Client::new(&env, &schedule.currency);
        token.transfer(&env.current_contract_address(), &schedule.employer, &total);

        schedule.status = PayrollStatus::Cancelled;
        payrolls.set(payroll_id, schedule);
        env.storage().persistent().set(&symbol_short!("payrolls"), &payrolls);
    }

    // ── Invoice ────────────────────────────────────────────────────────────────

    /// Issue a new on-chain invoice.
    pub fn issue_invoice(
        env: Env,
        issuer: Address,
        recipient: Address,
        amount: i128,
        currency: Address,
        due_date: u64,
        description: Option<String>,
        metadata: Option<String>,
    ) -> InvoiceRecord {
        issuer.require_auth();
        assert!(amount > 0, "invoice amount must be positive");
        assert!(due_date > env.ledger().timestamp() * 1000, "due date must be in the future");

        let now = env.ledger().timestamp() * 1000u64;
        let id_bytes = env.crypto().sha256(
            &Bytes::from_slice(
                &env,
                &[
                    issuer.to_string().as_bytes(),
                    recipient.to_string().as_bytes(),
                    &amount.to_be_bytes(),
                    &now.to_be_bytes(),
                ]
                .concat(),
            )
        );

        let invoice = InvoiceRecord {
            id: id_bytes.into(),
            tx_hash: Bytes::new(&env), // Set by SDK from tx hash post-submission
            issuer,
            recipient,
            amount,
            currency,
            due_date,
            status: InvoiceStatus::Issued,
            description,
            metadata,
            issued_at: now,
            paid_at: None,
            settlement_tx_hash: None,
        };

        let mut invoices: Map<Bytes, InvoiceRecord> = env
            .storage()
            .persistent()
            .get(&symbol_short!("invoices"))
            .unwrap_or(Map::new(&env));
        invoices.set(invoice.id.clone(), invoice.clone());
        env.storage().persistent().set(&symbol_short!("invoices"), &invoices);

        invoice
    }

    /// Retrieve an invoice by ID.
    pub fn get_invoice(env: Env, id: Bytes) -> InvoiceRecord {
        let invoices: Map<Bytes, InvoiceRecord> = env
            .storage()
            .persistent()
            .get(&symbol_short!("invoices"))
            .expect("no invoices");
        invoices.get(id).expect("invoice not found")
    }

    /// Settle (pay) an invoice. The recipient (payer) calls this.
    ///
    /// Transfers the invoice amount from payer to issuer and marks
    /// the invoice as paid on-chain.
    pub fn settle_invoice(env: Env, invoice_id: Bytes) -> InvoiceRecord {
        let mut invoices: Map<Bytes, InvoiceRecord> = env
            .storage()
            .persistent()
            .get(&symbol_short!("invoices"))
            .expect("no invoices");

        let mut invoice = invoices.get(invoice_id.clone()).expect("invoice not found");
        invoice.recipient.require_auth();

        assert!(
            matches!(invoice.status, InvoiceStatus::Issued | InvoiceStatus::Pending | InvoiceStatus::Overdue),
            "invoice cannot be settled in its current status"
        );

        // Transfer payment from payer to issuer
        let token = token::Client::new(&env, &invoice.currency);
        token.transfer(&invoice.recipient, &invoice.issuer, &invoice.amount);

        let now = env.ledger().timestamp() * 1000u64;
        invoice.status = InvoiceStatus::Paid;
        invoice.paid_at = Some(now);

        invoices.set(invoice_id, invoice.clone());
        env.storage().persistent().set(&symbol_short!("invoices"), &invoices);

        invoice
    }

    /// Cancel an invoice. Only the issuer may cancel.
    pub fn cancel_invoice(env: Env, invoice_id: Bytes) -> InvoiceRecord {
        let mut invoices: Map<Bytes, InvoiceRecord> = env
            .storage()
            .persistent()
            .get(&symbol_short!("invoices"))
            .expect("no invoices");

        let mut invoice = invoices.get(invoice_id.clone()).expect("invoice not found");
        invoice.issuer.require_auth();

        assert!(
            matches!(invoice.status, InvoiceStatus::Draft | InvoiceStatus::Issued),
            "only draft or issued invoices can be cancelled"
        );

        invoice.status = InvoiceStatus::Cancelled;
        invoices.set(invoice_id, invoice.clone());
        env.storage().persistent().set(&symbol_short!("invoices"), &invoices);

        invoice
    }

    /// Mark all pending invoices past their due date as overdue.
    /// Returns the count of invoices updated.
    pub fn mark_overdue(env: Env, now_ms: u64) -> u32 {
        let mut invoices: Map<Bytes, InvoiceRecord> = env
            .storage()
            .persistent()
            .get(&symbol_short!("invoices"))
            .unwrap_or(Map::new(&env));

        let mut count = 0u32;
        let keys: Vec<Bytes> = invoices.keys();

        for key in keys.iter() {
            let mut inv = invoices.get(key.clone()).unwrap();
            if matches!(inv.status, InvoiceStatus::Issued | InvoiceStatus::Pending)
                && inv.due_date < now_ms
            {
                inv.status = InvoiceStatus::Overdue;
                invoices.set(key, inv);
                count += 1;
            }
        }

        env.storage().persistent().set(&symbol_short!("invoices"), &invoices);
        count
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Calculate the Unix timestamp (ms) of the next occurrence of `day` in the month.
fn next_disbursement_ts(env: &Env, day: u32) -> u64 {
    // Simplified: advance by ~30 days if the day has passed this month.
    // Production: use a proper date library or store year/month explicitly.
    let now_secs = env.ledger().timestamp();
    let now_ms = now_secs * 1000;
    let day_ms = (day as u64) * 24 * 60 * 60 * 1000;
    let month_ms = 30u64 * 24 * 60 * 60 * 1000;

    // Rough heuristic: if we're past the disbursement day this month, go to next month
    let this_month_ts = (now_ms / month_ms) * month_ms + day_ms;
    if this_month_ts > now_ms {
        this_month_ts
    } else {
        this_month_ts + month_ms
    }
}

/// Advance a disbursement timestamp by approximately one month.
fn next_month_ts(current_ts: u64) -> u64 {
    const MONTH_MS: u64 = 30 * 24 * 60 * 60 * 1000;
    current_ts + MONTH_MS
}
