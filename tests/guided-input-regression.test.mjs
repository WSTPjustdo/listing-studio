// Pure editing and validation regressions; these are not real product/model acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptMaterialText, guidedAnalysisFingerprint, guidedSelectionError } from '../src/guidedInput.ts';

const source = (preview_id, ...document_ids) => ({ preview_id, document_ids });
test('reapplying edited material replaces only its intact block and retains manual additions', () => {
  const first = adoptMaterialText('人工说明', '导入资料原文', source('preview-one', 'document-one'), null, null);
  const edited = first.text + '\n手工追加';
  const next = adoptMaterialText(edited, '导入资料更正', source('preview-one', 'document-one'), first.context, first.applied);
  assert.equal(next.text, '导入资料更正\n\n【补充说明】\n人工说明\n手工追加');
  assert.equal(next.context.corrected_text, next.text);
});
test('unchanged re-adoption preserves edits without duplicating imported text', () => {
  const first = adoptMaterialText('', '导入资料', source('one', 'doc'), null, null);
  const next = adoptMaterialText('手工改写过的资料', '导入资料', source('one', 'doc'), first.context, first.applied);
  assert.equal(next.text, '手工改写过的资料');
  assert.deepEqual(next.context.document_ids, ['doc']);
});
test('edited or ambiguous material blocks are retained when replacement cannot be isolated', () => {
  const first = adoptMaterialText('', '导入资料', source('one', 'doc'), null, null);
  for (const existing of ['手工改写过的资料', '导入资料\n导入资料']) {
    const next = adoptMaterialText(existing, '更正资料', source('one', 'doc'), first.context, first.applied);
    assert.equal(next.text, existing + '\n\n更正资料');
    assert.equal(next.preservedEditedBlock, true);
  }
});
test('new material batches keep prior text, manual notes and all source selections', () => {
  const first = adoptMaterialText('手工说明', '第一批资料', source('one', 'doc-one'), null, null);
  const second = adoptMaterialText(first.text + '\n补充', '第二批资料', source('two', 'doc-two'), first.context, first.applied);
  assert.ok(second.text.startsWith(first.text + '\n补充'));
  assert.ok(second.text.endsWith('第二批资料'));
  assert.deepEqual(second.context.additional_contexts, [source('one', 'doc-one')]);
  assert.deepEqual(second.context.document_ids, ['doc-two']);
});
test('replacement source selection removes only sources belonging to the replaced intact block', () => {
  const first = adoptMaterialText('', '第一批资料', source('one', 'doc-one'), null, null);
  const second = adoptMaterialText(first.text, '第二批资料', source('two', 'doc-two', 'doc-three'), first.context, first.applied);
  const next = adoptMaterialText(second.text, '第二批剩余资料', source('two', 'doc-three'), second.context, second.applied);
  assert.deepEqual(next.context.document_ids, ['doc-three']);
  assert.deepEqual(next.context.additional_contexts, [source('one', 'doc-one')]);
});
test('material accumulation rejects excess before altering existing text', () => {
  assert.throws(() => adoptMaterialText('a'.repeat(60000), 'more', source('one','doc'), null, null), /60,000/);
  assert.throws(() => adoptMaterialText('old', 'new', source('two','new-doc'), source('one', ...Array.from({length:12},(_,i) => 'doc-'+i)), null), /12/);
});
test('analysis reuse keys track source inputs and selected product revision independently from confirmation edits', () => {
  const input = { merchantText:'来源文字', reference:'', image:'', materialContext:null };
  const first = guidedAnalysisFingerprint(input);
  assert.equal(guidedAnalysisFingerprint({...input}), first);
  for (const changed of [{merchantText:'来源变更'}, {reference:'参考地址变更'}, {image:'图片变更'}, {materialContext:source('one','doc')}])
    assert.notEqual(guidedAnalysisFingerprint({...input,...changed}), first);
  const product = { product_id:'saved-record', revision:1 };
  assert.equal(guidedAnalysisFingerprint({...input, product}), guidedAnalysisFingerprint({...input, merchantText:'未采用文字', product}));
  assert.notEqual(guidedAnalysisFingerprint({...input, product}), guidedAnalysisFingerprint({...input, product:{...product,revision:2}}));
});
test('reference and term hard limits block before generation while exact maxima remain valid', () => {
  const references = Array.from({length:5}, (_,i) => 'reference-'+i);
  const terms = Array.from({length:60}, (_,i) => 'term-'+i);
  assert.equal(guidedSelectionError(true,references,terms), '');
  assert.match(guidedSelectionError(true,[...references,'sixth'],terms), /5/);
  assert.match(guidedSelectionError(false,[],[...terms,'extra']), /60/);
  assert.equal(guidedSelectionError(false,[],['a'.repeat(100)]), '');
  assert.match(guidedSelectionError(false,[],['a'.repeat(101)]), /100/);
  assert.match(guidedSelectionError(true,[],[]), /至少选择/);
});
