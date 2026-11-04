-- Install after setup-api.sql, using the Studio SQL editor or a direct DB connection.
-- Only service_role can call this RPC. It does not accept or execute arbitrary SQL.
BEGIN;
CREATE OR REPLACE FUNCTION alumni_api_private.booking_json(p_id uuid,p_customer uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
  SELECT to_jsonb(b)||jsonb_build_object(
    'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('table_id',i.table_id,'unit_price',i.unit_price) ORDER BY i.table_id),'[]'::jsonb) FROM alumni_69.booking_items i WHERE i.booking_id=b.id),
    'payments',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'status',p.status,'submitted_at',p.submitted_at,'reviewed_at',p.reviewed_at,'rejection_reason',p.rejection_reason) ORDER BY p.submitted_at),'[]'::jsonb) FROM alumni_69.payments p WHERE p.booking_id=b.id))
  FROM alumni_69.bookings b WHERE b.id=p_id AND (p_customer IS NULL OR b.customer_id=p_customer);
$$;
REVOKE ALL ON FUNCTION alumni_api_private.booking_json(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION alumni_api_private.booking_json(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.alumni69_backend(p_action text,p_data jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
  result jsonb;
  bid uuid;
  cid uuid;
  pid uuid;
  table_ids text[];
  previous alumni_api_private.booking_requests%ROWTYPE;
  next_status text;
  affected integer;
  total_customers bigint;
  buyers bigint;
BEGIN
  IF current_user<>'service_role' THEN
    RAISE insufficient_privilege USING MESSAGE='Server role required';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data)<>'object' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_PAYLOAD';
  END IF;
  CASE p_action
    WHEN 'ready' THEN
      RETURN to_jsonb(to_regclass('alumni_api_private.customer_sessions') IS NOT NULL
        AND to_regclass('alumni_69.staff_users') IS NOT NULL
        AND to_regprocedure('alumni_69.create_booking(uuid,text,text,text[])') IS NOT NULL);
    WHEN 'staff' THEN
      SELECT to_jsonb(s) INTO result FROM alumni_69.staff_accounts s WHERE auth_user_id=(p_data->>'id')::uuid;
    WHEN 'staff_login_email' THEN
      SELECT to_jsonb(u.email) INTO result FROM alumni_69.staff_users s JOIN auth.users u ON u.id=s.auth_user_id
        WHERE s.username=p_data->>'username';
    WHEN 'customer_session' THEN
      SELECT to_jsonb(s)||jsonb_build_object('display_name',c.display_name,'full_name',c.full_name,'phone',c.phone,'group_acknowledged_at',a.group_acknowledged_at)
      INTO result FROM alumni_api_private.customer_sessions s
      JOIN alumni_69.customers c ON c.id=s.customer_id
      LEFT JOIN alumni_api_private.line_acknowledgements a ON a.customer_id=c.id
      WHERE s.token_hash=p_data->>'token_hash' AND s.expires_at>clock_timestamp();
    WHEN 'login_customer' THEN
      IF (p_data->>'ttl')::integer NOT BETWEEN 3600 AND 86400 THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE='INVALID_SESSION_TTL';
      END IF;
      DELETE FROM alumni_api_private.customer_sessions WHERE expires_at<clock_timestamp();
      cid:=alumni_69.record_login(p_data->>'line_id',p_data->>'display_name',p_data->>'picture_url');
      INSERT INTO alumni_api_private.customer_sessions(token_hash,customer_id,line_access_token,expires_at)
        VALUES(p_data->>'token_hash',cid,p_data->>'line_access_token',clock_timestamp()+(p_data->>'ttl')::integer*interval '1 second');
      SELECT jsonb_build_object('id',id,'display_name',display_name,'full_name',full_name,'phone',phone)
        INTO result FROM alumni_69.customers WHERE id=cid;
    WHEN 'logout' THEN
      DELETE FROM alumni_api_private.customer_sessions WHERE token_hash=p_data->>'token_hash';
      RETURN 'null'::jsonb;
    WHEN 'oauth_start' THEN
      DELETE FROM alumni_api_private.oauth_states WHERE expires_at<clock_timestamp();
      INSERT INTO alumni_api_private.oauth_states VALUES(p_data->>'state_hash',p_data->>'browser_hash',p_data->>'nonce',p_data->>'verifier',clock_timestamp()+interval '10 minutes');
      RETURN 'null'::jsonb;
    WHEN 'oauth_consume' THEN
      DELETE FROM alumni_api_private.oauth_states WHERE state_hash=p_data->>'state_hash' AND browser_hash=p_data->>'browser_hash'
        AND expires_at>clock_timestamp() RETURNING jsonb_build_object('nonce',nonce,'code_verifier',code_verifier) INTO result;
    WHEN 'acknowledge_group' THEN
      INSERT INTO alumni_api_private.line_acknowledgements(customer_id) VALUES((p_data->>'id')::uuid)
        ON CONFLICT(customer_id) DO UPDATE SET group_acknowledged_at=clock_timestamp()
        RETURNING jsonb_build_object('group_acknowledged_at',group_acknowledged_at) INTO result;
    WHEN 'update_profile' THEN
      UPDATE alumni_69.customers SET full_name=p_data->>'name',phone=p_data->>'phone' WHERE id=(p_data->>'id')::uuid
        RETURNING jsonb_build_object('id',id,'display_name',display_name,'full_name',full_name,'phone',phone) INTO result;
    WHEN 'tables' THEN
      RETURN jsonb_build_object('tables',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY zone,column_label,table_number),'[]'::jsonb) FROM alumni_69.table_status t),
        'reserved_areas',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY zone,id),'[]'::jsonb) FROM alumni_69.reserved_areas a));
    WHEN 'booking' THEN
      result:=alumni_api_private.booking_json((p_data->>'id')::uuid,(p_data->>'customer_id')::uuid);
      IF result IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BOOKING_NOT_FOUND'; END IF;
    WHEN 'bookings' THEN
      SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.created_at DESC),'[]'::jsonb) INTO result FROM
        (SELECT id,booker_name,status,total_amount,created_at,expires_at,confirmed_at FROM alumni_69.bookings
        WHERE customer_id=(p_data->>'customer_id')::uuid ORDER BY created_at DESC LIMIT 100) b;
    WHEN 'create_booking' THEN
      cid:=(p_data->>'customer_id')::uuid;
      SELECT array_agg(value ORDER BY value) INTO table_ids FROM jsonb_array_elements_text(p_data->'tables');
      PERFORM pg_advisory_xact_lock(hashtextextended(cid::text||':'||(p_data->>'key'),0));
      SELECT * INTO previous FROM alumni_api_private.booking_requests WHERE customer_id=cid AND request_key=p_data->>'key';
      IF FOUND THEN
        IF previous.body_hash<>p_data->>'body_hash' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
        RETURN jsonb_build_object('booking',alumni_api_private.booking_json(previous.booking_id,cid),'replayed',true);
      END IF;
      bid:=alumni_69.create_booking(cid,p_data->>'name',p_data->>'phone',table_ids);
      INSERT INTO alumni_api_private.booking_requests VALUES(cid,p_data->>'key',p_data->>'body_hash',bid);
      RETURN jsonb_build_object('booking',alumni_api_private.booking_json(bid,cid),'replayed',false);
    WHEN 'assert_uploadable' THEN
      IF NOT EXISTS(SELECT 1 FROM alumni_69.bookings WHERE id=(p_data->>'id')::uuid AND customer_id=(p_data->>'customer_id')::uuid) THEN
        RAISE SQLSTATE 'PT404' USING MESSAGE='BOOKING_NOT_FOUND';
      END IF;
      IF NOT EXISTS(SELECT 1 FROM alumni_69.bookings WHERE id=(p_data->>'id')::uuid AND customer_id=(p_data->>'customer_id')::uuid AND status='pending_payment' AND expires_at>clock_timestamp()) THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE='NOT_AWAITING_PAYMENT';
      END IF;
      RETURN 'true'::jsonb;
    WHEN 'slip_attached' THEN
      RETURN to_jsonb(EXISTS(SELECT 1 FROM alumni_69.payments WHERE slip_path=p_data->>'path'));
    WHEN 'submit_slip' THEN
      cid:=(p_data->>'customer_id')::uuid; bid:=(p_data->>'id')::uuid;
      pid:=alumni_69.submit_slip(cid,bid,p_data->>'path');
      RETURN jsonb_build_object('payment_id',pid,'booking',alumni_api_private.booking_json(bid,cid));
    WHEN 'confirm' THEN
      bid:=(p_data->>'id')::uuid;
      IF NOT EXISTS(SELECT 1 FROM alumni_69.bookings WHERE id=bid) THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BOOKING_NOT_FOUND'; END IF;
      PERFORM alumni_69.confirm_payment(bid,(p_data->>'actor')::uuid);
      result:=alumni_api_private.booking_json(bid,NULL);
    WHEN 'reject' THEN
      bid:=(p_data->>'id')::uuid;
      IF NOT EXISTS(SELECT 1 FROM alumni_69.staff_accounts WHERE auth_user_id=(p_data->>'actor')::uuid AND role IN('admin','staff')) THEN
        RAISE SQLSTATE 'PT403' USING MESSAGE='FORBIDDEN';
      END IF;
      PERFORM pg_advisory_xact_lock(690035008::bigint);
      result:=alumni_api_private.booking_json(bid,NULL);
      IF result IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BOOKING_NOT_FOUND'; END IF;
      IF result->>'status'<>'pending_review' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='NOT_AWAITING_REVIEW'; END IF;
      UPDATE alumni_69.payments SET status='rejected',reviewed_by=(p_data->>'actor')::uuid,
        reviewed_at=clock_timestamp(),rejection_reason=p_data->>'reason' WHERE booking_id=bid AND status='pending';
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected<>1 THEN RAISE SQLSTATE 'PT409' USING MESSAGE='NO_PENDING_SLIP'; END IF;
      UPDATE alumni_69.bookings SET status=CASE WHEN expires_at>clock_timestamp() THEN 'pending_payment' ELSE 'cancelled' END
        WHERE id=bid RETURNING status INTO next_status;
      IF next_status='cancelled' THEN DELETE FROM alumni_69.table_claims WHERE booking_id=bid; END IF;
      result:=alumni_api_private.booking_json(bid,NULL);
    WHEN 'pending_payments' THEN
      SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.submitted_at),'[]'::jsonb) INTO result FROM
        (SELECT p.id,p.booking_id,p.submitted_at,b.booker_name,b.phone,b.total_amount FROM alumni_69.payments p
        JOIN alumni_69.bookings b ON b.id=p.booking_id WHERE p.status='pending' AND b.status='pending_review' ORDER BY p.submitted_at LIMIT 100) p;
    WHEN 'slip_path' THEN
      SELECT to_jsonb(slip_path) INTO result FROM alumni_69.payments WHERE id=(p_data->>'id')::uuid;
      IF result IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='PAYMENT_NOT_FOUND'; END IF;
    WHEN 'tickets' THEN
      bid:=(p_data->>'id')::uuid;
      result:=alumni_api_private.booking_json(bid,(p_data->>'customer_id')::uuid);
      IF result IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='BOOKING_NOT_FOUND'; END IF;
      IF result->>'status'<>'confirmed' THEN RAISE SQLSTATE 'PT409' USING MESSAGE='TICKETS_NOT_READY'; END IF;
      SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY table_id,seat_number),'[]'::jsonb) INTO result FROM
        (SELECT id,table_id,seat_number,token,used_at FROM alumni_69.tickets WHERE booking_id=bid) t;
    WHEN 'ticket' THEN
      SELECT jsonb_build_object('id',t.id,'table_id',t.table_id,'seat_number',t.seat_number,'used_at',t.used_at) INTO result
        FROM alumni_69.tickets t JOIN alumni_69.bookings b ON b.id=t.booking_id WHERE t.token=(p_data->>'token')::uuid AND b.status='confirmed';
      IF result IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE='TICKET_NOT_FOUND'; END IF;
    WHEN 'dashboard' THEN
      SELECT count(*),count(*) FILTER(WHERE EXISTS(SELECT 1 FROM alumni_69.bookings b WHERE b.customer_id=c.id AND b.status='confirmed')) INTO total_customers,buyers FROM alumni_69.customers c;
      SELECT to_jsonb(s)||jsonb_build_object('total_customers',total_customers::text,'buyers',buyers::text,'non_buyers',(total_customers-buyers)::text,
        'pending_review_bookings',(SELECT count(*)::text FROM alumni_69.bookings WHERE status='pending_review')) INTO result FROM alumni_69.booking_summary s;
    ELSE
      RAISE SQLSTATE 'PT400' USING MESSAGE='UNKNOWN_OPERATION';
  END CASE;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.alumni69_backend(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.alumni69_backend(text,jsonb) TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA alumni_69 TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
