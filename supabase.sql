-- =====================================================================
--  «Царь Горы» — база данных для Supabase
--  Вставь ВЕСЬ этот файл в Supabase → SQL Editor → New query → Run.
--  Скрипт можно запускать повторно: он ничего не сломает.
-- =====================================================================

-- ---------- Таблица документов: всё содержимое сайта ----------
create table if not exists public.docs (
  path       text primary key,                 -- например fighters/<id игрока>
  col        text not null,                    -- коллекция: fighters, players, chats/<id>/msgs …
  doc_id     text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint docs_size check (pg_column_size(data) < 300000)
);
create index if not exists docs_col_idx on public.docs (col);

-- ---------- Администраторы (ГМ) ----------
create table if not exists public.admins (
  user_id uuid primary key
);
alter table public.admins enable row level security;
-- никаких политик: таблицу читают только функции ниже

-- ---------- Функции проверки ролей ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.docs d,
      jsonb_array_elements_text(coalesce(d.data->'reviewers','[]'::jsonb)) r
    where d.path = 'config/main' and r = auth.uid()::text
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_staff() to anon, authenticated;

-- ---------- Правила доступа (Row Level Security) ----------
alter table public.docs enable row level security;

drop policy if exists docs_read   on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

-- Чтение: бойцы, игроки, награды, настройки и статусы проверки видны всем;
-- чат проверки — только самому игроку, анкетологам и ГМу.
create policy docs_read on public.docs for select using (
  split_part(path,'/',1) in ('fighters','players','awards','config','reviews')
  or (split_part(path,'/',1) = 'chats'
      and (public.is_staff() or split_part(path,'/',2) = auth.uid()::text))
);

-- Запись
create policy docs_insert on public.docs for insert to authenticated with check (
  public.is_admin()
  or (col in ('fighters','players') and doc_id = auth.uid()::text)
  or (col = 'reviews' and (public.is_staff() or doc_id = auth.uid()::text))
  or (split_part(path,'/',1) = 'chats' and split_part(path,'/',3) = 'msgs'
      and (public.is_staff() or split_part(path,'/',2) = auth.uid()::text)
      and data->>'by' = auth.uid()::text)
);

create policy docs_update on public.docs for update to authenticated using (
  public.is_admin()
  or (col in ('fighters','players') and doc_id = auth.uid()::text)
  or (col = 'reviews' and (public.is_staff() or doc_id = auth.uid()::text))
) with check (
  public.is_admin()
  or (col in ('fighters','players') and doc_id = auth.uid()::text)
  or (col = 'reviews' and (public.is_staff() or doc_id = auth.uid()::text))
);

create policy docs_delete on public.docs for delete to authenticated using (
  public.is_admin()
);

-- ---------- Защита от подделки ----------
-- 1) игрок не может сам себе одобрить анкету;
-- 2) анкетолог не может одобрить свою собственную анкету;
-- 3) в чате игрок не может подписаться ролью «анкетолог» или «ГМ».
create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  old_s text; old_c text;
begin
  new.updated_at := now();
  new.col := regexp_replace(new.path, '/[^/]+$', '');
  new.doc_id := regexp_replace(new.path, '^.*/', '');

  if public.is_admin() then return new; end if;

  if new.col = 'reviews' then
    if tg_op = 'UPDATE' then
      old_s := old.data->>'status'; old_c := old.data->>'cyStatus';
    end if;
    if not public.is_staff() or new.doc_id = auth.uid()::text then
      if (new.data->>'status' = 'approved' and coalesce(old_s,'') <> 'approved')
         or (new.data->>'cyStatus' = 'approved' and coalesce(old_c,'') <> 'approved') then
        raise exception 'only reviewers can approve' using errcode = '42501';
      end if;
    end if;
  end if;

  if split_part(new.path,'/',1) = 'chats' and not public.is_staff() then
    if coalesce(new.data->>'role','') not in ('player','system') then
      new.data := jsonb_set(new.data, '{role}', '"player"');
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update on public.docs
  for each row execute function public.docs_guard();

grant select on public.docs to anon, authenticated;
grant insert, update, delete on public.docs to authenticated;

-- ---------- Живые обновления (чат, анкеты) ----------
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when others then null; end $$;

-- ---------- Хранилище артов ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('art', 'art', true, 20971520,
        array['image/png','image/jpeg','image/gif','image/webp','image/svg+xml','video/mp4','video/webm'])
on conflict (id) do update set public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists art_read   on storage.objects;
drop policy if exists art_insert on storage.objects;
drop policy if exists art_delete on storage.objects;

create policy art_read on storage.objects for select using (bucket_id = 'art');
create policy art_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'art');
create policy art_delete on storage.objects for delete to authenticated
  using (bucket_id = 'art' and (owner_id = auth.uid()::text or public.is_admin()));

-- =====================================================================
--  ГОТОВО. Когда зарегистрируешься на сайте, сделай себя ГМом:
--  открой новый запрос и выполни одну строку, подставив свою почту:
--
--  insert into public.admins (user_id)
--  select id from auth.users where email = 'ТВОЯ_ПОЧТА@example.com'
--  on conflict do nothing;
-- =====================================================================
