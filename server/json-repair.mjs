/** Conservative syntax recovery: no inferred values, appended brackets, extracted subtrees or quote guessing. */
function rejectDuplicateKeys(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i += 1; i < text.length; i++) {
        if (text[i] === '\\') i += 1;
        else if (text[i] === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.object && frame.expectKey) {
        const key = JSON.parse(text.slice(start, i + 1));
        if (frame.keys.has(key)) throw new SyntaxError('Duplicate JSON property');
        frame.keys.add(key);
      }
    } else if (ch === '{' || ch === '[') stack.push({ object: ch === '{', expectKey: ch === '{', keys: new Set() });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ':' && stack.at(-1)?.object) stack.at(-1).expectKey = false;
    else if (ch === ',' && stack.at(-1)?.object) stack.at(-1).expectKey = true;
  }
}
export function parseJsonWithRepair(input) {
  if (typeof input !== 'string') return { value: input, repaired: false, notes: [], original_error_code: null };
  try {
    const value = JSON.parse(input);
    rejectDuplicateKeys(input);
    return { value, repaired: false, notes: [], original_error_code: null };
  }
  catch { /* The original parse failure remains visible if syntax recovery succeeds. */ }
  let text = input;
  const notes = [];
  if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); notes.push('removed_bom'); }
  text = text.trim();
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  if (fenced) { text = fenced[1]; notes.push('removed_full_json_fence'); }
  let out = '', inString = false, escaped = false, controls = false, commas = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') inString = false;
      if (ch.charCodeAt(0) < 0x20) { out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; controls = true; }
      else out += ch;
    } else {
      if (ch === '"') inString = true;
      if (ch === ',') {
        const next = text.slice(i + 1).match(/^\s*(.)/)?.[1];
        const previous = out.trimEnd().at(-1);
        if ((next === '}' || next === ']') && previous && !'[{,:'.includes(previous)) { commas = true; continue; }
      }
      out += ch;
    }
  }
  // Never complete a truncated string or add missing semantic structure.
  if (inString || escaped) throw new SyntaxError('Unclosed JSON string');
  if (controls) notes.push('escaped_literal_control_characters');
  if (commas) notes.push('removed_trailing_commas');
  const value = JSON.parse(out);
  rejectDuplicateKeys(out);
  if (!notes.length) throw new SyntaxError('JSON cannot be safely recovered');
  return { value, repaired: true, notes, original_error_code: 'MODEL_INVALID_JSON' };
}
