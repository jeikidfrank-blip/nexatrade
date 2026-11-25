-- Internal transfers between simulated real-test accounts.
-- Run after supabase-real-test-account.sql and supabase-real-test-trading.sql.

alter table public.real_test_transactions
  add column if not exists transfer_id uuid,
  add column if not exists counterparty_email text;

alter table public.real_test_transactions
  drop constraint if exists real_test_transactions_transaction_type_check;

alter table public.real_test_transactions
  add constraint real_test_transactions_transaction_type_check
  check (transaction_type in ('deposit', 'withdrawal', 'transfer_sent', 'transfer_received'));

create or replace function public.real_test_internal_transfer(
  p_recipient_email text,
  p_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender_id uuid := auth.uid();
  v_sender_email text;
  v_recipient_id uuid;
  v_recipient_email text;
  v_amount numeric(14, 2);
  v_sender_balance numeric(18, 2);
  v_recipient_balance numeric(18, 2);
  v_transfer_id uuid := gen_random_uuid();
  v_account_count integer;
begin
  if v_sender_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_recipient_email is null or btrim(p_recipient_email) = '' then
    raise exception 'Enter the recipient account email.';
  end if;

  if p_amount is null
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount <= 0
    or p_amount <> round(p_amount, 2) then
    raise exception 'Enter a transfer amount greater than zero with no more than two decimal places.';
  end if;

  select u.email
    into v_sender_email
    from auth.users as u
   where u.id = v_sender_id;

  if v_sender_email is null then
    raise exception 'Your account email is unavailable.';
  end if;

  select u.id, u.email
    into v_recipient_id, v_recipient_email
    from auth.users as u
   where lower(u.email) = lower(btrim(p_recipient_email))
     and u.id <> v_sender_id
   limit 1;

  if v_recipient_id is null then
    raise exception 'No other registered account matches that email.';
  end if;

  select count(*)
    into v_account_count
    from public.real_test_accounts as a
   where a.user_id in (v_sender_id, v_recipient_id);

  if v_account_count <> 2 then
    raise exception 'A sender or recipient account is unavailable.';
  end if;

  perform a.user_id
    from public.real_test_accounts as a
   where a.user_id in (v_sender_id, v_recipient_id)
   order by a.user_id
   for update;

  v_amount := p_amount;

  update public.real_test_accounts
     set balance = balance - v_amount
   where user_id = v_sender_id
     and balance >= v_amount
   returning balance into v_sender_balance;

  if v_sender_balance is null then
    raise exception 'Insufficient simulated account balance.';
  end if;

  update public.real_test_accounts
     set balance = balance + v_amount
   where user_id = v_recipient_id
   returning balance into v_recipient_balance;

  if v_recipient_balance is null then
    raise exception 'The recipient account is unavailable.';
  end if;

  insert into public.real_test_transactions
    (user_id, transaction_type, amount, balance_after, transfer_id, counterparty_email)
  values
    (v_sender_id, 'transfer_sent', v_amount, v_sender_balance, v_transfer_id, v_recipient_email),
    (v_recipient_id, 'transfer_received', v_amount, v_recipient_balance, v_transfer_id, v_sender_email);

  return jsonb_build_object(
    'transfer_id', v_transfer_id,
    'amount', v_amount,
    'balance', v_sender_balance,
    'recipient_email', v_recipient_email
  );
end;
$$;

revoke all on function public.real_test_internal_transfer(text, numeric)
  from public, anon, authenticated;

grant execute on function public.real_test_internal_transfer(text, numeric)
  to authenticated;

notify pgrst, 'reload schema';
