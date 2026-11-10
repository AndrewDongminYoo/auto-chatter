import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The contrast pairs have one owner: the spec's table. The token values have one owner: public/app/tokens.css.
// This test recomputes every pair from the token file, so a token change that breaks a threshold, or a spec number
// that no longer matches the token file, fails here.
const tokensCss = readFileSync(new URL("../../public/app/tokens.css", import.meta.url), "utf8");
const spec = readFileSync(new URL("../../docs/specs/2026-11-11-dashboard-design-tokens.md", import.meta.url), "utf8");

type Mode = "light" | "dark";

interface ContrastPair {
  number: number;
  foreground: string;
  background: string;
  listed: Record<Mode, number>;
  threshold: number | null;
}

const darkQuery = "@media (prefers-color-scheme: dark)";

function blockBody(source: string, from: number): string {
  const open = source.indexOf("{", from);
  assert.ok(open >= 0, `no block after offset ${from}`);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`unclosed block after offset ${from}`);
}

function colorTokens(body: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens.set(match[1], match[2].toLowerCase());
  }
  return tokens;
}

function tokenModes(source: string): Record<Mode, Map<string, string>> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const darkStart = withoutComments.indexOf(darkQuery);
  assert.ok(darkStart >= 0, `tokens.css must contain ${darkQuery}`);
  const lightStart = withoutComments.indexOf(":root");
  assert.ok(lightStart >= 0 && lightStart < darkStart, "tokens.css must start with the light :root block");
  const darkBody = blockBody(withoutComments, darkStart);
  const darkRoot = darkBody.indexOf(":root");
  assert.ok(darkRoot >= 0, `the ${darkQuery} block must contain :root`);
  return {
    light: colorTokens(blockBody(withoutComments, lightStart)),
    dark: colorTokens(blockBody(darkBody, darkRoot)),
  };
}

function contrastTable(markdown: string): ContrastPair[] {
  const heading = markdown.indexOf("### 대비 표");
  assert.ok(heading >= 0, "the spec must contain the section ### 대비 표");
  const next = markdown.indexOf("\n#", heading + 1);
  const section = markdown.slice(heading, next < 0 ? undefined : next);
  const pairs: ContrastPair[] = [];
  for (const line of section.split("\n")) {
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim().replaceAll("`", ""));
    if (cells.length !== 6 || !/^\d+$/.test(cells[0])) continue;
    const [number, foreground, background, light, dark, threshold] = cells;
    pairs.push({
      number: Number(number),
      foreground,
      background,
      listed: { light: Number(light), dark: Number(dark) },
      threshold: threshold === "없음" ? null : Number(threshold),
    });
  }
  return pairs;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// Truncated, not rounded, to two decimals, as the spec states: a listed 3.00 can never be an actual 2.996.
function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return Math.floor(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

const modes = tokenModes(tokensCss);
const pairs = contrastTable(spec);

test("the spec's contrast table parses into every listed pair", () => {
  assert.ok(pairs.length >= 39, `expected at least 39 contrast pairs in the spec, parsed ${pairs.length}`);
  assert.deepEqual(
    pairs.map((pair) => pair.number),
    pairs.map((_, index) => index + 1),
    "contrast pairs must be numbered 1..n without gaps",
  );
  for (const pair of pairs) {
    for (const value of [pair.listed.light, pair.listed.dark, pair.threshold ?? 0]) {
      assert.ok(Number.isFinite(value), `pair ${pair.number} has a value that is not a number`);
    }
  }
});

test("helper values match the spec's worked examples", () => {
  assert.equal(contrast("#8b8d98", "#fcfcfd"), 3.21);
  assert.equal(contrast("#5a6169", "#111113"), 3.0);
});

// Every text size in the dashboard stylesheet comes from a font-size token, so a literal size cannot drift back in.
test("every font size in styles.css uses a declared font-size token", () => {
  const styles = readFileSync(new URL("../../public/app/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const declared = new Set(
    [...tokensCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--font-size-[a-z0-9-]+)\s*:/g)].map((match) => match[1]),
  );
  const failures: string[] = [];
  const sizes = [...styles.matchAll(/(?<![-\w])font-size\s*:\s*([^;}]+)/g)].map((match) => match[1].trim());
  assert.ok(sizes.length > 0, "styles.css must declare font sizes for this check to read");
  for (const value of sizes) {
    if (value !== "inherit" && !/^var\(--font-size-[a-z0-9-]+\)$/.test(value)) {
      failures.push(`font-size: ${value} is not a var(--font-size-…) token`);
    }
  }
  const shorthands = [...styles.matchAll(/(?<![-\w])font\s*:\s*([^;}]+)/g)].map((match) => match[1].trim());
  assert.ok(shorthands.length > 0, "styles.css must contain the :root font shorthand for this check to read");
  for (const value of shorthands) {
    // A font shorthand always sets a size, so it must be inherit or start with a token (rejects 14px, 120% and medium).
    if (value !== "inherit" && !/^var\(--font-size-[a-z0-9-]+\)\s*\//.test(value)) {
      failures.push(`font: ${value} does not take its size from a var(--font-size-…) token`);
    }
  }
  for (const match of styles.matchAll(/var\((--font-size-[a-z0-9-]+)\)/g)) {
    if (!declared.has(match[1])) failures.push(`${match[1]} is not declared in tokens.css`);
  }
  assert.deepEqual(failures, [], `font-size failures:\n${failures.join("\n")}`);
});

const stylesWithoutComments = readFileSync(new URL("../../public/app/styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

interface Declaration {
  selector: string;
  property: string;
  value: string;
}

// Innermost blocks only, so a rule inside @media reports its own selector, not the media query.
function declarations(source: string, property: RegExp): Declaration[] {
  const found: Declaration[] = [];
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, " ");
    for (const declaration of rule[2].matchAll(/(?<![-\w])([a-z-]+)\s*:\s*([^;]+)/g)) {
      if (property.test(declaration[1])) {
        found.push({ selector, property: declaration[1], value: declaration[2].trim().replace(/\s+/g, " ") });
      }
    }
  }
  return found;
}

// Splits a value on spaces outside parentheses, so calc(var(--space-3) * -1) stays one term.
function terms(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (character === " " && depth === 0) {
      if (current) result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) result.push(current);
  return result;
}

// 1-3px literals are hairline offsets in badges, chips and bubble tails that the 4px scale cannot express.
const hairline = /^[123]px$/;
const spacingTerm = /^(?:0|auto|\d+(?:\.\d+)?%|var\(--space-\d+\)|calc\(var\(--space-\d+\) \* -1\))$/;
const radiusTerm = /^(?:0|var\(--radius(?:-[a-z]+)?\))$/;
const spacingProperty = /^(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z-]+)?$/;
// Above the largest token (48px), spacing stays a px literal on the 4px grid.
const beyondScale = (term: string) =>
  /^\d+px$/.test(term) && Number.parseInt(term, 10) > 48 && Number.parseInt(term, 10) % 4 === 0;
// The summary chevron's margin is part of the drawn icon, not layout spacing.
const spacingExceptions = new Set(["summary::before { margin: 0 10px 2px 2px }"]);

test("styles.css declares and reads no step-1 alias property", () => {
  const aliases = [...stylesWithoutComments.matchAll(/--(?:color-[a-z0-9-]+|radius-control)\b/g)].map(
    (match) => match[0],
  );
  assert.deepEqual(aliases, [], `alias properties still in styles.css: ${aliases.join(", ")}`);
});

test("every spacing declaration in styles.css uses a space token or an allowed literal", () => {
  const spacing = declarations(stylesWithoutComments, spacingProperty);
  assert.ok(spacing.length > 0, "styles.css must declare spacing for this check to read");
  const failures: string[] = [];
  for (const { selector, property, value } of spacing) {
    if (spacingExceptions.has(`${selector} { ${property}: ${value} }`)) continue;
    for (const term of terms(value)) {
      if (!spacingTerm.test(term) && !hairline.test(term) && !beyondScale(term)) {
        failures.push(`${selector} { ${property}: ${value} }: ${term} is not a var(--space-…) token`);
      }
    }
  }
  assert.deepEqual(failures, [], `spacing failures:\n${failures.join("\n")}`);
});

test("every border radius in styles.css uses a radius token or an allowed literal", () => {
  const radii = declarations(stylesWithoutComments, /^border(?:-[a-z]+)*-radius$/);
  assert.ok(radii.length > 0, "styles.css must declare border radii for this check to read");
  const failures: string[] = [];
  for (const { selector, property, value } of radii) {
    for (const term of terms(value)) {
      if (!radiusTerm.test(term) && !hairline.test(term)) {
        failures.push(`${selector} { ${property}: ${value} }: ${term} is not a var(--radius…) token`);
      }
    }
  }
  assert.deepEqual(failures, [], `radius failures:\n${failures.join("\n")}`);
});

test("every space and radius token that styles.css reads is declared in tokens.css", () => {
  const declared = new Set(
    [...tokensCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--(?:space|radius)[a-z0-9-]*)\s*:/g)].map(
      (match) => match[1],
    ),
  );
  const read = [...stylesWithoutComments.matchAll(/var\((--(?:space|radius)[a-z0-9-]*)\)/g)].map((match) => match[1]);
  assert.ok(read.length > 0, "styles.css must read space or radius tokens for this check to read");
  const missing = [...new Set(read.filter((name) => !declared.has(name)))];
  assert.deepEqual(missing, [], `tokens missing from tokens.css: ${missing.join(", ")}`);
});

for (const mode of ["light", "dark"] as const) {
  test(`every contrast pair meets its threshold and matches the spec in ${mode} mode`, () => {
    const tokens = modes[mode];
    const failures: string[] = [];
    for (const pair of pairs) {
      const foreground = tokens.get(pair.foreground);
      const background = tokens.get(pair.background);
      if (!foreground || !background) {
        failures.push(
          `pair ${pair.number}: ${[pair.foreground, pair.background].filter((name) => !tokens.has(name)).join(", ")} missing from the ${mode} tokens`,
        );
        continue;
      }
      const ratio = contrast(foreground, background);
      const label = `pair ${pair.number} ${pair.foreground} ${foreground} / ${pair.background} ${background}`;
      if (pair.threshold !== null && ratio < pair.threshold) {
        failures.push(`${label}: ${ratio.toFixed(2)} is below the ${pair.threshold} threshold`);
      }
      if (ratio !== pair.listed[mode]) {
        failures.push(`${label}: computed ${ratio.toFixed(2)}, the spec lists ${pair.listed[mode].toFixed(2)}`);
      }
    }
    assert.deepEqual(failures, [], `${mode} contrast failures:\n${failures.join("\n")}`);
  });
}
