// Pure text hygiene for current-human phrasing. No file, network, SDK or model access.
// Retained ONLY for the business-write authorization boundary in human-authorization.mjs
// (the exact phrase a person must send before the model may submit analysis/plan/result).
// Attachment admission no longer uses word lists: attachments are an inventory; the model
// decides read/archive in conversation.

/** Discard commands in code fences, quote blocks, inline code and quoted speech. */
export function currentHumanInstruction(text, trustedLabels = []) {
  if (typeof text !== 'string') return '';
  const labels = new Set(trustedLabels.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()));
  let fence = null;
  const lines = [];
  for (const line of text.split(/\r?\n/u)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0], length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^\s*>/u.test(line)) continue;
    lines.push(line);
  }
  return lines.join('\n')
    .replace(/(^|[\s（(：:])@(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s\r\n]+)/gu, '$1 ')
    .replace(/《([^》]*)》/gu, (_whole, value) => labels.has(value.trim()) ? value.trim() : ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/“([^”]*)”|‘([^’]*)’|「([^」]*)」|『([^』]*)』|"([^"\n]*)"|'([^'\n]*)'/gu,
      (_whole, ...parts) => {
        const value = parts.slice(0, 6).find(part => part !== undefined)?.trim();
        // A quoted exact project label is data, never an executable command.
        return labels.has(value) ? value : ' ';
      }).trim();
}
