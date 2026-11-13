alter table agent_payments add column if not exists operation jsonb;
alter table agent_payments add column if not exists receipt jsonb;
alter table agent_payments drop constraint if exists agent_payments_status_check;
alter table agent_payments add constraint agent_payments_status_check check (status in ('reserved', 'sent', 'failed', 'refunded'));

create table if not exists x402_settlements (
  id            uuid primary key default gen_random_uuid(),
  company       text not null,
  payer         text not null,
  amount_units  numeric(30, 0) not null check (amount_units > 0),
  transaction   text not null unique,
  resource      text,
  created_at    timestamptz not null default now()
);
create index if not exists x402_settlements_company_idx on x402_settlements (company, created_at desc);
