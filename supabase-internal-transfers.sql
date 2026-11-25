-- Internal transfers between simulated real-test accounts.
-- Run after supabase-real-test-account.sql and supabase-real-test-trading.sql.

alter table public.real_test_transactions
  add column if not exists transfer_id uuid,
  add column if not exists counterparty_email text,
  add column if not exists counterparty_identifier text;

alter table public.real_test_transactions
  drop constraint if exists real_test_transactions_transaction_type_check;

alter table public.real_test_transactions
  add constraint real_test_transactions_transaction_type_check
  check (transaction_type in ('deposit', 'withdrawal', 'transfer_sent', 'transfer_received'));

drop function if exists public.real_test_internal_transfer(text, numeric);

create or replace function public.real_test_internal_transfer(
  p_recipient_identifier text,
  p_amount numeric,
  p_confirm_only boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender_id uuid := auth.uid();
  v_sender_identifier text;
  v_recipient_id uuid;
  v_recipient_identifier text;
  v_recipient record;
  v_amount numeric(14, 2);
  v_sender_balance numeric(18, 2);
  v_recipient_balance numeric(18, 2);
  v_transfer_id uuid := gen_random_uuid();
  v_account_count integer;
  v_match_count integer := 0;
  v_phone_key text;
begin
  if v_sender_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_recipient_identifier is null or btrim(p_recipient_identifier) = '' then
    raise exception 'Enter the recipient username or phone number.';
  end if;

  if p_amount is null
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount <= 0
    or p_amount <> round(p_amount, 2) then
    raise exception 'Enter a transfer amount greater than zero with no more than two decimal places.';
  end if;

  select coalesce(
           nullif(btrim(u.raw_user_meta_data ->> 'username'), ''),
           nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
           nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
           nullif(btrim(u.phone), ''),
           nullif(btrim(u.raw_user_meta_data ->> 'phone'), ''),
           nullif(btrim(u.raw_user_meta_data ->> 'phone_number'), '')
         )
    into v_sender_identifier
    from auth.users as u
   where u.id = v_sender_id;

  if v_sender_identifier is null then
    raise exception 'Your account has no username or phone number to identify it.';
  end if;

  v_phone_key := regexp_replace(btrim(p_recipient_identifier), '[^0-9]', '', 'g');
  if left(v_phone_key, 3) = '254' then
    v_phone_key := substring(v_phone_key from 4);
  elsif left(v_phone_key, 1) = '0' then
    v_phone_key := substring(v_phone_key from 2);
  end if;

  for v_recipient in
    select u.id, u.phone, u.raw_user_meta_data
      from auth.users as u
     where u.id <> v_sender_id
       and (
         lower(btrim(coalesce(u.raw_user_meta_data ->> 'username', ''))) = lower(btrim(p_recipient_identifier))
         or lower(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', ''))) = lower(btrim(p_recipient_identifier))
         or lower(btrim(coalesce(u.raw_user_meta_data ->> 'name', ''))) = lower(btrim(p_recipient_identifier))
         or (
           v_phone_key <> ''
           and exists (
             select 1
               from (values
                 (u.phone),
                 (u.raw_user_meta_data ->> 'phone'),
                 (u.raw_user_meta_data ->> 'phone_number')
               ) as phone_values(raw_phone)
               cross join lateral (
                 select regexp_replace(coalesce(phone_values.raw_phone, ''), '[^0-9]', '', 'g') as digits
               ) as phone_digits
               cross join lateral (
                 select case
                   when left(phone_digits.digits, 3) = '254' then substring(phone_digits.digits from 4)
                   when left(phone_digits.digits, 1) = '0' then substring(phone_digits.digits from 2)
                   else phone_digits.digits
                 end as phone_key
               ) as normalized_phone
              where normalized_phone.phone_key = v_phone_key
           )
         )
       )
  loop
    v_match_count := v_match_count + 1;
    if v_match_count > 1 then
      raise exception 'That username matches multiple accounts. Use the recipient phone number instead.';
    end if;

    v_recipient_id := v_recipient.id;
    v_recipient_identifier := coalesce(
      nullif(btrim(v_recipient.raw_user_meta_data ->> 'username'), ''),
      nullif(btrim(v_recipient.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(v_recipient.raw_user_meta_data ->> 'name'), ''),
      nullif(btrim(v_recipient.phone), ''),
      nullif(btrim(v_recipient.raw_user_meta_data ->> 'phone'), ''),
      nullif(btrim(v_recipient.raw_user_meta_data ->> 'phone_number'), ''),
      btrim(p_recipient_identifier)
    );
  end loop;

  if v_recipient_id is null then
    raise exception 'No NexaTrade account matches that username or phone number.';
  end if;

  if v_recipient_id = v_sender_id then
    raise exception 'You cannot transfer funds to your own account.';
  end if;

  select count(*)
    into v_account_count
    from public.real_test_accounts as a
   where a.user_id = v_sender_id;

  if v_account_count <> 1 then
    raise exception 'Your simulated account is unavailable.';
  end if;

  select count(*)
    into v_account_count
    from public.real_test_accounts as a
   where a.user_id = v_recipient_id;

  if v_account_count <> 1 then
    raise exception 'That user has signed up, but their simulated account is not available yet.';
  end if;

  if p_confirm_only then
    return jsonb_build_object(
      'recipient_found', true,
      'recipient_has_account', true
    );
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
    (user_id, transaction_type, amount, balance_after, transfer_id, counterparty_identifier)
  values
    (v_sender_id, 'transfer_sent', v_amount, v_sender_balance, v_transfer_id, v_recipient_identifier),
    (v_recipient_id, 'transfer_received', v_amount, v_recipient_balance, v_transfer_id, v_sender_identifier);

  return jsonb_build_object(
    'transfer_id', v_transfer_id,
    'amount', v_amount,
    'balance', v_sender_balance,
    'recipient_identifier', v_recipient_identifier
  );
end;
$$;

revoke all on function public.real_test_internal_transfer(text, numeric, boolean)
  from public, anon, authenticated;

grant execute on function public.real_test_internal_transfer(text, numeric, boolean)
  to authenticated;

notify pgrst, 'reload schema';
