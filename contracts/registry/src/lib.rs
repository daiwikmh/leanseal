use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseError, PromiseOrValue};

const MAX_ITEMS: usize = 20;
const MAX_TEXT: usize = 200;
const DECIMALS: u32 = 6;

#[near(serializers = [json, borsh])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum InvoiceStatus {
    Open,
    Pending,
    Paid,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct LineItem {
    pub description: String,
    pub amount: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Company {
    pub account_id: AccountId,
    pub owner: AccountId,
    pub legal_name: String,
    pub country: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Payment {
    pub origin_asset: String,
    pub origin_chain: String,
    pub amount_in: String,
    pub amount_in_usd: String,
    pub origin_tx_url: Option<String>,
    pub refund_reason: Option<String>,
    pub payer: Option<AccountId>,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum InvoiceSource {
    Direct,
    Link,
    Api,
    Chat,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Invoice {
    pub id: String,
    pub company: AccountId,
    pub client_name: String,
    pub amount: U128,
    pub due_ms: u64,
    pub items: Vec<LineItem>,
    pub status: InvoiceStatus,
    pub created_at_ms: u64,
    pub deposit_address: Option<String>,
    pub settle_tx: Option<String>,
    pub paid_at_ms: Option<u64>,
    pub payment: Option<Payment>,
    pub source: InvoiceSource,
    pub reference: Option<String>,
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
pub trait SelfCallbacks {
    fn on_invoice_forwarded(&mut self, id: String, received: U128, excess: U128, previous: InvoiceStatus, previous_deposit: Option<String>) -> U128;
}

pub fn format_usd(units: u128) -> String {
    let base = 10u128.pow(DECIMALS);
    let fraction = format!("{:06}", units % base);
    let trimmed = fraction.trim_end_matches('0');
    if trimmed.is_empty() { format!("{}", units / base) } else { format!("{}.{}", units / base, trimmed) }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    operator: AccountId,
    usdc: AccountId,
    companies: IterableMap<AccountId, Company>,
    invoices: LookupMap<String, Invoice>,
    by_company: LookupMap<AccountId, Vec<String>>,
    pending: IterableSet<String>,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn text(value: &str, field: &str) -> String {
    let trimmed = value.trim();
    require!(!trimmed.is_empty() && trimmed.len() <= MAX_TEXT, format!("{field} must be 1-{MAX_TEXT} characters"));
    trimmed.to_string()
}

pub fn parse_usd(value: &str) -> u128 {
    let (whole, fraction) = value.trim().split_once('.').unwrap_or((value.trim(), ""));
    require!(!whole.is_empty() || !fraction.is_empty(), "amount is empty");
    require!(fraction.len() <= DECIMALS as usize, "amount has too many decimals");
    require!(whole.chars().chain(fraction.chars()).all(|c| c.is_ascii_digit()), "amount must be a number");
    let whole: u128 = if whole.is_empty() { 0 } else { whole.parse().expect("amount too large") };
    let padded = format!("{fraction:0<width$}", width = DECIMALS as usize);
    let fraction: u128 = padded.parse().unwrap_or(0);
    whole.checked_mul(10u128.pow(DECIMALS)).and_then(|w| w.checked_add(fraction)).expect("amount too large")
}

#[near]
impl Registry {
    #[init]
    pub fn new(operator: AccountId, usdc: AccountId) -> Self {
        Self {
            operator,
            usdc,
            companies: IterableMap::new(b"c"),
            invoices: LookupMap::new(b"i"),
            by_company: LookupMap::new(b"b"),
            pending: IterableSet::new(b"p"),
        }
    }

    fn only_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "operator only");
    }

    pub fn register_company(
        &mut self,
        account_id: AccountId,
        legal_name: String,
        country: String,
    ) -> Company {
        self.only_operator();
        require!(self.companies.get(&account_id).is_none(), "company already registered");
        let company = Company {
            owner: account_id.clone(),
            account_id: account_id.clone(),
            legal_name: text(&legal_name, "legal_name"),
            country: text(&country, "country"),
            created_at_ms: now_ms(),
            updated_at_ms: now_ms(),
        };
        self.companies.insert(account_id, company.clone());
        env::log_str(&format!("company registered: {}", company.account_id));
        company
    }

    pub fn create_invoice(&mut self, client_name: String, due_ms: u64, items: Vec<LineItem>) -> Invoice {
        let company = env::predecessor_account_id();
        self.insert_invoice(company, client_name, due_ms, items, InvoiceSource::Direct, None)
    }

    pub fn create_invoice_for(
        &mut self,
        company: AccountId,
        client_name: String,
        due_ms: u64,
        items: Vec<LineItem>,
        source: InvoiceSource,
        reference: Option<String>,
    ) -> Invoice {
        self.only_operator();
        require!(source != InvoiceSource::Direct, "operator invoices come from a link, the API or a chat");
        self.insert_invoice(company, client_name, due_ms, items, source, reference)
    }

    fn insert_invoice(
        &mut self,
        company: AccountId,
        client_name: String,
        due_ms: u64,
        items: Vec<LineItem>,
        source: InvoiceSource,
        reference: Option<String>,
    ) -> Invoice {
        require!(self.companies.get(&company).is_some(), "only a registered company can invoice");
        require!(!items.is_empty() && items.len() <= MAX_ITEMS, "invoice needs 1-20 line items");
        let items: Vec<LineItem> = items
            .into_iter()
            .map(|item| LineItem { description: text(&item.description, "description"), amount: item.amount.trim().to_string() })
            .collect();
        let amount: u128 = items.iter().map(|item| parse_usd(&item.amount)).sum();
        require!(amount > 0, "invoice total must be above zero");
        let reference = reference.map(|r| text(&r, "reference"));
        let ids = self.by_company.entry(company.clone()).or_default();
        let handle = company.as_str().split('.').next().unwrap_or("inv");
        let id = format!("{}-{}", handle, ids.len() + 1);
        ids.push(id.clone());
        let invoice = Invoice {
            id: id.clone(),
            company,
            client_name: text(&client_name, "client_name"),
            amount: U128(amount),
            due_ms,
            items,
            status: InvoiceStatus::Open,
            created_at_ms: now_ms(),
            deposit_address: None,
            settle_tx: None,
            paid_at_ms: None,
            payment: None,
            source,
            reference,
        };
        self.invoices.insert(id.clone(), invoice.clone());
        env::log_str(&format!("invoice created: {id}"));
        invoice
    }

    pub fn attest_invoice(
        &mut self,
        id: String,
        status: InvoiceStatus,
        deposit_address: Option<String>,
        settle_tx: Option<String>,
        payment: Option<Payment>,
    ) -> Invoice {
        self.only_operator();
        let invoice = self.invoices.get_mut(&id).expect("unknown invoice");
        require!(invoice.status != InvoiceStatus::Paid, "invoice already paid");
        invoice.status = status;
        if deposit_address.is_some() {
            invoice.deposit_address = deposit_address;
        }
        if settle_tx.is_some() {
            invoice.settle_tx = settle_tx;
        }
        if payment.is_some() {
            invoice.payment = payment;
        }
        match status {
            InvoiceStatus::Pending => {
                self.pending.insert(id.clone());
            }
            InvoiceStatus::Paid => {
                invoice.paid_at_ms = Some(now_ms());
                self.pending.remove(&id);
            }
            InvoiceStatus::Refunded => {
                self.pending.remove(&id);
            }
            InvoiceStatus::Open => {
                invoice.deposit_address = None;
                self.pending.remove(&id);
            }
        }
        env::log_str(&format!("invoice {id}: {status:?}"));
        invoice.clone()
    }

    pub fn list_pending(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Invoice> {
        self.pending
            .iter()
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|id| self.invoices.get(id).cloned())
            .collect()
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.usdc {
            return PromiseOrValue::Value(amount);
        }
        let id = msg.trim().to_string();
        let Some(invoice) = self.invoices.get_mut(&id) else {
            return PromiseOrValue::Value(amount);
        };
        if !matches!(invoice.status, InvoiceStatus::Open | InvoiceStatus::Pending) || amount.0 < invoice.amount.0 {
            return PromiseOrValue::Value(amount);
        }
        let due = invoice.amount;
        let excess = U128(amount.0 - due.0);
        let previous = invoice.status;
        let previous_deposit = invoice.deposit_address.clone();
        invoice.status = InvoiceStatus::Paid;
        invoice.paid_at_ms = Some(now_ms());
        invoice.payment = Some(Payment {
            origin_asset: "USDC".into(),
            origin_chain: "near".into(),
            amount_in: format_usd(due.0),
            amount_in_usd: format_usd(due.0),
            origin_tx_url: None,
            refund_reason: None,
            payer: Some(sender_id.clone()),
        });
        let company = invoice.company.clone();
        self.pending.remove(&id);
        env::log_str(&format!("invoice {id} paid by {sender_id} from a NEAR wallet"));
        PromiseOrValue::Promise(
            ext_ft::ext(self.usdc.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(Gas::from_tgas(15))
                .ft_transfer(company, due, Some(format!("opencash invoice {id}")))
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(Gas::from_tgas(15))
                        .on_invoice_forwarded(id, amount, excess, previous, previous_deposit),
                ),
        )
    }

    #[private]
    pub fn on_invoice_forwarded(
        &mut self,
        #[callback_result] forwarded: Result<(), PromiseError>,
        id: String,
        received: U128,
        excess: U128,
        previous: InvoiceStatus,
        previous_deposit: Option<String>,
    ) -> U128 {
        self.settle_forward(forwarded.is_ok(), &id, received, excess, previous, previous_deposit)
    }

    fn settle_forward(&mut self, forwarded: bool, id: &str, received: U128, excess: U128, previous: InvoiceStatus, previous_deposit: Option<String>) -> U128 {
        if forwarded {
            return excess;
        }
        if let Some(invoice) = self.invoices.get_mut(id) {
            invoice.status = previous;
            invoice.paid_at_ms = None;
            invoice.payment = None;
            invoice.deposit_address = previous_deposit;
        }
        if previous == InvoiceStatus::Pending {
            self.pending.insert(id.to_string());
        }
        env::log_str(&format!("invoice {id}: forwarding failed, payment returned to the payer"));
        received
    }

    pub fn record_settlement(&mut self, id: String, settle_tx: String) -> Invoice {
        self.only_operator();
        let invoice = self.invoices.get_mut(&id).expect("unknown invoice");
        require!(invoice.status == InvoiceStatus::Paid, "invoice is not paid");
        require!(invoice.settle_tx.is_none(), "settlement already recorded");
        invoice.settle_tx = Some(text(&settle_tx, "settle_tx"));
        invoice.clone()
    }

    pub fn get_usdc(&self) -> AccountId {
        self.usdc.clone()
    }

    pub fn get_operator(&self) -> AccountId {
        self.operator.clone()
    }

    pub fn get_company(&self, account_id: AccountId) -> Option<Company> {
        self.companies.get(&account_id).cloned()
    }

    pub fn get_invoice(&self, id: String) -> Option<Invoice> {
        self.invoices.get(&id).cloned()
    }

    pub fn list_invoices(&self, account_id: AccountId, from: Option<u32>, limit: Option<u32>) -> Vec<Invoice> {
        let Some(ids) = self.by_company.get(&account_id) else { return Vec::new() };
        ids.iter()
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|id| self.invoices.get(id).cloned())
            .collect()
    }

    pub fn company_count(&self) -> u32 {
        self.companies.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const USDC: &str = "usdc.near";

    fn as_caller(id: &str) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(id.parse().unwrap()).block_timestamp(1_700_000_000_000_000_000).build());
    }

    fn registry() -> Registry {
        as_caller("opencash.near");
        let mut r = Registry::new("opencash.near".parse().unwrap(), USDC.parse().unwrap());
        r.register_company("acme.opencash.near".parse().unwrap(), "Acme Studio".into(), "India".into());
        r
    }

    fn item(description: &str, amount: &str) -> LineItem {
        LineItem { description: description.into(), amount: amount.into() }
    }

    fn payment() -> Payment {
        Payment {
            origin_asset: "USDC".into(),
            origin_chain: "arb".into(),
            amount_in: "100.31".into(),
            amount_in_usd: "100.28".into(),
            origin_tx_url: Some("https://arbiscan.io/tx/0xabc".into()),
            refund_reason: None,
            payer: None,
        }
    }

    #[test]
    fn failed_swap_reopens_invoice() {
        let mut r = registry();
        as_caller("acme.opencash.near");
        r.create_invoice("X".into(), 1, vec![item("a", "1")]);
        as_caller("opencash.near");
        r.attest_invoice("acme-1".into(), InvoiceStatus::Pending, Some("0xdep".into()), None, None);
        let reopened = r.attest_invoice("acme-1".into(), InvoiceStatus::Open, None, None, None);
        assert_eq!(reopened.deposit_address, None);
        assert!(r.list_pending(None, None).is_empty());
    }

    #[test]
    fn operator_creates_link_and_api_invoices() {
        let mut r = registry();
        let inv = r.create_invoice_for(
            "acme.opencash.near".parse().unwrap(),
            "Checkout customer".into(),
            1,
            vec![item("Pro plan", "29")],
            InvoiceSource::Api,
            Some("order_8812".into()),
        );
        assert_eq!(inv.source, InvoiceSource::Api);
        assert_eq!(inv.reference.as_deref(), Some("order_8812"));
        assert_eq!(inv.amount, U128(29_000_000));
    }

    #[test]
    #[should_panic(expected = "operator only")]
    fn companies_cannot_create_invoices_for_others() {
        let mut r = registry();
        as_caller("acme.opencash.near");
        r.create_invoice_for("acme.opencash.near".parse().unwrap(), "X".into(), 1, vec![item("a", "1")], InvoiceSource::Link, None);
    }

    fn open_invoice(r: &mut Registry) -> String {
        as_caller("acme.opencash.near");
        r.create_invoice("Northwind".into(), 1, vec![item("Design", "100")]).id
    }

    fn refunded(result: PromiseOrValue<U128>) -> Option<u128> {
        match result {
            PromiseOrValue::Value(v) => Some(v.0),
            PromiseOrValue::Promise(_) => None,
        }
    }

    #[test]
    fn wallet_payment_marks_paid_and_forwards() {
        let mut r = registry();
        let id = open_invoice(&mut r);
        as_caller(USDC);
        let result = r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), id.clone());
        assert_eq!(refunded(result), None, "exact payment is forwarded, not refunded");
        let inv = r.get_invoice(id).unwrap();
        assert_eq!(inv.status, InvoiceStatus::Paid);
        let payment = inv.payment.unwrap();
        assert_eq!(payment.payer.unwrap().as_str(), "payer.near");
        assert_eq!(payment.origin_chain, "near");
        assert_eq!(payment.amount_in, "100");
    }

    #[test]
    fn wallet_payment_refuses_wrong_token_short_amount_unknown_and_paid() {
        let mut r = registry();
        let id = open_invoice(&mut r);
        as_caller("fake-usdc.near");
        assert_eq!(refunded(r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), id.clone())), Some(100_000_000), "other tokens are returned");
        as_caller(USDC);
        assert_eq!(refunded(r.ft_on_transfer("payer.near".parse().unwrap(), U128(99_999_999), id.clone())), Some(99_999_999), "underpayment is returned");
        assert_eq!(refunded(r.ft_on_transfer("payer.near".parse().unwrap(), U128(5), "nope-1".into())), Some(5), "unknown invoice is returned");
        assert_eq!(r.get_invoice(id.clone()).unwrap().status, InvoiceStatus::Open);
        let _ = r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), id.clone());
        assert_eq!(refunded(r.ft_on_transfer("second.near".parse().unwrap(), U128(100_000_000), id)), Some(100_000_000), "a paid invoice can't be paid twice");
    }

    #[test]
    fn overpayment_returns_the_excess_after_forwarding() {
        let mut r = registry();
        let id = open_invoice(&mut r);
        as_caller(USDC);
        let _ = r.ft_on_transfer("payer.near".parse().unwrap(), U128(130_000_000), id.clone());
        let returned = r.settle_forward(true, &id, U128(130_000_000), U128(30_000_000), InvoiceStatus::Open, None);
        assert_eq!(returned.0, 30_000_000);
        assert_eq!(r.get_invoice(id).unwrap().status, InvoiceStatus::Paid);
    }

    #[test]
    fn failed_forward_reverts_invoice_and_refunds_everything() {
        let mut r = registry();
        let id = open_invoice(&mut r);
        as_caller("opencash.near");
        r.attest_invoice(id.clone(), InvoiceStatus::Pending, Some("0xdep".into()), None, None);
        as_caller(USDC);
        let _ = r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), id.clone());
        assert!(r.list_pending(None, None).is_empty());
        let returned = r.settle_forward(false, &id, U128(100_000_000), U128(0), InvoiceStatus::Pending, Some("0xdep".into()));
        assert_eq!(returned.0, 100_000_000, "the whole payment goes back to the payer");
        let inv = r.get_invoice(id).unwrap();
        assert_eq!(inv.status, InvoiceStatus::Pending);
        assert!(inv.payment.is_none() && inv.paid_at_ms.is_none());
        assert_eq!(inv.deposit_address.as_deref(), Some("0xdep"));
        assert_eq!(r.list_pending(None, None).len(), 1, "the Intents payment is still being watched");
    }

    #[test]
    fn settlement_tx_is_recorded_once_by_the_operator() {
        let mut r = registry();
        let id = open_invoice(&mut r);
        as_caller(USDC);
        let _ = r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), id.clone());
        as_caller("opencash.near");
        assert_eq!(r.record_settlement(id.clone(), "TxHash".into()).settle_tx.as_deref(), Some("TxHash"));
    }

    #[test]
    #[should_panic(expected = "settlement already recorded")]
    fn settlement_tx_cannot_be_overwritten() {
        let mut r = registry();
        let id = open_invoice(&mut r);
        as_caller(USDC);
        let _ = r.ft_on_transfer("payer.near".parse().unwrap(), U128(100_000_000), id.clone());
        as_caller("opencash.near");
        r.record_settlement(id.clone(), "TxHash".into());
        r.record_settlement(id, "Other".into());
    }

    #[test]
    fn formats_usd() {
        assert_eq!(format_usd(100_000_000), "100");
        assert_eq!(format_usd(1_250_500_000), "1250.5");
        assert_eq!(format_usd(10_000), "0.01");
    }

    #[test]
    fn parses_usd() {
        assert_eq!(parse_usd("250"), 250_000_000);
        assert_eq!(parse_usd("250.5"), 250_500_000);
        assert_eq!(parse_usd("0.01"), 10_000);
        assert_eq!(parse_usd(".5"), 500_000);
    }

    #[test]
    #[should_panic(expected = "too many decimals")]
    fn rejects_seven_decimals() {
        parse_usd("1.0000001");
    }

    #[test]
    fn company_invoices_and_attests() {
        let mut r = registry();
        as_caller("acme.opencash.near");
        let inv = r.create_invoice("Northwind".into(), 1, vec![item("Design", "100"), item("Hosting", "0.25")]);
        assert_eq!(inv.id, "acme-1");
        assert_eq!(inv.amount, U128(100_250_000));
        let second = r.create_invoice("Globex".into(), 1, vec![item("Audit", "5")]);
        assert_eq!(second.id, "acme-2");

        as_caller("opencash.near");
        r.attest_invoice("acme-1".into(), InvoiceStatus::Pending, Some("0xdep".into()), None, None);
        assert_eq!(r.list_pending(None, None).len(), 1);
        let paid = r.attest_invoice("acme-1".into(), InvoiceStatus::Paid, None, Some("TxHash".into()), Some(payment()));
        assert!(paid.paid_at_ms.is_some());
        assert_eq!(paid.payment.as_ref().unwrap().origin_chain, "arb");
        assert!(r.list_pending(None, None).is_empty());
        assert_eq!(paid.status, InvoiceStatus::Paid);
        assert_eq!(paid.deposit_address.as_deref(), Some("0xdep"));
        assert_eq!(r.list_invoices("acme.opencash.near".parse().unwrap(), None, None).len(), 2);
    }

    #[test]
    #[should_panic(expected = "only a registered company")]
    fn strangers_cannot_invoice() {
        let mut r = registry();
        as_caller("mallory.near");
        r.create_invoice("X".into(), 1, vec![item("a", "1")]);
    }

    #[test]
    #[should_panic(expected = "operator only")]
    fn companies_cannot_mark_paid() {
        let mut r = registry();
        as_caller("acme.opencash.near");
        r.create_invoice("X".into(), 1, vec![item("a", "1")]);
        r.attest_invoice("acme-1".into(), InvoiceStatus::Paid, None, None, None);
    }

    #[test]
    #[should_panic(expected = "already paid")]
    fn paid_is_final() {
        let mut r = registry();
        as_caller("acme.opencash.near");
        r.create_invoice("X".into(), 1, vec![item("a", "1")]);
        as_caller("opencash.near");
        r.attest_invoice("acme-1".into(), InvoiceStatus::Paid, None, None, None);
        r.attest_invoice("acme-1".into(), InvoiceStatus::Refunded, None, None, None);
    }
}
