import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Prettier owns layout, so no formatting rules are enabled here.
const unusedVars = { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true };
const dashboardScript = (name) => `public/app/${name}.js`;

// public/app/*.js are classic scripts loaded in order by public/app/index.html.
// Their top-level declarations are page globals that other scripts (and the src/app vm tests) read.
// Each group below lists the names one script defines, scoped to the scripts that read them.
const dashboardGlobals = [
  // campaign-drafts.js
  { readers: ["app"], names: ["createCampaignDrafts"] },
  // campaign-run-reports.js
  { readers: ["app"], names: ["createCampaignRunReports"] },
  // condition-tree-model.js
  {
    readers: ["app"],
    names: [
      "segmentTreeAddGroup",
      "segmentTreeAddGroupBlock",
      "segmentTreeAddLeaf",
      "segmentTreeAddLeafBlock",
      "segmentTreeBuild",
      "segmentTreeEmpty",
      "segmentTreeFromSaved",
      "segmentTreeMoveGroup",
      "segmentTreeMoveLeaf",
      "segmentTreeNeedsValue",
      "segmentTreeOperators",
      "segmentTreeRemoveField",
      "segmentTreeRemoveGroup",
      "segmentTreeRemoveGroupBlock",
      "segmentTreeRemoveLeaf",
      "segmentTreeSame",
      "segmentTreeSetLeaf",
      "segmentTreeSetMode",
      "segmentTreeSummary",
      "segmentTreeUnsaved",
    ],
  },
  // contact-csv-preview.js
  { readers: ["app"], names: ["createContactCsvPreview"] },
  // contact-identity-links.js
  { readers: ["app"], names: ["createContactIdentityLinks"] },
  // flow-editor-model.js
  {
    readers: ["flow-editor"],
    names: [
      "flowAddTrigger",
      "flowCheckedFieldIds",
      "flowChildCount",
      "flowConfig",
      "flowConnect",
      "flowCopy",
      "flowDisconnect",
      "flowEdge",
      "flowErrorMessage",
      "flowErrorsElsewhere",
      "flowFailureMessage",
      "flowFieldDefault",
      "flowInsert",
      "flowIsDmFlow",
      "flowKnownError",
      "flowLayout",
      "flowLimit",
      "flowLines",
      "flowLinkTargets",
      "flowNodeById",
      "flowOutcome",
      "flowOutline",
      "flowPathEdges",
      "flowPathIds",
      "flowPlaceErrors",
      "flowPortLabel",
      "flowPorts",
      "flowReadable",
      "flowRemovable",
      "flowRemove",
      "flowSameDocument",
      "flowSlotTypes",
      "flowStartName",
      "flowStepLabels",
      "flowStepNumbers",
      "flowStoredList",
      "flowSummary",
      "flowTestStatus",
      "flowTypeLabel",
      "flowTypedNumber",
      "flowUnavailableFieldIds",
      "flowValueText",
      "flowWaitText",
    ],
  },
  // flow-editor.js
  { readers: ["app"], names: ["createFlowEditor"] },
  // flow-run-reports.js
  { readers: ["app"], names: ["createFlowRunReports"] },
  // focus-keeper.js
  { readers: ["app", "inbox"], names: ["holdFocus"] },
  // handoff-reports.js
  { readers: ["app"], names: ["createHandoffReports"] },
  // inbox.js
  { readers: ["app"], names: ["createInbox"] },
  // manual-reply-reports.js
  { readers: ["app"], names: ["createManualReplyReports"] },
  // notice-placement.js
  { readers: ["app"], names: ["actionErrorPlacement", "noticeCloseFocusTarget", "viewChangeClearsMessages"] },
  // plan-labels.js
  { readers: ["app"], names: ["planAcceptSeatRefusal", "planConnectionHelp", "planConnectionsFull", "planSeatHelp", "planSeatsFull", "planSummary"] },
  // reply-templates.js
  { readers: ["inbox"], names: ["createReplyTemplates"] },
  // segment-snapshots.js
  { readers: ["app"], names: ["createSegmentSnapshots"] },
  // send-status-labels.js
  {
    readers: ["app", "campaign-drafts", "campaign-run-reports", "flow-run-reports", "inbox", "manual-reply-reports"],
    names: ["sendStatusEntries", "sendStatusLabel", "sendStatusLabels"],
  },
  // webhook-labels.js
  { readers: ["app"], names: ["webhookAttemptSummary", "webhookDeliveryTimes", "webhookKeyState", "webhookStatusLabel"] },
];

const readonly = (names) => Object.fromEntries(names.map((name) => [name, "readonly"]));

export default [
  { ignores: [".trunk/", ".wrangler/", "coverage/", "dist/", "node_modules/"] },
  js.configs.recommended,
  { rules: { "no-unused-vars": ["error", unusedVars] } },
  {
    files: ["public/app/*.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
    // Top-level declarations are read by other scripts, so only local variables must be used.
    rules: { "no-unused-vars": ["error", { ...unusedVars, vars: "local" }] },
  },
  ...dashboardGlobals.map(({ readers, names }) => ({ files: readers.map(dashboardScript), languageOptions: { globals: readonly(names) } })),
  { files: ["*.js", "scripts/**/*.mjs", "src/**/*.mjs"], languageOptions: { globals: globals.node } },
  {
    // Playwright callbacks in this file run inside the dashboard page and read app.js globals.
    files: ["scripts/auth-session-acceptance.mjs"],
    languageOptions: { globals: { ...globals.browser, ...readonly(["api", "refreshPromise", "start", "workspaceGeneration"]) } },
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ["src/**/*.ts"] })),
  { files: ["src/**/*.ts"], rules: { "@typescript-eslint/no-unused-vars": ["error", unusedVars] } },
];
