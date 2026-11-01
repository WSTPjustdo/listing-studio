import test from 'node:test';
import assert from 'node:assert/strict';
import { localItem } from '../server/local-amazon.mjs';
import { normalizeCompetitor, compareCandidate, comparisonSchema } from '../server/research.mjs';
test('local data retains source fields and unverified region cannot qualify by price', () => {
 const item=normalizeCompetitor(localItem({data:{title:'Cotton tote',bullets:['Cotton canvas'],details:{fabric_type:'Cotton',number_of_packs:'30'},price:{amount:10,currency:'USD'},rating:{average:4.4}},delivery:{verified:false,visible_delivery_location:'China'},missing_fields:[]},'B0819W9CSW'));
 assert.equal(item.bullets.length,1); assert.equal(item.rating,4.4); assert.equal(item.specifications[1].value,'30');
 const criteria=comparisonSchema.parse({target_price:10,required_terms:['cotton']});
 assert.equal(compareCandidate(item,criteria).price_fits,null);
 assert.equal(compareCandidate({...item,delivery:{verified:true}},criteria).status,'potential');
 assert.equal(compareCandidate({...item,delivery:{verified:true},detail_status:'failed'},criteria).price_fits,null);
});
import { analyzeProduct } from '../server/research.mjs';
test('plain merchant text works without vision and never becomes image-derived facts', async () => {
 // 服务端现在要求"文字提取必须走真实兼容模型"（MISSING_TEXT_MODEL），没有本地整理兜底。
 // 这条用例原本验的是"没有视觉能力也能提文字、且图片猜测不能混进 facts"，
 // 与"模型调用要花钱"无关，所以喂一个本地假响应：走完整真实请求路径，只是上游是假的。
 // 假上游返回里故意塞一条 evidence 不在原文里的 fact，验它会被剔除（这是这条用例的真意图）。
 const payload = {
  name: 'Cotton Tote Bag', category: '棉布手提袋', search_query: 'cotton tote bag',
  observations: [],
  facts: [
   { label: '材质', value: '100% cotton', source: 'merchant_text', evidence: 'Material: 100% cotton' },
   { label: '尺寸', value: '15 x 16 inches', source: 'merchant_text', evidence: '15 x 16 inches' },
  ],
  missing: [],
 };
 const seen = [];
 const fakeModel = async (url, options) => {
  seen.push({ url, auth: options.headers?.Authorization, body: JSON.parse(options.body) });
  return new Response(JSON.stringify({ id: 'fake-text-1', model: 'fake-text-1',
   choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }), { status: 200 });
 };
 const config = { text_model_config: { provider: 'compatible', base_url: 'http://127.0.0.1:1/v1', model: 'fake-text-1', api_key: 'local-fake' } };
 const result = await analyzeProduct(config, { text: 'Material: 100% cotton\n15 x 16 inches' }, fakeModel);
 assert.equal(result.facts.length, 2);
 assert.equal(result.facts[0].source, 'merchant_text');
 assert.equal(result.facts[0].evidence, 'Material: 100% cotton');
 assert.deepEqual(result.observations, []);
 assert.equal(seen.length, 1);
 assert.match(seen[0].url, /\/chat\/completions$/);
 assert.equal(seen[0].auth, 'Bearer local-fake');
 // 假上游必须自报家门，别让日志看起来像真的调过 DeepSeek。
 assert.equal(result.trace.model, 'fake-text-1');
});

test('text extraction refuses to run without a configured compatible model', async () => {
 // 另一半：没配模型时必须明确失败，不许退回本地规则拼一份"看起来像模型提取"的结果。
 await assert.rejects(
  () => analyzeProduct({ text_model_config: { provider: 'demo', base_url: '', model: '', api_key: '' } },
   { text: 'Material: 100% cotton' }),
  { code: 'MISSING_TEXT_MODEL' },
 );
});
test('conflicting pack values remain visible and cannot qualify by price', () => {
 const item=normalizeCompetitor(localItem({data:{title:'Cotton tote Pack of 1',bullets:['Cotton'],details:{number_of_packs:'30'},price:{amount:10,currency:'USD'}},delivery:{verified:true}},'B0819W9CSW'));
 assert.equal(item.warnings.length,1);
 assert.equal(compareCandidate(item,comparisonSchema.parse({target_price:10,required_terms:['cotton']})).price_fits,null);
});
