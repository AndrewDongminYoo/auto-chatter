export interface CommentRuleMatch {
  keyword: string;
  keywords?: readonly string[];
  match_mode?: "contains" | "exact" | "all";
  excluded_keywords?: readonly string[];
}

// The normalization every keyword match uses: comment rules and inbox label rules (#132).
export function normalizeMatchText(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

export function matchesCommentRule(text: string, rule: CommentRuleMatch): boolean {
  const comment = normalizeMatchText(text);
  const excluded = (rule.excluded_keywords ?? []).map(normalizeMatchText).filter(Boolean);
  if (excluded.some((keyword) => comment.includes(keyword))) return false;
  if (rule.match_mode === "all") return true;
  const keywords = (rule.keywords?.length ? rule.keywords : [rule.keyword]).map(normalizeMatchText).filter(Boolean);
  return keywords.some((keyword) => (rule.match_mode === "exact" ? comment === keyword : comment.includes(keyword)));
}
