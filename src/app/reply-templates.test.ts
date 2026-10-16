import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTemplate, templateVariables } from "./reply-templates.ts";

test("template grammar accepts only bounded variable names and keeps first-use order", () => {
  assert.deepEqual(templateVariables("{literal} {{name}} {{code_2}} {{name}}"), ["name", "code_2"]);
  for (const text of ["{{}}", "{{x.y}}", "{{x()}}", "{{x}}}", "{{{x}}", "{{" + "a".repeat(33) + "}}"])
    assert.throws(() => templateVariables(text), { message: "invalid_template_body" });
  assert.deepEqual(templateVariables("{{" + "a".repeat(32) + "}}"), ["a".repeat(32)]);
});

test("template values are own string properties and never expressions or replacement syntax", () => {
  assert.equal(
    renderTemplate("{{constructor}} / {{name}}", { constructor: "$&", name: "{{constructor}}" }),
    "$& / {{constructor}}",
  );
  assert.throws(() => renderTemplate("{{constructor}}", {}), { message: "invalid_template_values" });
  assert.throws(() => renderTemplate("{{name}}", Object.create({ name: "inherited" })), {
    message: "invalid_template_values",
  });
  assert.throws(() => renderTemplate("plain", { unused: "value" }), { message: "invalid_template_values" });
  assert.throws(() => renderTemplate("{{name}}{{name}}", { name: "😀".repeat(251) }), {
    message: "template_text_too_long",
  });
  assert.equal(renderTemplate("{{name}}{{name}}", { name: "😀".repeat(250) }).length, 1000);
});
