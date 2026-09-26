export interface CommentRuleMatch {
  keyword: string;
  keywords?: readonly string[];
  match_mode?: "contains" | "exact" | "all";
  excluded_keywords?: readonly string[];
}

function normalize(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

export function matchesCommentRule(text: string, rule: CommentRuleMatch): boolean {
  const comment = normalize(text);
  const excluded = (rule.excluded_keywords ?? []).map(normalize).filter(Boolean);
  if (excluded.some((keyword) => comment.includes(keyword))) return false;
  if (rule.match_mode === "all") return true;
  const keywords = (rule.keywords?.length ? rule.keywords : [rule.keyword]).map(normalize).filter(Boolean);
  return keywords.some((keyword) => (rule.match_mode === "exact" ? comment === keyword : comment.includes(keyword)));
}
