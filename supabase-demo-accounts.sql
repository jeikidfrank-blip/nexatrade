-- Run this once in the Supabase SQL Editor to enable per-user demo balances.
create table if not exists public.demo_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance numeric(14, 2) not null default 10000.00 check (balance >= 0),
  created_at timestamptz not null default now()
);

alter table public.demo_accounts enable row level security;
grant select, insert, update on public.demo_accounts to authenticated;

drop policy if exists "Users can read their demo account" on public.demo_accounts;
create policy "Users can read their demo account"
  on public.demo_accounts for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their demo account" on public.demo_accounts;
create policy "Users can create their demo account"
  on public.demo_accounts for insert to authenticated
  with check ((select auth.uid()) = user_id and balance = 10000.00);

drop policy if exists "Users can update their demo account" on public.demo_accounts;
create policy "Users can update their demo account"
  on public.demo_accounts for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id and balance >= 0);

create or replace function public.create_demo_account_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.demo_accounts (user_id, balance)
  values (new.id, 10000.00)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.create_demo_account_for_new_user() from public, anon, authenticated;

drop trigger if exists create_demo_account_after_signup on auth.users;
create trigger create_demo_account_after_signup
  after insert on auth.users
  for each row execute function public.create_demo_account_for_new_user();

insert into public.demo_accounts (user_id, balance)
select id, 10000.00 from auth.users
on conflict (user_id) do nothing;
