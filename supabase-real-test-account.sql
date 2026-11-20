-- =========================================
-- NEXATRADE REAL ACCOUNT 
-- with test deposits and withdrawals for testing purposes
-- =========================================

-- 1. Create separate test accounts
create table if not exists public.real_test_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance numeric(14,2) not null default 0.00
    check (balance >= 0),
  created_at timestamptz not null default now()
);

-- 2. Create test transaction history
create table if not exists public.real_test_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_type text not null
    check (transaction_type in ('deposit', 'withdrawal')),
  amount numeric(14,2) not null check (amount > 0),
  balance_after numeric(14,2) not null check (balance_after >= 0),
  created_at timestamptz not null default now()
);

-- 3. Enable Row Level Security
alter table public.real_test_accounts enable row level security;
alter table public.real_test_transactions enable row level security;

-- 4. Users can only read their own records
drop policy if exists "Users read own real test account"
on public.real_test_accounts;

create policy "Users read own real test account"
on public.real_test_accounts
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users read own real test transactions"
on public.real_test_transactions;

create policy "Users read own real test transactions"
on public.real_test_transactions
for select to authenticated
using ((select auth.uid()) = user_id);

-- 5. Restrict direct database access
revoke all on public.real_test_accounts
from public, anon, authenticated;

revoke all on public.real_test_transactions
from public, anon, authenticated;

grant select on public.real_test_accounts
to authenticated;

grant select on public.real_test_transactions
to authenticated;

-- 6. Automatically create test account for new users
create or replace function public.create_real_test_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.real_test_accounts (user_id, balance)
  values (new.id, 0.00)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.create_real_test_account()
from public, anon, authenticated;

drop trigger if exists create_real_test_account_after_signup
on auth.users;

create trigger create_real_test_account_after_signup
after insert on auth.users
for each row
execute function public.create_real_test_account();

-- 7. Create accounts for existing users
insert into public.real_test_accounts (user_id, balance)
select id, 0.00
from auth.users
on conflict (user_id) do nothing;

-- 8. Test deposit function
create or replace function public.real_test_deposit(p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_amount numeric(14,2);
  v_balance numeric(14,2);
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_amount is null
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount < 100
    or p_amount <> round(p_amount, 2) then
    raise exception 'Minimum test deposit is $100.';
  end if;

  v_amount := p_amount;

  update public.real_test_accounts
  set balance = balance + v_amount
  where user_id = v_user_id
  returning balance into v_balance;

  if v_balance is null then
    raise exception 'Test account not found.';
  end if;

  insert into public.real_test_transactions
    (user_id, transaction_type, amount, balance_after)
  values
    (v_user_id, 'deposit', v_amount, v_balance);

  return jsonb_build_object(
    'balance', v_balance,
    'amount', v_amount,
    'mode', 'TEST'
  );
end;
$$;

-- 9. Test withdrawal function
create or replace function public.real_test_withdraw(p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_amount numeric(14,2);
  v_balance numeric(14,2);
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_amount is null
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount <= 0
    or p_amount <> round(p_amount, 2) then
    raise exception 'Enter a valid withdrawal amount.';
  end if;

  v_amount := p_amount;

  update public.real_test_accounts
  set balance = balance - v_amount
  where user_id = v_user_id
    and balance >= v_amount
  returning balance into v_balance;

  if v_balance is null then
    raise exception 'Insufficient test balance.';
  end if;

  insert into public.real_test_transactions
    (user_id, transaction_type, amount, balance_after)
  values
    (v_user_id, 'withdrawal', v_amount, v_balance);

  return jsonb_build_object(
    'balance', v_balance,
    'amount', v_amount,
    'mode', 'TEST'
  );
end;
$$;

-- 10. Secure function permissions
revoke all on function public.real_test_deposit(numeric)
from public, anon, authenticated;

revoke all on function public.real_test_withdraw(numeric)
from public, anon, authenticated;

grant execute on function public.real_test_deposit(numeric)
to authenticated;

grant execute on function public.real_test_withdraw(numeric)
to authenticated;
