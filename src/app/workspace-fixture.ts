import type { Pool } from "pg";

// Seeds one row in every exported table for one workspace; the export and workspace deletion DB tests share it.
export async function seedWorkspace(pool: Pool, workspace: string, user: string, connection: string, account: string) {
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [workspace]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)", [workspace, user]);
  await pool.query(
    `INSERT INTO workspace_invites(workspace_id,email,role,token_hash,created_by,expires_at)
     VALUES($1,$2,'agent',encode(sha256(convert_to($2,'UTF8')),'hex'),$3,now()+interval '7 days')`,
    [workspace, `agent-${account}@example.test`, user],
  );
  await pool.query(
    "INSERT INTO instagram_oauth_states(state_hash,user_id,workspace_id,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",
    [`state-hash-${account}`, user, workspace],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,access_token_encrypted,token_expires_at)
     VALUES($1,$2,$3,$3,$4,now()+interval '30 days')`,
    [connection, workspace, account, `SECRET-CIPHERTEXT-${account}`],
  );
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,keywords,private_reply_text,enabled)
       VALUES(gen_random_uuid(),$1,$2,'1789','link','{link}','reply text',false) RETURNING id`,
      [workspace, connection],
    )
  ).rows[0].id;
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,'1789','123',$4) RETURNING id`,
      [workspace, connection, `comment-${account}`, `comment text ${account}`],
    )
  ).rows[0].id;
  const reply = (
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text,recipient_id,status,provider_message_id,sent_at)
       VALUES($1,$2,$3,$4,$5,'1789','123','reply text','900','sent','mid-1',now()) RETURNING id`,
      [workspace, connection, event, rule, `comment-${account}`],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text,status)
     VALUES($1,$2,'900','ok','yes','no','sent')`,
    [reply, connection],
  );
  await pool.query("INSERT INTO instagram_message_receipts(connection_id,message_id,received_at) VALUES($1,$2,now())", [
    connection,
    `m-${account}`,
  ]);
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,'900',$3,'dm text','text',now())`,
    [workspace, connection, `dm-${account}`],
  );
  await pool.query(
    `INSERT INTO instagram_unmatched_replies(workspace_id,connection_id,sender_id,message_id,message_text,message_at)
     VALUES($1,$2,'900',$3,'kept dm text','2026-10-01T00:00:00Z')`,
    [workspace, connection, `kept-${account}`],
  );
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'123',true)",
    [workspace, connection],
  );
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'123','{vip}')",
    [workspace, connection],
  );
  await pool.query(
    "INSERT INTO instagram_contact_segments(workspace_id,name,connection_id,tag) VALUES($1,'vips',$2,'vip')",
    [workspace, connection],
  );
  const field = (
    await pool.query(
      "INSERT INTO instagram_contact_fields(workspace_id,name,type) VALUES($1,'city','text') RETURNING id",
      [workspace],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,'123',$3,'"Seoul"')`,
    [workspace, connection, field],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
     VALUES($1,$2,'900','123',$3,true,1,$4)`,
    [workspace, connection, reply, user],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoff_events(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,actor_id,reason,manual_paused_before,handoff_paused_before,handoff_paused_after)
     VALUES($1,$2,'900','123',$3,true,1,$4,'handoff_started',false,false,true)`,
    [workspace, connection, reply, user],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_conversations(workspace_id,connection_id,recipient_id,status,assignee_user_id,version,updated_by)
     VALUES($1,$2,'900','closed',$3,1,$3)`,
    [workspace, connection, user],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_conversation_events(workspace_id,connection_id,recipient_id,version,reason,from_status,to_status,from_assignee,to_assignee,actor_id)
     VALUES($1,$2,'900',1,'manual','open','closed',NULL,$3,$3)`,
    [workspace, connection, user],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_read_state(workspace_id,connection_id,recipient_id,user_id,last_read_message_id)
     VALUES($1,$2,'900',$3,1)`,
    [workspace, connection, user],
  );
  const label = (
    await pool.query("INSERT INTO instagram_inbox_labels(workspace_id,name,created_by) VALUES($1,$2,$3) RETURNING id", [
      workspace,
      `vip ${account}`,
      user,
    ])
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_inbox_conversation_labels(workspace_id,connection_id,recipient_id,label_ids,version,updated_by)
     VALUES($1,$2,'900',ARRAY[$3::uuid],1,$4)`,
    [workspace, connection, label, user],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_label_events(workspace_id,connection_id,recipient_id,version,added,removed,actor_id)
     VALUES($1,$2,'900',1,ARRAY[$3::uuid],'{}',$4)`,
    [workspace, connection, label, user],
  );
  await pool.query(
    "INSERT INTO instagram_inbox_notes(workspace_id,connection_id,recipient_id,author_id,body) VALUES($1,$2,'900',$3,'note text')",
    [workspace, connection, user],
  );
  const manual = (
    await pool.query(
      `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,status)
       VALUES($1,$2,'900',gen_random_uuid(),$3,'manual text',1,'failed') RETURNING id`,
      [workspace, connection, user],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,actor_id,request_key)
     VALUES($1,$2,'900',$3,'queued',$4,gen_random_uuid())`,
    [workspace, connection, manual, user],
  );
  const consent = (
    await pool.query(
      `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
       VALUES(gen_random_uuid(),$1,$2,'instagram','comment_sender','123','marketing','revoke','explicit','ref',now(),$3) RETURNING id`,
      [workspace, connection, user],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
     SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
     FROM channel_consent_events WHERE id=$1`,
    [consent],
  );
  const flow = (
    await pool.query(
      `INSERT INTO flows(workspace_id,name,draft,draft_revision) VALUES($1,'welcome','{"nodes":[]}',1) RETURNING id`,
      [workspace],
    )
  ).rows[0].id;
  const version = (
    await pool.query(
      `INSERT INTO flow_versions(flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
       VALUES($1,$2,1,1,'{"nodes":[]}',$3,'1789',$4) RETURNING id`,
      [flow, workspace, connection, user],
    )
  ).rows[0].id;
  const flowEvent = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,'2001','124','flow comment') RETURNING id`,
      [workspace, connection, `comment-flow-${account}`],
    )
  ).rows[0].id;
  const run = (
    await pool.query(
      `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status)
       VALUES($1,$2,$3,$4,$5,'delivering') RETURNING id`,
      [workspace, connection, flow, version, flowEvent],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO flow_step_runs(run_id,workspace_id,connection_id,seq,node_id,node_type,outcome)
     VALUES($1,$2,$3,0,'start','instagram_comment','next'),($1,$2,$3,1,'reply','instagram_message','queued')`,
    [run, workspace, connection],
  );
  await pool.query(
    `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,flow_run_id,comment_id,media_id,sender_id,private_reply_text,status)
     VALUES($1,$2,$3,$4,$5,'2001','124','flow reply','failed')`,
    [workspace, connection, flowEvent, run, `comment-flow-${account}`],
  );
  const endpoint = (
    await pool.query("INSERT INTO webhook_endpoints(workspace_id,name,url) VALUES($1,'crm',$2) RETURNING id", [
      workspace,
      `https://hooks.example.test/${account}`,
    ])
  ).rows[0].id;
  await pool.query(
    `INSERT INTO webhook_signing_keys(id,workspace_id,endpoint_id,slot,secret_encrypted)
     VALUES(gen_random_uuid(),$1,$2,1,$3)`,
    [workspace, endpoint, `SECRET-CIPHERTEXT-webhook-${account}`],
  );
  const delivery = (
    await pool.query(
      `INSERT INTO webhook_deliveries(event_id,workspace_id,endpoint_id,connection_id,flow_id,flow_run_id,node_id,sender_id,payload,status,attempt_count,failure_code)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'notify','124','{"fields":{}}','dead',6,'http_error') RETURNING event_id`,
      [workspace, endpoint, connection, flow, run],
    )
  ).rows[0].event_id;
  await pool.query(
    "INSERT INTO webhook_redelivery_events(workspace_id,connection_id,delivery_event_id,actor_id) VALUES($1,$2,$3,$4)",
    [workspace, connection, delivery, user],
  );
  await pool.query(
    `INSERT INTO data_deletion_records(workspace_id,connection_id,requested_by,deleted_counts,retained_counts)
     VALUES($1,$2,$3,'{"instagram_comment_events":0}','{}')`,
    [workspace, connection, user],
  );
}
