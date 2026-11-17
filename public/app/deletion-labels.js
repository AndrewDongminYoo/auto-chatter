// @ts-check
// Text for the dashboard deletion record (#364). Pure functions only: src/app/deletion-labels.test.ts runs this
// classic script in a node:vm context and checks that every key public.delete_connection_data and
// public.delete_person_data store in deleted_counts and retained_counts has a label here.
const deletedLabels = {
  instagram_comment_events: "댓글",
  private_reply_outbox: "비공개 답장",
  flow_runs: "플로 실행",
  flow_step_runs: "플로 실행 단계",
  flow_dm_deliveries: "플로 DM 발송",
  instagram_dm_start_events: "DM 플로 시작 기록",
  webhook_deliveries: "외부 전송",
  webhook_redelivery_events: "외부 전송 재시도 기록",
  instagram_follow_conversations: "팔로우 후속 메시지",
  instagram_follow_messages: "팔로우 후속 메시지 발송 기록",
  instagram_message_receipts: "확인 메시지 수신",
  instagram_message_reads: "보낸 메시지 읽음",
  instagram_dm_last_inbound: "마지막 수신 DM 시각",
  instagram_inbox_messages: "보관한 수신 DM",
  instagram_unmatched_replies: "연결 대기 응답 DM",
  instagram_inbox_handoffs: "상담 전환",
  instagram_inbox_handoff_events: "상담 전환 이력",
  instagram_inbox_conversations: "대화 상태·담당자",
  instagram_inbox_conversation_events: "대화 상태·담당자 이력",
  instagram_inbox_read_state: "대화 읽음 위치",
  instagram_inbox_conversation_labels: "대화별 라벨",
  instagram_inbox_label_events: "대화 라벨 변경 이력",
  instagram_inbox_notes: "내부 메모",
  instagram_inbox_reminders: "리마인더",
  instagram_inbox_reminder_events: "리마인더 변경 이력",
  instagram_manual_replies: "수동 답장",
  instagram_manual_reply_events: "수동 답장 감사 기록",
  instagram_contact_automation: "자동화 중지 상태",
  instagram_dm_automation: "DM 자동화 중지 상태",
  instagram_contact_identity_links: "식별자 연결 상태",
  instagram_contact_identity_link_events: "식별자 연결 변경 이력",
  instagram_contact_tags: "연락처 태그",
  instagram_contact_field_values: "연락처 필드 값",
  instagram_segment_snapshot_members: "고정한 발송 대상 명단",
  campaign_deliveries: "캠페인 발송",
  channel_consent_state: "동의 허용 상태",
  channel_consent_events: "동의 허용 기록",
};
const retainedLabels = {
  channel_consent_state: "수신 거부 상태",
  channel_consent_events: "수신 거부 기록",
  carried_comment_sender_revokes: "댓글 작성자 ID로 옮긴 수신 거부",
};

function countTotal(counts) {
  return Object.values(counts ?? {}).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

function countSummary(counts, labels) {
  return Object.entries(counts ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => `${labels[key] ?? key} ${formatCount(Number(count))}건`)
    .join(", ");
}
