# Supabase backend setup

NexaTrade uses Supabase for authentication, account balances, transaction history, and server-side simulated trade execution. The browser only uses the project's URL and publishable key from `supabase-config.js`; never put a Supabase service-role key in the site.

## Set up the database

In the Supabase project configured in `supabase-config.js`, open **SQL Editor** and run these files in order:

1. `supabase-demo-accounts.sql`
2. `supabase-real-test-account.sql`
3. `supabase-real-test-trading.sql`

The scripts create the tables, row-level security policies, signup triggers, and RPC functions used by `app.js`. They are intended to be rerunnable. The final script updates prices and relevant account functions to use KSh.

## Configure authentication

In Supabase, open **Authentication > URL Configuration** and set the site's deployed URL and any local development URL as allowed redirect URLs. Configure email-confirmation behavior under **Authentication > Providers > Email**.

## Verify the backend

1. Open the site and create a test user.
2. Confirm signup and sign in.
3. Check that the Demo and Test Funds tabs load balances.
4. Try a simulated deposit/withdrawal and a demo trade.
5. In Supabase **Table Editor**, verify that only that user's account, transaction, and position records were created.

The Test Funds account is simulated: this setup does not connect a payment provider or execute live trades. Do not use it to accept real deposits.
