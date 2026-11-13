create table if not exists chat_links (
  platform      text not null check (platform in ('telegram', 'xmtp')),
  chat_user_id  text not null,
  account_id    text not null,
  linked_at     timestamptz not null default now(),
  primary key (platform, chat_user_id)
);
create index if not exists chat_links_account_idx on chat_links (account_id);

create table if not exists chat_link_codes (
  code          text primary key check (code ~ '^[a-z0-9]{12}$'),
  platform      text not null check (platform in ('telegram', 'xmtp')),
  chat_user_id  text not null,
  expires_at    timestamptz not null,
  used_at       timestamptz
);

create table if not exists chat_outbox (
  id               uuid primary key default gen_random_uuid(),
  platform         text not null check (platform in ('telegram', 'xmtp')),
  chat_user_id     text not null,
  body             text not null check (length(body) between 1 and 4000),
  status           text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts         smallint not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create index if not exists chat_outbox_due_idx on chat_outbox (platform, next_attempt_at) where status = 'pending';
