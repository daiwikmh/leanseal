create table if not exists applications (
  account_id   text primary key check (account_id ~ '^[a-z0-9-]+\.[a-z0-9.-]+$'),
  intake_hash  text not null check (intake_hash ~ '^sha256:[0-9a-f]{64}$'),
  ciphertext   bytea not null,
  iv           bytea not null check (octet_length(iv) = 12),
  auth_tag     bytea not null check (octet_length(auth_tag) = 16),
  key_version  smallint not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
