import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCampaignDraft } from "./campaign-drafts.ts";
const input = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  snapshot_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Draft",
  body: "Hello",
};
test("draft text counts UTF-16 units while its normalized name counts code points", () => {
  const parsed = parseCampaignDraft({ ...input, name: "😀".repeat(60), body: "😀".repeat(500) });
  assert.equal(parsed.body.length, 1000);
  assert.throws(() => parseCampaignDraft({ ...input, body: "😀".repeat(501) }), /invalid_campaign_draft/);
  assert.throws(() => parseCampaignDraft({ ...input, name: "😀".repeat(61) }), /invalid_campaign_draft/);
  assert.equal(parseCampaignDraft({ ...input, name: " e\u0301 " }).name, "é");
});
test("campaign creation and editing require disjoint exact payloads", () => {
  const { id, ...fields } = input;
  for (const bad of [
    null,
    [],
    {},
    { ...input, extra: 1 },
    { ...input, id: undefined },
    { ...input, snapshot_id: "bad" },
    { ...input, name: "bad\nname" },
  ])
    assert.throws(() => parseCampaignDraft(bad), /invalid_campaign_draft/);
  assert.throws(() => parseCampaignDraft({ ...input, expected_version: 1 }, true), /invalid_campaign_draft/);
  for (const value of [0, -1, 1.5, "1", null, 2147483647])
    assert.throws(() => parseCampaignDraft({ ...fields, expected_version: value }, true), /invalid_campaign_draft/);
  assert.equal(parseCampaignDraft({ ...fields, expected_version: 1 }, true).expected_version, 1);
  assert.equal(parseCampaignDraft({ ...input, id: id.toUpperCase() }).id, id);
});
