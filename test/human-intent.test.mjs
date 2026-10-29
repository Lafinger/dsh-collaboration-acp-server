import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHumanProject, interpretAttachmentRequest, classifyHumanIntent } from '../src/human-intent.mjs';

const current = 'a'.repeat(32);
const other = 'b'.repeat(32);
const projects = [
  { id: current, name: '南航智慧出行数字人POC2', key: 'NHMHPOC02' },
  { id: other, name: '另一个真实项目', key: 'OTHER01' },
];

// A session that already selected its project must not be asked again just because the
// human used a generic word for "this project". The regex used to capture such a word as a
// stated project name, compare it against real labels, fail, and force a clarification.
const generic = [
  '这是整个项目的需求文档，你需要分析并上传。',
  '这是本项目的需求文档，你需要分析并上传。',
  '这是这个项目的需求文档，你需要分析并上传。',
  '这是该项目的需求文档，你需要分析并上传。',
  '这是此项目的需求文档，你需要分析并上传。',
  '这是当前项目的需求文档，你需要分析并上传。',
  '这是本次项目的需求文档，你需要分析并上传。',
  '这是项目的需求文档，你需要分析并上传。',
];

test('generic project references resolve to the bound project instead of clarifying', () => {
  for (const text of generic) {
    const result = resolveHumanProject({ text, projects, currentProjectId: current });
    assert.deepEqual(
      { kind: result.kind, projectId: result.projectId },
      { kind: 'resolved', projectId: current },
      `expected the bound project for: ${text}`
    );
  }
});

test('generic project references still work through the full attachment interpretation', () => {
  const result = interpretAttachmentRequest({
    text: '@南航数字人POC-双人协作测试需求-v2.md 这是整个项目的需求文档，你需要分析并上传。',
    projects,
    currentProjectId: current,
  });
  assert.equal(result.kind, 'read');
  assert.equal(result.projectId, current);
  assert.equal(result.archiveAuthorized, false);
});

test('a stated name that matches no trusted label is still clarified', () => {
  // The loosening must not become "accept anything": an unresolved explicit name is data.
  for (const text of [
    '这是南航数字人POC的需求文档，你需要分析并上传。',
    '这是财务系统的需求文档，你需要分析并上传。',
  ]) {
    const result = resolveHumanProject({ text, projects, currentProjectId: current });
    assert.equal(result.kind, 'clarify');
    assert.equal(result.reason, 'unresolved-stated-project');
  }
});

test('exact trusted names and keys still resolve', () => {
  for (const text of [
    '这是南航智慧出行数字人POC2的需求文档，你需要分析并上传。',
    '这是NHMHPOC02的需求文档，你需要分析并上传。',
  ]) {
    const result = resolveHumanProject({ text, projects, currentProjectId: current });
    assert.equal(result.kind, 'resolved');
    assert.equal(result.projectId, current);
  }
});

test('naming a different real project still refuses to hijack the bound session', () => {
  const result = resolveHumanProject({
    text: '这是另一个真实项目的需求文档，你需要分析并上传。',
    projects,
    currentProjectId: current,
  });
  assert.equal(result.kind, 'clarify');
  assert.equal(result.reason, 'bound-project-conflict');
});

test('upload-plus-archive phrasings are admitted, while upload alone still authorizes nothing', () => {
  // Live incident: "上传归档为项目资料" and "上传并归档" fell through to missing-intent and the
  // member was asked to choose an action they had already stated.
  for (const text of [
    '上传归档为项目资料',
    '归档为项目资料',
    '上传并归档为项目资料',
    '上传并归档这份资料',
    '请上传并归档这份资料',
    '@需求-v2.md 上传归档为项目资料',
    '@需求-v2.md 上传并归档',
  ]) {
    assert.equal(classifyHumanIntent(text).kind, 'archive', 'expected archive for: ' + text);
  }
  // 上传 on its own is only a transfer; it must never become archive authority.
  for (const text of ['上传', '上传这份文件', '重新上传']) {
    assert.equal(classifyHumanIntent(text).kind, 'clarify', 'upload alone must clarify: ' + text);
  }
  // A refusal that mentions both verbs still refuses.
  assert.equal(classifyHumanIntent('只阅读，不要上传并归档').kind, 'clarify');
  assert.equal(classifyHumanIntent('不要把这份文件归档，也不要上传').kind, 'clarify');
});
