// Pure, conservative current-human admission. No file, network, SDK or model access.
// Client and server may use the same bytes; original human text is never rewritten.
const ARCHIVE = /归档|存档|(?:保存|存入|收进|放入|放进|存为|存成)(?:到|为|成)?[^。！？；\n]{0,12}(?:项目资料|资料库|资料)/u;
const READ = /看看|看一下|读一读|阅读|分析|检查|审阅|解读|梳理|整理需求/u;
const NEGATION = '(?:不要|别|不必|不用|无需|不需要|不想|不打算|禁止|先不|暂不|不允许|未授权|没有授权|并不|不是|请勿|勿|取消|撤销|没说|没让|不让)';
const NO_TRANSFER = new RegExp(NEGATION + '[^。！？；\\n]{0,8}(?:上传|传输|发送)', 'u');
const NO_ARCHIVE = new RegExp(NEGATION + '[^。！？；\\n]{0,12}(?:归档|存档|保存|存入|收进|放入|放进|存为|存成)', 'u');
const NO_READ = new RegExp(NEGATION + '[^。！？；\\n]{0,8}(?:阅读|分析|读取|检查|查看)', 'u');
const INFORMATIONAL = /怎么|如何|为什么|什么意思|是什么意思|什么叫|是否应该|要不要|该不该/u;
const clarify = (reason, message) => ({ kind: 'clarify', reason, message });

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

function requested(clause, action) {
  // A command prefix must immediately govern the action, not a later keyword
  // hidden behind explain/check/cancel/query verbs or a filename/title.
  const prefix = '(?:(?:请|麻烦|帮我|替我|劳驾|烦请|你需要|你要|需要你|希望你|务必|只|先|再|马上|直接|现在)\\s*)';
  const verb = '(?:' + action.source + ')';
  if (new RegExp('^' + prefix + '{1,4}' + verb, 'u').test(clause)) return true;
  const object = '(?:这(?:份|个)?(?:文件|文档|附件|资料)?|那(?:份|个)?(?:文件|文档|附件|资料)?|该(?:文件|文档|附件|资料)?|此(?:文件|文档|附件|资料)?|刚才那份|刚才(?:的)?(?:文件|文档|附件|资料)|之前那份|上述(?:文件|文档|附件|资料)|所选(?:文件|文档|附件|资料)|文件|文档|附件|资料|它)';
  if (new RegExp('^' + prefix + '{0,4}(?:把|将)\\s*' + object + '\\s*' + verb, 'u').test(clause)) return true;
  if (action === ARCHIVE && new RegExp('^' + prefix + '{0,4}(?:把|将)\\s*' + object + '\\s*作为\\s*__document_label__\\s*的?新版本\\s*归档(?:吧)?$', 'u').test(clause)) return true;
  if (action === ARCHIVE && /^这是[^，,。！？；;\n]{0,120}?(?:需求文档|项目资料|资料|文档|附件|需求)\s*你需要(?:上传并)?归档(?:该|这(?:份|个)?|那(?:份|个)?|本)(?:文件|文档|附件|资料)(?:并(?:且)?推进项目)?(?:吧)?$/u.test(clause)) return true;
  // "上传归档为项目资料" / "上传并归档" / "归档为项目资料": members naturally put 上传 in
  // front of the archive verb, or write 归档为…资料. 上传 alone still authorizes nothing.
  // The trailing noun must be a real destination or object: 归档指南/归档说明/归档流程 are
  // document titles, not commands, so explanatory nouns are refused here.
  const archiveObject = '(?:这(?:份|个)?|那(?:份|个)?|该|此|刚才那份|上述|所选)?(?:文件|文档|附件|资料)';
  const archiveTarget = '(?:项目资料|资料库|资料|项目里|本项目|当前项目)';
  if (action === ARCHIVE && new RegExp('^(?:(?:请|麻烦|帮我|替我|现在|直接)\\s*){0,4}(?:上传\\s*(?:并|和|后|再)?\\s*)?(?:归档|存档)(?:到|为|成|进|入)\\s*' + archiveTarget + '(?:吧)?$', 'u').test(clause)) return true;
  if (action === ARCHIVE && new RegExp('^(?:(?:请|麻烦|帮我|替我|现在|直接)\\s*){0,4}(?:上传\\s*(?:并|和|后|再)?\\s*)?(?:归档|存档)\\s*' + archiveObject + '\\s*(?:到|为|成|进|入)?\\s*' + archiveTarget + '?(?:吧)?$', 'u').test(clause)) return true;
  // A bare "上传并归档" / "上传归档" states the operation without naming an object; 上传 alone
  // still does not qualify, so the archive verb must be present.
  if (action === ARCHIVE && /^(?:(?:请|麻烦|帮我|替我|现在|直接)\s*){0,4}上传\s*(?:并|和|后|再)?\s*(?:归档|存档)(?:吧|一下)?$/u.test(clause)) return true;
  return new RegExp('^' + verb + '(?:这(?:份|个)?|该|此|那个|上述|所选|刚才|之前|它|一下|吧|$)', 'u').test(clause);
}

export function classifyHumanIntent(text) {
  // A document label is inert data. Mask it before quote/fence removal so an
  // embedded command still cannot survive a surrounding quotation or example.
  const commandView = typeof text === 'string' ? text.replace(/《[^》]*》/gu, ' __document_label__ ') : text;
  const instruction = currentHumanInstruction(commandView);
  if (!instruction) return clarify('missing-intent', '还没有处理附件。你希望我先阅读分析，还是归档为项目资料？');
  if (/(?:未|没有|并未|从未)授权|(?:原文|文档|引用|示例)[^。！？；\n]{0,8}(?:提到|出现|有|写着|说过)/u.test(instruction)) return clarify('question-not-instruction', '还没有处理附件。你是在问怎么做，还是要我现在阅读或归档？要阅读请发：帮我看看这份文件；要归档请发：归档这份文件。');
  if (NO_TRANSFER.test(instruction)) return clarify('transfer-not-authorized', '不会上传或归档这份附件。要阅读分析，请单独发一句：帮我看看这份文件。');
  const clauses = instruction.split(/[，,。！？；;\n]+/u).map(value => value.trim()).filter(Boolean);
  const deferred = /如果|假如|倘若|可能|以后|稍后|再说|等[^，,。！？；;\n]{0,20}(?:再|后)|待[^，,。！？；;\n]{0,20}(?:再|后)/u;
  const question = clause => INFORMATIONAL.test(clause) || /(?:吗|么|呢|\?)\s*$/u.test(clause);
  const restore = !deferred.test(instruction) && clauses.some(clause => !question(clause) && !new RegExp(NEGATION, 'u').test(clause) && /^(?:(?:请|麻烦|帮我|替我|现在|直接)\s*){0,4}(?:(?:把|将)?(?:旧版|第\d+版)(?:恢复|还原)(?:为|成|作为)新(?:的)?版本|(?:恢复|还原)(?:旧版|第\d+版)(?:为|成|作为)(?:新版本|新版))(?:吧)?$/u.test(clause));
  const archive = !deferred.test(instruction) && !NO_ARCHIVE.test(instruction) && clauses.some(clause => !question(clause) && (requested(clause, ARCHIVE) || /^附件操作\s*[:：]\s*上传并归档\s*$/u.test(clause)));
  const read = clauses.some(clause => !question(clause) && !deferred.test(clause) && !NO_READ.test(clause) && (requested(clause, READ) || /^附件操作\s*[:：]\s*仅传输\s*$/u.test(clause)));
  if (restore) return { kind: 'archive', reason: 'explicit-current-human-restore-as-new-version' };
  if (archive) return { kind: 'archive', reason: 'explicit-current-human-archive' };
  if (read) return { kind: 'read', reason: 'explicit-current-human-read' };
  return clarify('missing-intent', '还没有处理附件。你希望我先阅读分析，还是归档为项目资料？');
}

/** Only exact trusted names/keys or an existing bound project can resolve scope. */
export function resolveHumanProject({ text, projects = [], currentProjectId = null } = {}) {
  const rows = projects.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string');
  const labels = rows.flatMap(row => [row.name, row.key]).filter(Boolean);
  const instruction = currentHumanInstruction(text, labels).split(/[，,。！？；;\n]+/u).filter(clause => !/^\s*(?:仅供)?(?:参考|对照|借鉴|仿照)/u.test(clause)).join('\n');
  const explicitIds = [...instruction.matchAll(/(?:project_id|项目ID|项目id)\s*[:：=]\s*([a-f0-9]{32})(?![a-f0-9])/gu)].map(match => match[1]);
  if (new Set(explicitIds).size > 1) return clarify('multiple-projects', '这条消息提到了多个项目。请明确这次要处理哪个项目。');
  const spans = rows.flatMap(row => [row.name, row.key].filter(label => typeof label === 'string' && label).flatMap(label => {
    const found = []; let start = instruction.indexOf(label);
    while (start !== -1) { found.push({ row, start, end: start + label.length }); start = instruction.indexOf(label, start + 1); }
    return found;
  }));
  const exact = spans.filter(span => !spans.some(other => other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start));
  const matches = rows.filter(row => exact.some(span => span.row === row) || explicitIds.includes(row.id));
  const ids = [...new Set(matches.map(row => row.id))];
  if (ids.length > 1 || /(?:另一个|其他|别的|多个|两个)项目/u.test(instruction)) return clarify('multiple-projects', '这条消息涉及不同项目，请先明确本次目标项目。');
  if (explicitIds.length && !rows.some(row => row.id === explicitIds[0])) return clarify('unavailable-project', '没有找到可供你使用的目标项目，请重新确认项目名称。');
  if (currentProjectId && ids.length === 1 && ids[0] !== currentProjectId) return clarify('bound-project-conflict', '这份资料指向另一个项目。请进入对应项目会话处理，不会更改当前会话归属。');
  const stated = instruction.match(/这是\s*(.{1,100}?)\s*的(?:需求文档|需求|项目资料|资料|文档)/u)?.[1]?.trim();
  // "整个项目" / "本项目" / "这个项目" 指代当前会话已绑定的项目，不是一个新指名的项目；
  // 拿它去和真实项目名比对必然失败，会把已选好项目的会话误判为未解析。
  const genericStated = stated !== undefined && /^(?:(?:我们|咱们|本次|这次|当前|目前|本|整个|该|这个|那个|此)(?:的)?)?项目$/u.test(stated);
  if (stated && !genericStated && !matches.some(row => [row.name, row.key].includes(stated))) return clarify('unresolved-stated-project', '请确认这份资料所属的项目名称，不会按相似名字自动归档。');
  // An explicit destination without an exact trusted label must not fall back to current.
  const destination = instruction.match(/(?:归档|存档|保存|存入|放入|放进|收进|存为|存成)(?:到|为|成)\s*([^，。！？；\n]+)/u)?.[1]?.split(/并|然后|再/u)[0]?.trim();
  const genericDestination = destination && /^(?:(?:当前|本|这个)项目(?:的)?)?(?:项目资料库?|资料库|资料)?$/u.test(destination);
  const destinationName = destination?.replace(/(?:的)?(?:项目资料库|项目资料|资料库|资料)$/u, '').trim();
  if (destination && !genericDestination && !rows.some(row => [row.name, row.key].some(label => typeof label === 'string' && label && (label === destination || label === destinationName)))) return clarify('unresolved-destination', '请明确要归档到哪个项目。');
  const target = ids[0] ?? currentProjectId;
  const project = rows.find(row => row.id === target);
  if (!project) return clarify('missing-project', '这次要处理哪个项目？请告诉我项目名称。');
  return { kind: 'resolved', projectId: project.id, projectName: project.name };
}

export function interpretAttachmentRequest(options = {}) {
  const intent = classifyHumanIntent(options.text);
  if (intent.kind === 'clarify') return intent;
  const project = resolveHumanProject(options);
  if (project.kind === 'clarify') return project;
  return { ...intent, projectId: project.projectId, projectName: project.projectName, archiveAuthorized: intent.kind === 'archive' };
}

/** A local business clarification is a valid response, not fabricated write success. */
export function* clarificationStream(message) {
  const text = typeof message === 'string' && message.trim() ? message : '请先明确本次操作。';
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
