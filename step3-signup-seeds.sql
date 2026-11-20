-- STEP 3 — seed KSh prices for NEW signups.
--
-- step2a converted the prices of existing users, but the signup trigger still
-- inserts the original USD values (XAU 4055.30). Any account created after
-- that would trade against a dollar price with a shilling balance, so its
-- position size comes out ~130x too large.
--
-- Safe to re-run. Existing rows are untouched.

create or replace function public.create_demo_account_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.demo_accounts (user_id, balance)
  values (new.id, 10000.00)
  on conflict (user_id) do nothing;

  insert into public.demo_market_prices (user_id, market, price) values
    (new.id, 'XAU', 527189.00000000),
    (new.id, 'EUR', 151.34600000),
    (new.id, 'GBP', 173.81000000)
  on conflict (user_id, market) do nothing;

  return new;
end;
$fn$;

revoke all on function public.create_demo_account_for_new_user() from public, anon, authenticated;

notify pgrst, 'reload schema';
