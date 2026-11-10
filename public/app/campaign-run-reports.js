function createCampaignRunReports({ api, node }) {
  const byId = (id) => document.getElementById(id);
  const form = byId("campaign-report-form");
  const section = byId("campaign-reports-section");
  const summary = byId("campaign-report-summary");
  const draftNotice = byId("campaign-report-options-status");
  const download = byId("campaign-report-download");
  const submit = form.querySelector("button[type=submit]");
  // The labels of the campaign run screen (campaign-drafts.js). "조건 통과" only means the recorded conditions passed.
  const groups = [
    [
      "run",
      "run_counts",
      byId("campaign-report-run-counts"),
      [
        ["total", "실행 합계"],
        ["running", "진행 중"],
        ["cancelled", "취소됨"],
        ["completed", "완료"],
        ["limit_not_started", "시작하지 않음(월 발송 한도 초과)"],
      ],
    ],
    [
      "start",
      "start_counts",
      byId("campaign-report-start-counts"),
      [
        ["original_member_count", "시작 시점 원래 인원"],
        ["remaining_member_count", "시작 시점 남은 인원"],
        ["connection_unavailable", "연결 발송 불가"],
        ["contact_paused", "자동화 중지"],
        ["no_dm_identity", "확인된 DM 대화 없음"],
        ["opted_out", "수신 거부"],
        ["marketing_consent_required", "마케팅 동의 없음"],
        ["reply_window_closed", "24시간 응답 창 닫힘"],
        ["candidate", "조건 통과"],
        ["plan_limit_exceeded", "월 발송 한도 초과"],
      ],
    ],
    [
      "delivery",
      "delivery_counts",
      byId("campaign-report-delivery-counts"),
      [
        ["total", "발송 행 합계"],
        ...sendStatusEntries(["pending", "sending", "sent"]),
        ["read", "읽음 확인"],
        ["read_unavailable", "읽음 확인 불가"],
        ...sendStatusEntries(["failed", "blocked", "unknown", "cancelled"]),
      ],
    ],
  ];
  let generation = 0;
  let contextGeneration = 0;
  let timeZone;
  let result = null;
  let permitted = false;

  function invalidate(message = "조건을 지정한 뒤 조회해 주세요.") {
    generation++;
    result = null;
    download.disabled = true;
    submit.disabled = !permitted;
    submit.textContent = "조회";
    for (const [, , output] of groups) output.replaceChildren();
    summary.textContent = message;
  }
  function reset() {
    contextGeneration++;
    permitted = false;
    timeZone = undefined;
    invalidate("");
    section.hidden = true;
    form.reset();
    form.elements.draft_id.replaceChildren(new Option("모든 캠페인(보관 포함)", ""));
    form.elements.draft_id.disabled = true;
    draftNotice.textContent = "";
    byId("campaign-report-zone").textContent = "";
  }
  async function configure(role, zone) {
    reset();
    permitted = role === "owner" || role === "admin";
    if (!permitted || !zone) return;
    timeZone = zone;
    section.hidden = false;
    byId("campaign-report-zone").textContent = `실행 시작 날짜 기준 · ${zone} · 종료일은 포함하지 않습니다.`;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const part = (type) => parts.find((item) => item.type === type).value;
      const today = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
      form.elements.from.value = new Date(today.getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
      form.elements.before.value = new Date(today.getTime() + 86_400_000).toISOString().slice(0, 10);
    } catch {
      byId("campaign-report-zone").textContent += " 이 브라우저에서는 시작일과 종료일을 직접 입력해 주세요.";
    }
    invalidate();
    const current = contextGeneration;
    draftNotice.textContent = "캠페인 목록을 불러오고 있습니다. 전체 조회는 바로 할 수 있습니다.";
    try {
      const { drafts } = await api("/api/campaign-drafts");
      if (current !== contextGeneration || !permitted) return;
      for (const draft of drafts) if (!draft.archived) form.elements.draft_id.append(new Option(draft.name, draft.id));
      draftNotice.textContent =
        "목록에는 화면을 연 시점에 보관하지 않은 캠페인만 표시됩니다. 이후 만들거나 보관한 캠페인은 새로고침하면 반영됩니다. 전체 조회에는 보관한 캠페인의 실행도 포함됩니다.";
    } catch {
      if (current !== contextGeneration) return;
      draftNotice.textContent =
        "캠페인 목록을 불러오지 못했습니다. 전체 조회는 가능하며, 개별 캠페인을 선택하려면 페이지를 새로고침해 주세요.";
    } finally {
      if (current === contextGeneration) form.elements.draft_id.disabled = false;
    }
  }
  form.addEventListener("input", () => invalidate());
  form.addEventListener("change", () => invalidate());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!permitted || !timeZone || !form.reportValidity()) return;
    invalidate("조회하고 있습니다…");
    const current = generation;
    const query = new URLSearchParams({
      from: form.elements.from.value,
      before: form.elements.before.value,
      expected_time_zone: timeZone,
    });
    if (form.elements.draft_id.value) query.set("draft_id", form.elements.draft_id.value);
    submit.disabled = true;
    submit.textContent = "조회 중…";
    try {
      const report = await api(`/api/reports/campaign-runs?${query}`);
      if (current !== generation || !permitted) return;
      // Build every row first so a malformed count changes nothing on screen.
      const rendered = groups.map(([, property, , metrics]) =>
        metrics.map(([key, label]) => {
          const item = node("div");
          item.append(node("dt", label), node("dd", BigInt(report[property][key]).toLocaleString("ko-KR")));
          return item;
        }),
      );
      const campaign = form.elements.draft_id.selectedOptions[0].textContent;
      let checkedAt;
      try {
        checkedAt = new Date(report.checked_at).toLocaleString("ko-KR", { timeZone: report.time_zone });
      } catch {
        checkedAt = `${report.checked_at} (UTC)`;
      }
      result = report;
      summary.textContent = `${report.from}부터 ${report.before} 전까지 시작 · ${report.time_zone} · ${campaign} · ${checkedAt} 조회`;
      groups.forEach(([, , output], index) => output.append(...rendered[index]));
      download.disabled = false;
    } catch (error) {
      if (current !== generation) return;
      const messages = {
        invalid_report_query: "유효한 시작일과 종료일을 지정해 주세요. 조회 기간은 1~366일입니다.",
        report_time_zone_changed: "작업 공간 시간대가 바뀌었습니다. 페이지를 새로고침한 뒤 다시 조회해 주세요.",
        campaign_draft_not_found: "선택한 캠페인을 찾을 수 없습니다. 페이지를 새로고침해 주세요.",
        role_forbidden: "소유자와 관리자만 리포트를 조회할 수 있습니다.",
        workspace_required: "작업 공간 권한을 확인할 수 없습니다. 페이지를 새로고침해 주세요.",
      };
      summary.textContent = messages[error.code] || error.message;
    } finally {
      if (current === generation) {
        submit.disabled = !permitted;
        submit.textContent = "조회";
      }
    }
  });
  download.addEventListener("click", () => {
    if (!result || !permitted) return;
    const rows = [
      [
        "group",
        "metric",
        "count",
        "from_date",
        "before_date_exclusive",
        "time_zone",
        "period_from_utc",
        "period_before_utc",
        "checked_at_utc",
        "draft_id",
      ],
    ];
    for (const [group, property, , metrics] of groups)
      for (const [key] of metrics)
        rows.push([
          group,
          key,
          result[property][key],
          result.from,
          result.before,
          result.time_zone,
          result.period_from,
          result.period_before,
          result.checked_at,
          result.draft_id ?? "",
        ]);
    // Fixed keys and validated metadata only; campaign names, message text and customer data are excluded.
    const csv =
      "﻿" +
      rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n") +
      "\r\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = node("a");
    link.href = url;
    link.download = `auto-chatter-campaign-runs-${result.from}-${result.before}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return { configure, reset };
}
