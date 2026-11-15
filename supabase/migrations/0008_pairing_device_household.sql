-- BreakNLearn 0008: bind a pairing code's device to the code's household (A9-SEC-01). Forward-only, idempotent.
-- 1. Composite FK: a claimed code can only point at a device of the SAME household (paired_devices has unique (id, household_id)).
alter table bnl.device_pairing_codes drop constraint if exists device_pairing_codes_device_id_fkey;
alter table bnl.device_pairing_codes drop constraint if exists device_pairing_codes_device_household_fkey;
alter table bnl.device_pairing_codes add constraint device_pairing_codes_device_household_fkey
  foreign key (device_id, household_id) references bnl.paired_devices (id, household_id) on delete cascade;

-- 2. Defence in depth inside the SECURITY DEFINER redeem: never touch a device of another household.
create or replace function bnl.redeem_pairing(p_pairing_id uuid, p_poll_secret_hash text, p_refresh_token_hash text)
returns table (status text, device_id uuid, household_id uuid, token_version integer)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  c bnl.device_pairing_codes;
  v_version integer;
begin
  select * into c from bnl.device_pairing_codes dpc where dpc.pairing_id = p_pairing_id for update;
  if not found or c.redeemed_at is not null or c.failed_attempts >= 5 then
    return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  if c.poll_secret_hash <> p_poll_secret_hash then
    update bnl.device_pairing_codes set failed_attempts = failed_attempts + 1 where id = c.id;
    return query select 'invalid_secret'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  if c.approved_at is null then
    if c.expires_at <= now() then
      return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    else
      return query select 'pending'::text, null::uuid, null::uuid, null::integer;
    end if;
    return;
  end if;
  if c.expires_at <= now() and c.approved_at <= now() - interval '10 minutes' then
    return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  update bnl.paired_devices pd set refresh_token_hash = p_refresh_token_hash, refresh_rotated_at = now()
    where pd.id = c.device_id and pd.household_id = c.household_id and pd.revoked_at is null
    returning pd.token_version into v_version;
  if v_version is null then
    return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  update bnl.device_pairing_codes set redeemed_at = now() where id = c.id;
  perform bnl._audit('device', c.device_id, c.household_id, 'device.paired', 'paired_device', c.device_id, '{}'::jsonb);
  return query select 'redeemed'::text, c.device_id, c.household_id, v_version;
end
$$;
