import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveHumanPolicy,humanToolDenial,humanVisibleTool,humanAuthorizationCapability} from '../src/human-authorization.mjs';

// The phrase matrix as a regression contract: what a person writes, and exactly which business write
// that sentence authorizes. Authorization is the union of the clauses that carry a real instruction.
const CASES = [
  ['提交需求分析，然后提交成果', 'mixed', ['analysis_submit', 'result_submit']],
  ['记录进展并提交成果', 'mixed', ['progress_add', 'result_submit']],
  ['如果方便，提交成果', 'result', ['result_submit']],
  ['以后再说，先提交方案', 'plan', ['plan_register']],
  ['提交需求分析，然后如果不行就别提交成果', 'analysis', ['analysis_submit']],
  ['提交方案', 'plan', ['plan_register']],
  ['请提交修订后的方案', 'revise', ['plan_revise']],
  ['请提交这份需求分析', 'analysis', ['analysis_submit']],
  ['登记这个成果', 'result', ['result_submit']],
  ['请把这条通知标为已读', 'read-notice', ['todo_mark_read']],
  ['请为这个成果发起验收', 'acceptance', ['result_acceptance_open']],
  ['更新这个项目的背景：范围只到本期', 'details', ['project_update_details']],
  // Nothing below may authorize a write: a question, a lookup, a refusal, or a deferral is not an order.
  ['提交成果了吗', 'draft', []],
  ['请查询提交方案状态', 'draft', []],
  ['请检查是否已经提交方案', 'draft', []],
  ['请解释如何提交方案', 'draft', []],
  ['请勿提交方案', 'draft', []],
  ['请取消提交方案', 'draft', []],
  ['请等我确认后再提交方案', 'draft', []],
  ['如果明天有空时提交成果', 'draft', []],
  ['帮我推进项目，做个方案', 'draft', []],
  ['按推荐的来', 'draft', []],
  ['继续', 'draft', []],
];

for (const [text, kind, writes] of CASES) {
  test('human policy for: ' + text, () => {
    const policy = deriveHumanPolicy(text);
    assert.equal(policy.kind, kind);
    assert.deepEqual([...policy.writes].sort(), writes.slice().sort());
  });
}

test('several clear instructions in one message no longer collapse to no authorization', () => {
  const policy = deriveHumanPolicy('提交需求分析，然后提交成果');
  assert.equal(policy.writes.size, 2);
  assert.ok(policy.writes.has('analysis_submit') && policy.writes.has('result_submit'));
});

test('a conditional clause cannot lend its instruction to a later clause', () => {
  const policy = deriveHumanPolicy('提交需求分析，然后如果不行就别提交成果');
  assert.deepEqual([...policy.writes], ['analysis_submit']);
});

test('write tools are advertised while human-only confirmations never are', () => {
  for (const name of ['analysis_submit', 'plan_register', 'plan_revise', 'result_submit', 'progress_add', 'project_update_details', 'todo_mark_read', 'result_acceptance_open', 'material_list', 'plan_get', 'attachment_read', 'attachment_archive']) assert.ok(humanVisibleTool(name), name);
  for (const name of ['plan_confirm', 'result_review', 'result_accept', 'attachment_transfer', 'attachment_receipts', 'attachment_inspect']) assert.ok(!humanVisibleTool(name), name);
});

test('a refusal names the operation and the exact sentence that would authorize it', () => {
  const message = humanToolDenial('result_submit');
  assert.match(message, /当前人类消息未授权/);
  assert.match(message, /「提交成果」/);
  assert.match(message, /请单独发一句：提交成果。/);
  assert.match(message, /模型不能代本人确认/);
  for (const name of ['analysis_submit', 'plan_register', 'plan_revise', 'result_submit', 'progress_add', 'project_update_details', 'todo_mark_read', 'result_acceptance_open']) {
    assert.match(humanToolDenial(name), /请单独发一句：[^。]+。/, name);
  }
});

test('the version 3 capability is the pairing gate after the attachment redesign', () => {
  assert.deepEqual(humanAuthorizationCapability(), { version: 3 });
});
