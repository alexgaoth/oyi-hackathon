export const JSON_INSTRUCTION =
  'Respond with a single JSON object and nothing else: no prose, no markdown code fences.';

/** System prompt with the JSON instruction appended when `json` is requested. */
export function systemFor(system: string, json?: boolean): string {
  return json ? `${system}\n\n${JSON_INSTRUCTION}` : system;
}

/** Remove `<think>…</think>` blocks (and a dangling unterminated one) from model output. */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
}

/**
 * Lenient JSON-object extraction: parse the first balanced `{...}` in `text`
 * (string-aware, so braces inside strings don't count). Returns undefined if none parses.
 */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1));
          if (v && typeof v === 'object' && !Array.isArray(v)) return v;
        } catch { /* try the next '{' */ }
        break;
      }
    }
  }
  return undefined;
}
