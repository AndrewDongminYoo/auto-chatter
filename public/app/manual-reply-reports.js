function createManualReplyReports({ api, node }) {
  const byId = (id) => document.getElementById(id);
  const form = byId("manual-report-form");
  const section = byId("manual-reports-section");
  const output = byId("manual-report-counts");
  const summary = byId("manual-report-summary");
  const download = byId("manual-report-download");
  const submit = form.querySelector("button[type=submit]");
  const metrics = [
    ["total", "접수 요청 합계"],
    ["pending", "대기 중"],
    ["sending", "발송 처리 중"],
    ["sent", "Meta 접수"],
    ["failed", "실패·정책 거부"],
    ["unknown_unresolved", "결과 미확인"],
    ["unknown_resolved", "미확인·정리 완료"],
    ["cancelled", "예약 취소"],
  ];
  let generation = 0;
  let timeZone;
  let result = null;
  let permitted = false;

  function invalidate(message = "조건을 지정한 뒤 조회해 주세요.") {
    generation++;
    result = null;
    download.disabled = true;
    submit.disabled = !permitted;
    submit.textContent = "조회";
    output.replaceChildren();
    summary.textContent = message;
  }
  function reset() {
    permitted = false;
    timeZone = undefined;
    invalidate("");
    section.hidden = true;
    form.reset();
    form.elements.connection_id.replaceChildren(new Option("모든 계정", ""));
    byId("manual-report-zone").textContent = "";
  }
  function configure(role, zone, connections) {
    reset();
    permitted = role === "owner" || role === "admin";
    if (!permitted || !zone) return;
    timeZone = zone;
    section.hidden = false;
    byId("manual-report-zone").textContent = `접수 날짜 기준 · ${zone} · 종료일은 포함하지 않습니다.`;
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
      byId("manual-report-zone").textContent += " 이 브라우저에서는 시작일과 종료일을 직접 입력해 주세요.";
    }
    for (const connection of connections)
      form.elements.connection_id.append(
        new Option(connection.username ? `@${connection.username}` : connection.id, connection.id),
      );
    invalidate();
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
    if (form.elements.connection_id.value) query.set("connection_id", form.elements.connection_id.value);
    submit.disabled = true;
    submit.textContent = "조회 중…";
    try {
      const report = await api(`/api/reports/manual-replies?${query}`);
      if (current !== generation || !permitted) return;
      result = report;
      const account = form.elements.connection_id.selectedOptions[0].textContent;
      let checkedAt;
      try {
        checkedAt = new Date(report.checked_at).toLocaleString("ko-KR", { timeZone: report.time_zone });
      } catch {
        checkedAt = `${report.checked_at} (UTC)`;
      }
      summary.textContent = `${report.from}부터 ${report.before} 전까지 접수 · ${report.time_zone} · ${account} · ${checkedAt} 조회`;
      for (const [key, label] of metrics) {
        const item = node("div");
        item.append(node("dt", label), node("dd", BigInt(report.counts[key]).toLocaleString("ko-KR")));
        output.append(item);
      }
      download.disabled = false;
    } catch (error) {
      if (current !== generation) return;
      const messages = {
        invalid_report_query: "유효한 시작일과 종료일을 지정해 주세요. 조회 기간은 1~366일입니다.",
        report_time_zone_changed: "작업 공간 시간대가 바뀌었습니다. 페이지를 새로고침한 뒤 다시 조회해 주세요.",
        connection_not_found: "선택한 계정을 찾을 수 없습니다. 페이지를 새로고침해 주세요.",
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
        "metric",
        "count",
        "from_date",
        "before_date_exclusive",
        "time_zone",
        "period_from_utc",
        "period_before_utc",
        "checked_at_utc",
        "connection_id",
      ],
      ...metrics.map(([key]) => [
        key,
        result.counts[key],
        result.from,
        result.before,
        result.time_zone,
        result.period_from,
        result.period_before,
        result.checked_at,
        result.connection_id ?? "",
      ]),
    ];
    // Only fixed keys and server-validated metadata are exported; no account label or customer text.
    const csv =
      "\uFEFF" +
      rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n") +
      "\r\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = node("a");
    link.href = url;
    link.download = `auto-chatter-manual-replies-${result.from}-${result.before}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return { configure, reset };
}
