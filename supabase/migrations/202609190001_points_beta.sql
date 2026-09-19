begin;

create extension if not exists pgcrypto;

create table if not exists public.fp_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  wallet_address text not null,
  username text not null unique,
  points bigint not null default 1000 check (points >= 0),
  last_claim_day date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fp_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  delta bigint not null,
  reason text not null check (reason in ('signup', 'daily', 'stake', 'refund', 'payout')),
  ref text,
  created_at timestamptz not null default now()
);
create unique index if not exists fp_ledger_once on public.fp_ledger(user_id, reason, ref) where ref is not null;
create index if not exists fp_ledger_user_created on public.fp_ledger(user_id, created_at desc);

create table if not exists public.fp_markets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  symbol text not null,
  name text not null,
  exchange text not null,
  closes_at timestamptz not null,
  settles_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'void')),
  result_bucket text not null check (result_bucket in ('crash', 'down', 'flat', 'up', 'moon')),
  created_at timestamptz not null default now(),
  check (settles_at > closes_at)
);
create index if not exists fp_markets_status_close on public.fp_markets(status, closes_at);

create table if not exists public.fp_predictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  market_id uuid not null references public.fp_markets(id) on delete cascade,
  bucket text not null check (bucket in ('crash', 'down', 'flat', 'up', 'moon')),
  stake integer not null check (stake >= 10 and stake <= 1000),
  request_id uuid not null,
  payout bigint,
  placed_at timestamptz not null default now(),
  unique (user_id, request_id)
);
create index if not exists fp_predictions_user_created on public.fp_predictions(user_id, placed_at desc);
create index if not exists fp_predictions_market on public.fp_predictions(market_id, placed_at);

alter table public.fp_profiles enable row level security;
alter table public.fp_ledger enable row level security;
alter table public.fp_markets enable row level security;
alter table public.fp_predictions enable row level security;

revoke all on public.fp_profiles, public.fp_ledger, public.fp_markets, public.fp_predictions from anon, authenticated;
grant select on public.fp_profiles, public.fp_ledger, public.fp_markets, public.fp_predictions to authenticated;

drop policy if exists "profile owner reads" on public.fp_profiles;
create policy "profile owner reads" on public.fp_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "ledger owner reads" on public.fp_ledger;
create policy "ledger owner reads" on public.fp_ledger for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "authenticated reads markets" on public.fp_markets;
create policy "authenticated reads markets" on public.fp_markets for select to authenticated using (true);

drop policy if exists "prediction owner reads" on public.fp_predictions;
create policy "prediction owner reads" on public.fp_predictions for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.fp_bootstrap_profile(p_wallet text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_username text;
  v_profile public.fp_profiles%rowtype;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_wallet is null or p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    raise exception 'Invalid Solana wallet address';
  end if;

  v_username := 'sol_' || left(p_wallet, 6) || '_' || left(replace(v_uid::text, '-', ''), 4);
  insert into public.fp_profiles(user_id, wallet_address, username)
  values (v_uid, p_wallet, lower(v_username))
  on conflict (user_id) do nothing;

  insert into public.fp_ledger(user_id, delta, reason, ref)
  values (v_uid, 1000, 'signup', 'initial')
  on conflict do nothing;

  select * into v_profile from public.fp_profiles where user_id = v_uid;
  return jsonb_build_object(
    'userId', v_profile.user_id,
    'walletAddress', v_profile.wallet_address,
    'username', v_profile.username,
    'points', v_profile.points,
    'canClaimDaily', v_profile.last_claim_day is distinct from (now() at time zone 'utc')::date
  );
end;
$$;

create or replace function public.fp_refresh_practice_markets()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slot timestamptz := date_trunc('hour', now()) - ((extract(hour from now())::integer % 4) * interval '1 hour');
  v_key text := to_char(v_slot at time zone 'utc', 'YYYYMMDDHH24');
begin
  insert into public.fp_markets(slug, symbol, name, exchange, closes_at, settles_at, result_bucket)
  values
    (v_key || '-kora', 'KORA', 'Kora Network', 'MEXC', v_slot + interval '4 hours', v_slot + interval '5 hours', 'down'),
    (v_key || '-brine', 'BRINE', 'Brine Finance', 'Bybit', v_slot + interval '4 hours', v_slot + interval '5 hours', 'moon'),
    (v_key || '-luma', 'LUMA', 'Luma Compute', 'Binance', v_slot + interval '4 hours', v_slot + interval '5 hours', 'up')
  on conflict (slug) do nothing;
end;
$$;

create or replace function public.fp_settle_due_markets()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market public.fp_markets%rowtype;
  v_total bigint;
  v_winners bigint;
  v_net bigint;
  v_award record;
begin
  for v_market in
    select * from public.fp_markets where status = 'open' and settles_at <= now() for update skip locked
  loop
    select coalesce(sum(stake), 0), coalesce(sum(stake) filter (where bucket = v_market.result_bucket), 0)
      into v_total, v_winners from public.fp_predictions where market_id = v_market.id;
    v_net := floor(v_total * 0.96);

    for v_award in
      select user_id,
        sum(case when v_winners = 0 then stake
                 when bucket = v_market.result_bucket then floor(stake::numeric * v_net / v_winners)
                 else 0 end)::bigint as amount
      from public.fp_predictions where market_id = v_market.id group by user_id
    loop
      if v_award.amount > 0 then
        update public.fp_profiles set points = points + v_award.amount, updated_at = now() where user_id = v_award.user_id;
        insert into public.fp_ledger(user_id, delta, reason, ref)
        values (v_award.user_id, v_award.amount, case when v_winners = 0 then 'refund' else 'payout' end, v_market.id::text)
        on conflict do nothing;
      end if;
    end loop;

    update public.fp_predictions p set payout =
      case when v_winners = 0 then p.stake
           when p.bucket = v_market.result_bucket then floor(p.stake::numeric * v_net / v_winners)::bigint
           else 0 end
      where p.market_id = v_market.id and p.payout is null;
    update public.fp_markets set status = 'resolved' where id = v_market.id;
  end loop;
end;
$$;

create or replace function public.fp_claim_daily_points()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'utc')::date;
  v_points bigint;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  update public.fp_profiles set points = points + 100, last_claim_day = v_today, updated_at = now()
    where user_id = v_uid and last_claim_day is distinct from v_today
    returning points into v_points;
  if v_points is null then raise exception 'Daily points already claimed'; end if;
  insert into public.fp_ledger(user_id, delta, reason, ref)
  values (v_uid, 100, 'daily', v_today::text) on conflict do nothing;
  return jsonb_build_object('points', v_points, 'canClaimDaily', false);
end;
$$;

create or replace function public.fp_place_prediction(p_market_id uuid, p_bucket text, p_stake integer, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_market public.fp_markets%rowtype;
  v_points bigint;
  v_existing uuid;
  v_id uuid;
  v_used bigint;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_bucket not in ('crash', 'down', 'flat', 'up', 'moon') then raise exception 'Choose a valid outcome'; end if;
  if p_stake < 10 or p_stake > 1000 then raise exception 'Stake must be between 10 and 1,000 points'; end if;

  select id into v_existing from public.fp_predictions where user_id = v_uid and request_id = p_request_id;
  if v_existing is not null then
    select points into v_points from public.fp_profiles where user_id = v_uid;
    return jsonb_build_object('id', v_existing, 'points', v_points, 'duplicate', true);
  end if;

  select * into v_market from public.fp_markets where id = p_market_id for update;
  if not found or v_market.status <> 'open' or v_market.closes_at <= now() then raise exception 'Prediction market is closed'; end if;
  -- Recheck after serializing on the market lock so simultaneous retries return
  -- the original result instead of reaching the unique constraint.
  select id into v_existing from public.fp_predictions where user_id = v_uid and request_id = p_request_id;
  if v_existing is not null then
    select points into v_points from public.fp_profiles where user_id = v_uid;
    return jsonb_build_object('id', v_existing, 'points', v_points, 'duplicate', true);
  end if;
  select coalesce(sum(stake), 0) into v_used from public.fp_predictions where user_id = v_uid and market_id = p_market_id;
  if v_used + p_stake > 1000 then raise exception 'Maximum 1,000 points per market'; end if;

  update public.fp_profiles set points = points - p_stake, updated_at = now()
    where user_id = v_uid and points >= p_stake returning points into v_points;
  if v_points is null then raise exception 'Not enough points'; end if;

  insert into public.fp_predictions(user_id, market_id, bucket, stake, request_id)
  values (v_uid, p_market_id, p_bucket, p_stake, p_request_id) returning id into v_id;
  insert into public.fp_ledger(user_id, delta, reason, ref)
  values (v_uid, -p_stake, 'stake', p_request_id::text);
  return jsonb_build_object('id', v_id, 'points', v_points, 'duplicate', false);
end;
$$;

create or replace function public.fp_get_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  perform public.fp_refresh_practice_markets();
  perform public.fp_settle_due_markets();

  select jsonb_build_object(
    'profile', (select jsonb_build_object(
      'userId', p.user_id, 'walletAddress', p.wallet_address, 'username', p.username,
      'points', p.points, 'canClaimDaily', p.last_claim_day is distinct from (now() at time zone 'utc')::date
    ) from public.fp_profiles p where p.user_id = v_uid),
    'markets', coalesce((select jsonb_agg(jsonb_build_object(
      'id', m.id, 'symbol', m.symbol, 'name', m.name, 'exchange', m.exchange,
      'closesAt', extract(epoch from m.closes_at) * 1000,
      'settlesAt', extract(epoch from m.settles_at) * 1000,
      'status', m.status, 'result', case when m.status = 'resolved' then m.result_bucket else null end,
      'pool', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id),
      'totals', jsonb_build_object(
        'crash', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id and x.bucket = 'crash'),
        'down', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id and x.bucket = 'down'),
        'flat', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id and x.bucket = 'flat'),
        'up', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id and x.bucket = 'up'),
        'moon', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id and x.bucket = 'moon')
      )
    ) order by m.closes_at) from public.fp_markets m where m.created_at > now() - interval '2 days'), '[]'::jsonb),
    'predictions', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.id, 'marketId', x.market_id, 'symbol', m.symbol, 'exchange', m.exchange,
      'bucket', x.bucket, 'stake', x.stake, 'payout', x.payout,
      'placedAt', extract(epoch from x.placed_at) * 1000, 'marketStatus', m.status
    ) order by x.placed_at desc) from public.fp_predictions x join public.fp_markets m on m.id = x.market_id where x.user_id = v_uid), '[]'::jsonb),
    'leaderboard', coalesce((select jsonb_agg(jsonb_build_object('rank', q.rank, 'username', q.username, 'points', q.points, 'isMe', q.user_id = v_uid) order by q.rank)
      from (select p.user_id, p.username, p.points, row_number() over(order by p.points desc, p.created_at) as rank from public.fp_profiles p limit 25) q), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.fp_bootstrap_profile(text) from public, anon;
revoke all on function public.fp_refresh_practice_markets() from public, anon, authenticated;
revoke all on function public.fp_settle_due_markets() from public, anon, authenticated;
revoke all on function public.fp_claim_daily_points() from public, anon;
revoke all on function public.fp_place_prediction(uuid, text, integer, uuid) from public, anon;
revoke all on function public.fp_get_dashboard() from public, anon;
grant execute on function public.fp_bootstrap_profile(text) to authenticated;
grant execute on function public.fp_claim_daily_points() to authenticated;
grant execute on function public.fp_place_prediction(uuid, text, integer, uuid) to authenticated;
grant execute on function public.fp_get_dashboard() to authenticated;

commit;
