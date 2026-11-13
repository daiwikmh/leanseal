alter table payouts add column if not exists kind text not null default 'intents' check (kind in ('intents', 'direct'));
alter table payouts alter column deposit_address drop not null;
alter table payouts add constraint payouts_kind_deposit check ((kind = 'intents' and deposit_address is not null) or (kind = 'direct' and deposit_address is null));
