// Decides where a dashboard message appears: the page notice (#notice) or an inline error next to the control that
// failed. src/app/notice-placement.test.ts runs this classic script in a node:vm context, so nothing here reads
// document at the top level.

// Whether showView() clears the page notice and the inline action errors. Only a change from a shown menu to another
// menu clears them: the first display (previous undefined, also after a sign-out reset, which clears the action errors
// itself) keeps the notices written while the workspace loaded, and showing the same menu again (a reload, a click on
// the current menu) keeps them too.
function viewChangeClearsMessages(previous, next) {
  return previous !== undefined && previous !== next;
}

// Where action() shows the failure of the task that `button` started: `owner` is the closest form or section, and the
// error element goes right after `row`, the element that holds the button directly inside `owner`, or inside the list
// item or table cell of the button when it is in a list or table, so the error stays next to its row and is always a
// valid child of its parent. Returns null when the failure has no visible owner (no form or section around the button,
// a button that the task removed, or one inside a hidden part such as the sign-in card after a login); action() then
// shows it in the page notice.
function actionErrorPlacement(button) {
  if (!button?.isConnected || button.closest("[hidden]")) return null;
  const owner = button.closest("form, section");
  if (!owner) return null;
  const stops = (element) => element === owner || element.tagName === "LI" || element.tagName === "TD";
  let row = button;
  while (row.parentElement && !stops(row.parentElement)) row = row.parentElement;
  return row.parentElement ? { owner, row } : null;
}

// The ID of the element that takes focus when the notice is closed: only when focus was on the notice or its close
// button, which the browser would otherwise drop on body. The shown menu's region (the element showView() focuses),
// or #main when no menu is shown (the sign-in screen).
function noticeCloseFocusTarget(focusInNotice, view) {
  if (!focusInNotice) return null;
  return view ? `view-${view}` : "main";
}
