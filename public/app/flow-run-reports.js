function createFlowRunReports({ api, node }) {
  const byId = (id) => document.getElementById(id);
  const form = byId("flow-report-form");
  const section = byId("flow-reports-section");
  const summary = byId("flow-report-summary");
  const flowNotice = byId("flow-report-options-status");
  const download = byId("flow-report-download");
  const submit = form.querySelector("button[type=submit]");
  const groups = [
    [
      "run",
      "run_counts",
      byId("flow-report-run-counts"),
      [
        ["total", "실행 합계"],
        ["delivering", "답장 등록 단계"],
        ["ended", "경로 종료"],
        ["skipped", "중복 답장 제외"],
        ["failed", "실행 실패"],
        ["waiting", "시간 대기"],
        ["awaiting_reply", "응답 대기"],
        ["cancelled", "실행 취소"],
      ],
    ],
    [
      "reply",
      "reply_counts",
      byId("flow-report-reply-counts"),
      [
        ["absent", "연결된 답장 없음"],
        ["pending", "발송 대기"],
        ["sending", "발송 처리 중"],
        ["sent", "Meta 접수"],
        ["blocked", "정책 차단"],
        ["failed", "발송 실패"],
        ["unknown", "결과 미확인"],
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
    form.elements.connection_id.replaceChildren(new Option("모든 계정", ""));
    form.elements.flow_id.replaceChildren(new Option("모든 플로(보관 포함)", ""));
    form.elements.flow_id.disabled = true;
    flowNotice.textContent = "";
    byId("flow-report-zone").textContent = "";
  }
  async function configure(role, zone, connections) {
    reset();
    permitted = role === "owner" || role === "admin";
    if (!permitted || !zone) return;
    timeZone = zone;
    section.hidden = false;
    byId("flow-report-zone").textContent = `실행 생성 날짜 기준 · ${zone} · 종료일은 포함하지 않습니다.`;
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
      byId("flow-report-zone").textContent += " 이 브라우저에서는 시작일과 종료일을 직접 입력해 주세요.";
    }
    for (const connection of connections)
      form.elements.connection_id.append(
        new Option(connection.username ? `@${connection.username}` : connection.id, connection.id),
      );
    invalidate();
    const current = contextGeneration;
    flowNotice.textContent = "플로 목록을 불러오고 있습니다. 전체 조회는 바로 할 수 있습니다.";
    try {
      const { flows } = await api("/api/flows");
      if (current !== contextGeneration || !permitted) return;
      for (const flow of flows) form.elements.flow_id.append(new Option(flow.name, flow.id));
      flowNotice.textContent =
        "목록에는 보관하지 않은 플로만 표시됩니다. 전체 조회에는 보관한 플로의 실행도 포함됩니다.";
    } catch {
      if (current !== contextGeneration) return;
      flowNotice.textContent =
        "플로 목록을 불러오지 못했습니다. 전체 조회는 가능하며, 개별 플로를 선택하려면 페이지를 새로고침해 주세요.";
    } finally {
      if (current === contextGeneration) form.elements.flow_id.disabled = false;
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
    for (const key of ["connection_id", "flow_id"])
      if (form.elements[key].value) query.set(key, form.elements[key].value);
    submit.disabled = true;
    submit.textContent = "조회 중…";
    try {
      const report = await api(`/api/reports/flow-runs?${query}`);
      if (current !== generation || !permitted) return;
      result = report;
      const account = form.elements.connection_id.selectedOptions[0].textContent;
      const flow = form.elements.flow_id.selectedOptions[0].textContent;
      let checkedAt;
      try {
        checkedAt = new Date(report.checked_at).toLocaleString("ko-KR", { timeZone: report.time_zone });
      } catch {
        checkedAt = `${report.checked_at} (UTC)`;
      }
      summary.textContent = `${report.from}부터 ${report.before} 전까지 생성 · ${report.time_zone} · ${account} · ${flow} · ${checkedAt} 조회`;
      for (const [, property, output, metrics] of groups)
        for (const [key, label] of metrics) {
          const item = node("div");
          item.append(node("dt", label), node("dd", BigInt(report[property][key]).toLocaleString("ko-KR")));
          output.append(item);
        }
      download.disabled = false;
    } catch (error) {
      if (current !== generation) return;
      const messages = {
        invalid_report_query: "유효한 시작일과 종료일을 지정해 주세요. 조회 기간은 1~366일입니다.",
        report_time_zone_changed: "작업 공간 시간대가 바뀌었습니다. 페이지를 새로고침한 뒤 다시 조회해 주세요.",
        connection_not_found: "선택한 계정을 찾을 수 없습니다. 페이지를 새로고침해 주세요.",
        flow_not_found: "선택한 플로를 찾을 수 없습니다. 페이지를 새로고침해 주세요.",
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
        "connection_id",
        "flow_id",
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
          result.connection_id ?? "",
          result.flow_id ?? "",
        ]);
    // Fixed keys and validated metadata only; flow/account labels and customer text are excluded.
    const csv =
      "\uFEFF" +
      rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n") +
      "\r\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = node("a");
    link.href = url;
    link.download = `auto-chatter-flow-runs-${result.from}-${result.before}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return { configure, reset };
}
