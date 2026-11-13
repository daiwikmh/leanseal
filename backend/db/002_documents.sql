create table if not exists documents (
  doc_hash     text primary key check (doc_hash ~ '^sha256:[0-9a-f]{64}$'),
  company      text not null,
  title        text not null check (length(title) between 1 and 200),
  mime         text not null check (mime in ('text/plain', 'application/pdf')),
  ciphertext   bytea not null,
  iv           bytea not null check (octet_length(iv) = 12),
  auth_tag     bytea not null check (octet_length(auth_tag) = 16),
  key_version  smallint not null default 1,
  created_at   timestamptz not null default now()
);
create index if not exists documents_company_idx on documents (company);
