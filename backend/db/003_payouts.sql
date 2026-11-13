create table if not exists payees (
  id           uuid primary key default gen_random_uuid(),
  company      text not null,
  name         text not null check (length(name) between 1 and 120),
  asset_id     text not null,
  recipient    text not null check (length(recipient) between 1 and 128),
  created_at   timestamptz not null default now(),
  unique (company, name)
);

create table if not exists payout_batches (
  id           uuid primary key default gen_random_uuid(),
  company      text not null,
  label        text not null check (length(label) between 1 and 120),
  created_at   timestamptz not null default now()
);
create index if not exists payout_batches_company_idx on payout_batches (company, created_at desc);

create table if not exists payouts (
  id                 uuid primary key default gen_random_uuid(),
  company            text not null,
  batch_id           uuid references payout_batches (id),
  payee_name         text not null check (length(payee_name) between 1 and 120),
  asset_id           text not null,
  symbol             text not null,
  chain              text not null,
  recipient          text not null,
  amount_units       numeric(30, 0) not null check (amount_units > 0),
  amount_out         text not null,
  deposit_address    text not null unique,
  deadline           timestamptz not null,
  status             text not null default 'quoted' check (status in ('quoted', 'sent', 'completed', 'refunded', 'failed', 'expired')),
  transfer_tx        text,
  delivery_tx_url    text,
  refund_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists payouts_company_idx on payouts (company, created_at desc);
create index if not exists payouts_open_idx on payouts (status) where status in ('quoted', 'sent');
