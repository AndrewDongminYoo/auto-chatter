// Keeps keyboard focus on a control that a running request disabled. When the focused element becomes disabled,
// the browser moves focus to body, which sends a keyboard user back to the top of the page. src/app/focus-keeper.test.ts
// runs this classic script in a node:vm context, so nothing here reads document at the top level.

// The element focus goes back to once the busy controls are re-enabled: `previous`, if it is still in the document.
// Only while focus is on body or nothing, so an element that took focus on purpose meanwhile (#notice on an error)
// keeps it, and never when nothing had focus before (a mouse click in Safari does not focus a button).
function focusRestoreTarget(previous, active, body) {
  if (!previous || previous === body || !previous.isConnected || (active && active !== body)) return null;
  return previous;
}

// Call before a request disables controls; call the returned function after they are re-enabled.
function holdFocus() {
  const previous = document.activeElement;
  return () => {
    focusRestoreTarget(previous, document.activeElement, document.body)?.focus({ preventScroll: true });
  };
}
