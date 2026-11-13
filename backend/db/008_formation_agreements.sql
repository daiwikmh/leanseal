create table if not exists formations (
  account_id        text primary key,
  legal_name        text not null check (length(legal_name) between 1 and 200),
  jurisdiction      text check (jurisdiction in ('wy-llc', 'de-ccorp')),
  status            text not null default 'draft' check (status in ('draft', 'filed', 'ein', 'active')),
  application_hash  text check (application_hash ~ '^sha256:[0-9a-f]{64}$'),
  doc_hashes        text[] not null default '{}',
  updated_at        timestamptz not null default now()
);

create table if not exists agreements (
  id             text primary key,
  company        text not null,
  kind           text not null check (kind in ('operating-agreement', 'bylaws', 'service-agreement', 'upload')),
  title          text not null check (length(title) between 1 and 200),
  doc_hash       text not null references documents (doc_hash),
  parties        text[] not null check (cardinality(parties) between 1 and 10),
  status         text not null default 'pending' check (status in ('pending', 'executed', 'voided')),
  invoice_id     text,
  created_at     timestamptz not null default now(),
  executed_at    timestamptz
);
create index if not exists agreements_company_idx on agreements (company, created_at desc);
create index if not exists agreements_parties_idx on agreements using gin (parties);

create table if not exists agreement_signatures (
  agreement_id   text not null references agreements (id),
  account_id     text not null,
  public_key     text not null,
  message        text not null,
  nonce          text not null,
  signature      text not null,
  signed_at      timestamptz not null default now(),
  primary key (agreement_id, account_id)
);
