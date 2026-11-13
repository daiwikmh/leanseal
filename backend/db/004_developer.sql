create table if not exists payment_links (
  id            text primary key check (id ~ '^[a-z0-9]{10}$'),
  company       text not null,
  title         text not null check (length(title) between 1 and 120),
  description   text not null default '' check (length(description) <= 300),
  amount_units  numeric(30, 0) check (amount_units is null or amount_units > 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists payment_links_company_idx on payment_links (company, created_at desc);

create table if not exists api_keys (
  id            uuid primary key default gen_random_uuid(),
  company       text not null,
  name          text not null check (length(name) between 1 and 80),
  prefix        text not null,
  key_hash      text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists api_keys_company_idx on api_keys (company);

create table if not exists webhook_endpoints (
  id            uuid primary key default gen_random_uuid(),
  company       text not null,
  url           text not null check (url ~ '^https?://'),
  secret_cipher bytea not null,
  secret_iv     bytea not null,
  secret_tag    bytea not null,
  created_at    timestamptz not null default now(),
  disabled_at   timestamptz
);
create index if not exists webhook_endpoints_company_idx on webhook_endpoints (company) where disabled_at is null;

create table if not exists webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  endpoint_id      uuid not null references webhook_endpoints (id) on delete cascade,
  event_id         uuid not null,
  event_type       text not null,
  payload          jsonb not null,
  status           text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts         smallint not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_status_code smallint,
  last_error       text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz,
  unique (endpoint_id, event_id)
);
create index if not exists webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at) where status = 'pending';
