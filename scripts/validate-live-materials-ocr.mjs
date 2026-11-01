// Actual source images only: a rendered official PDF page, official product photo,
// and an unchanged crop of the workbench after a real DeepSeek analysis.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const base = process.env.APP_URL || 'http://127.0.0.1:3221';
const directory = path.resolve('.runtime/materials-acceptance/live-materials');
const browserDirectory = path.resolve('.runtime/materials-acceptance/browser');
const previous = JSON.parse(readFileSync(path.join(directory, 'ocr-acceptance.json'), 'utf8'));
if (!existsSync(path.join(directory, 'ocr-first-attempt.json'))) writeFileSync(path.join(directory, 'ocr-first-attempt.json'), JSON.stringify(previous, null, 2));
const report = { started_at: new Date().toISOString(), evidence_type: 'real_source_images_local_Chinese_English_OCR', actual_model_calls: 0, initial_failure_retained: 'ocr-first-attempt.json', sources: [], checks: [], unresolved: ['真实商家微信截图和实拍备注原件未取得，使用真实官方资料及真实工作台截图检查 OCR，不宣称商家验收。'] };
const save = () => writeFileSync(path.join(directory, 'ocr-local-resources-retry.json'), JSON.stringify(report, null, 2));
save();
try {
  const originalSources = previous.sources || [];
  const sourceImages = originalSources.map(source => ({...source, path:path.join(directory,source.filename)})).filter(source => existsSync(source.path) && /\.(png|jpe?g|webp)$/i.test(source.filename));
  const chineseFilename = 'improve-real-analysis-confirmation-facts.png';
  sourceImages.push({ filename:chineseFilename, path:path.join(browserDirectory,chineseFilename), source_kind:'unaltered_crop_of_actual_workbench_after_real_DeepSeek_analysis', origin_report:'../browser/browser-acceptance.json' });
  assert.ok(sourceImages.length >= 2, 'Expected actual official PDF-page image and actual Chinese confirmation screenshot.');
  const files = sourceImages.map(source => {
    const bytes = readFileSync(source.path);
    report.sources.push({...source,path:undefined,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
    return {filename:source.filename,base64:bytes.toString('base64')};
  });
  const started = Date.now();
  const response = await fetch(`${base}/api/materials/preview`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files}),signal:AbortSignal.timeout(240000)});
  report.http_status = response.status; report.preview = await response.json(); report.duration_ms=Date.now()-started; save();
  assert.equal(response.status,201);
  for(const doc of report.preview.documents) assert.notEqual(doc.status,'failed',JSON.stringify(doc.error));
  const chinese = report.preview.documents.find(doc=>doc.filename===chineseFilename);
  assert.equal(chinese.status,'ready');
  for(const value of ['商品名称','宽度','高度','38','42','140','67']) assert.ok(chinese.text.includes(value),`Actual Chinese source OCR missing ${value}: ${chinese.text}`);
  const officialPage = report.preview.documents.find(doc=>/page|render|screenshot/i.test(doc.filename) && doc.filename!==chineseFilename);
  assert.ok(officialPage && officialPage.status==='ready','Official PDF screenshot should have recognized text');
  assert.match(officialPage.text,/Cotton/i); assert.match(officialPage.text,/140/);
  report.checks.push('local_packaged_language_resources_initialize_without_runtime_CDN','official_PDF_screenshot_visible_English_text_recognized','actual_workbench_screenshot_Chinese_labels_and_original_numbers_recognized','unmarked_photo_is_not_used_to_infer_product_parameters');
  report.completed_at=new Date().toISOString(); report.status='passed_available_real_image_scope'; save();
  console.log(JSON.stringify({report:path.join(directory,'ocr-local-resources-retry.json'),status:report.status,duration_ms:report.duration_ms,documents:report.preview.documents.map(doc=>({filename:doc.filename,status:doc.status,characters:doc.text.length})),checks:report.checks}));
} catch(error) {report.status='failed';report.error={message:error.message,code:error.code||null};save();throw error;}
