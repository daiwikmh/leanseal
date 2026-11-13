create table if not exists agents (
  id                uuid primary key default gen_random_uuid(),
  company           text not null,
  name              text not null check (length(name) between 1 and 60),
  account_id        text not null unique,
  public_key        text not null,
  key_cipher        bytea not null,
  key_iv            bytea not null check (octet_length(key_iv) = 12),
  key_tag           bytea not null check (octet_length(key_tag) = 16),
  api_key_hash      text unique check (api_key_hash ~ '^[0-9a-f]{64}$'),
  api_key_prefix    text,
  per_tx_cap_units  numeric(30, 0) not null check (per_tx_cap_units > 0),
  daily_cap_units   numeric(30, 0) not null check (daily_cap_units >= per_tx_cap_units),
  allowlist         text[] not null default '{}',
  status            text not null default 'creating' check (status in ('creating', 'active', 'frozen')),
  created_at        timestamptz not null default now(),
  unique (company, name)
);
create index if not exists agents_company_idx on agents (company);

create table if not exists agent_payments (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references agents (id),
  kind          text not null check (kind in ('transfer', 'x402', 'sweep')),
  recipient     text not null,
  amount_units  numeric(30, 0) not null check (amount_units > 0),
  resource      text,
  status        text not null default 'reserved' check (status in ('reserved', 'sent', 'failed')),
  tx_hash       text,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists agent_payments_agent_idx on agent_payments (agent_id, created_at desc);
