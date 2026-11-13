alter table chat_link_codes add column if not exists label text not null default '' check (length(label) <= 120);
alter table chat_links add column if not exists label text not null default '' check (length(label) <= 120);
