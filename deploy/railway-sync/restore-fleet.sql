-- Puts back what keep-fleet.sql set aside, in one transaction, once the
-- redeployed backend has re-applied dev's migrations to the fresh copy (the
-- fleet tables do not exist in prod's schema until then). sync.sh waits for
-- that; run by hand, it is safe as long as sync_keep exists and every
-- migration in sync_keep._migrations is applied again.
--
-- Rows are matched to the migrated tables by column name, so a migration that
-- added a column gives it its default and one that dropped a column drops it
-- here too.
--
-- The migration runner's lock, so a migration still running on the backend's
-- boot finishes before the fleet tables are touched.
SELECT pg_catalog.pg_advisory_xact_lock(778423);

DO $$
DECLARE
  t RECORD;
  f RECORD;
  kept TEXT[];
  done TEXT[] := '{}';
  cols TEXT;
  n BIGINT;
  progress BOOLEAN;
BEGIN
  IF pg_catalog.to_regclass('sync_keep._pool') IS NOT NULL THEN
    -- Only onto the same account: a pool number that prod now gives to someone
    -- else gets none of the kept secrets, and its slot is not brought back.
    -- The holder comes back too: a worker's token is only honoured while its
    -- account names it as holder. A holding user the copy no longer has gets
    -- what the foreign key's ON DELETE SET NULL would have given it.
    SELECT string_agg(CASE WHEN c.column_name = 'holder_user_id'
                        THEN 'holder_user_id = (SELECT u.id FROM public.users u WHERE u.id = k.holder_user_id)'
                        ELSE pg_catalog.format('%I = k.%I', c.column_name, c.column_name) END, ', ')
    INTO cols
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'fb_pool_accounts'
      AND (c.column_name ~ '_enc$' OR c.column_name IN ('cookie_uid', 'cookie_at', 'status', 'note', 'holder_user_id', 'holder_name', 'held_since'))
      AND EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = 'sync_keep' AND k.table_name = '_pool' AND k.column_name = c.column_name);
    EXECUTE pg_catalog.format(
      'UPDATE public.fb_pool_accounts p SET %s FROM sync_keep._pool k WHERE p.no = k.no AND p.uid IS NOT DISTINCT FROM k.uid',
      cols);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'keep-fleet: % pool accounts restored', n;

    IF pg_catalog.to_regclass('sync_keep.fleet_slots') IS NOT NULL THEN
      DELETE FROM sync_keep.fleet_slots s
      WHERE NOT EXISTS (SELECT 1 FROM public.fb_pool_accounts p
                        JOIN sync_keep._pool k ON k.no = p.no AND k.uid IS NOT DISTINCT FROM p.uid
                        WHERE p.no = s.account_no);
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RAISE NOTICE 'keep-fleet: % slots dropped, their pool account is gone or changed', n; END IF;
    END IF;
    IF pg_catalog.to_regclass('sync_keep.fleet_workers') IS NOT NULL THEN
      UPDATE sync_keep.fleet_workers w SET account_no = NULL
      WHERE w.account_no IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.fb_pool_accounts p
                        JOIN sync_keep._pool k ON k.no = p.no AND k.uid IS NOT DISTINCT FROM p.uid
                        WHERE p.no = w.account_no);
    END IF;
  END IF;

  SELECT COALESCE(array_agg(k.relname::text), '{}') INTO kept
  FROM pg_catalog.pg_class k
  JOIN pg_catalog.pg_namespace kn ON kn.oid = k.relnamespace
  WHERE kn.nspname = 'sync_keep' AND k.relkind = 'r' AND k.relname LIKE 'fleet\_%'
    AND pg_catalog.to_regclass(pg_catalog.format('public.%I', k.relname)) IS NOT NULL;

  -- A kept row pointing outside the fleet (a user, a pool account) at a row
  -- the copy no longer has gets what its foreign key's ON DELETE would have
  -- given it. Anything else fails the restore, loudly.
  FOR f IN
    SELECT cc.relname AS child, ca.attname AS col, pc.relname AS parent, pa.attname AS pcol, con.confdeltype AS act
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class cc ON cc.oid = con.conrelid
    JOIN pg_catalog.pg_namespace cn ON cn.oid = cc.relnamespace AND cn.nspname = 'public'
    JOIN pg_catalog.pg_class pc ON pc.oid = con.confrelid
    JOIN pg_catalog.pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
    JOIN pg_catalog.pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND cardinality(con.conkey) = 1
      AND cc.relname = ANY (kept) AND NOT (pc.relname = ANY (kept))
      AND con.confdeltype IN ('c', 'n')
      AND EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = 'sync_keep' AND k.table_name = cc.relname AND k.column_name = ca.attname)
  LOOP
    IF f.act = 'c' THEN
      EXECUTE pg_catalog.format(
        'DELETE FROM sync_keep.%I k WHERE k.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.%I r WHERE r.%I = k.%I)',
        f.child, f.col, f.parent, f.pcol, f.col);
    ELSE
      EXECUTE pg_catalog.format(
        'UPDATE sync_keep.%I k SET %I = NULL WHERE k.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.%I r WHERE r.%I = k.%I)',
        f.child, f.col, f.col, f.parent, f.pcol, f.col);
    END IF;
  END LOOP;

  -- Whatever the fresh copy holds (prod's own fleet, once it has one) gives
  -- way to dev's.
  IF cardinality(kept) > 0 THEN
    EXECUTE 'TRUNCATE ' || (SELECT string_agg(pg_catalog.format('public.%I', x), ', ') FROM unnest(kept) x);
  END IF;

  -- Parents before children. Triggers are off while the rows go in: they are
  -- history already, and the attempt archive would otherwise write each
  -- finished task's attempt a second time.
  LOOP
    progress := FALSE;
    FOR t IN
      SELECT x AS relname FROM unnest(kept) x
      WHERE NOT (x = ANY (done))
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class pc ON pc.oid = con.confrelid
          WHERE con.contype = 'f' AND con.conrelid = pg_catalog.format('public.%I', x)::regclass
            AND pc.relname = ANY (kept) AND pc.relname <> x AND NOT (pc.relname = ANY (done)))
    LOOP
      SELECT string_agg(pg_catalog.format('%I', c.column_name), ', ' ORDER BY c.ordinal_position)
      INTO cols
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = t.relname AND c.is_generated = 'NEVER'
        AND EXISTS (SELECT 1 FROM information_schema.columns k
                    WHERE k.table_schema = 'sync_keep' AND k.table_name = t.relname AND k.column_name = c.column_name);
      EXECUTE pg_catalog.format('ALTER TABLE public.%I DISABLE TRIGGER USER', t.relname);
      EXECUTE pg_catalog.format('INSERT INTO public.%I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM sync_keep.%I',
                                t.relname, cols, cols, t.relname);
      GET DIAGNOSTICS n = ROW_COUNT;
      EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE TRIGGER USER', t.relname);
      RAISE NOTICE 'keep-fleet: % rows back in %', n, t.relname;
      done := done || t.relname::text;
      progress := TRUE;
    END LOOP;
    EXIT WHEN NOT progress;
  END LOOP;
  IF cardinality(done) < cardinality(kept) THEN
    RAISE EXCEPTION 'keep-fleet: foreign keys loop among %, restore them by hand', kept;
  END IF;

  -- The kept ids are back, so each id sequence starts after them.
  FOR f IN
    SELECT x AS tbl, c.column_name AS col,
           pg_catalog.pg_get_serial_sequence(pg_catalog.format('public.%I', x), c.column_name) AS seq
    FROM unnest(kept) x
    JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = x
    WHERE pg_catalog.pg_get_serial_sequence(pg_catalog.format('public.%I', x), c.column_name) IS NOT NULL
  LOOP
    EXECUTE pg_catalog.format('SELECT pg_catalog.setval(%L, COALESCE((SELECT max(%I) FROM public.%I), 0) + 1, false)',
                              f.seq, f.col, f.tbl);
  END LOOP;
END $$;

DROP SCHEMA sync_keep CASCADE;
