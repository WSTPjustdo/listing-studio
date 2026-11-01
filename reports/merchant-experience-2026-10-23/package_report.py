from pathlib import Path
import hashlib, json, re, zipfile
from pypdf import PdfReader

D=Path(__file__).resolve().parent; ROOT=D.parents[1]; OUT=ROOT/'output'/'pdf'
pdf=OUT/'亚马逊商家工作台真实体验报告.pdf'
zpath=OUT/'商家体验报告-分享包.zip'
assert len(PdfReader(str(pdf)).pages)==11
v=json.loads((D/'versions.json').read_text(encoding='utf-8'))
assert len(v)==2 and all(x['trace']['actual_model_call'] for x in v)
assert v[0]['product_snapshot']==v[1]['product_snapshot']
assert len(v[0]['review']['issues'])==5 and not v[1]['review']['issues']
assert len(v[1]['review']['missing_data'])==2
copy=(D/'listing-v2-customer-copy.txt').read_text(encoding='utf-8')
assert v[1]['content']['title'] in copy and '内部审阅说明' not in copy
assert json.loads((D/'download.json').read_text(encoding='utf-8'))['failure'] is None
readme='''# 亚马逊商家工作台真实体验报告

日期：2026-10-23（Asia/Shanghai）。主测商品：DALIX，Amazon ASIN B0732NPDRB。

## 阅读顺序

1. 亚马逊商家工作台真实体验报告.pdf：11页完整过程、截图、实际英文提示词与修改结果、体验建议。
2. evidence/listing-v2-customer-copy.txt：实际从页面下载的纯英文V2草稿。
3. evidence/listing-v1.txt / listing-v2.txt：两版文案及内部审阅说明。
4. evidence/versions.json 与 model-call-ledger.json：原始版本与4次真实调用证据。
5. evidence/screenshots/：本轮截图和页面文本；只包括已检查的画面及对应文本。

## 结果与边界

- 完成真实Amazon导入、人工补录材质、真实DeepSeek生成、英文指令修改、复检、版本比较和导出。
- V1五处发现来自同一个22英寸参数证据缺口；V2删去未确认表达后零发现，仍有颜色和零售包装待确认。
- 4次 deepseek-flash 调用，合计20,795 tokens；调用耗时合计13.790秒。实际费用未知。
- 没有用户自有Seller SKU；没有发布或登记为已上架；未连接Seller Central。
- 这是AI代理以商家任务为视角的操作体验，不是真实商家访谈或转化效果实验。
- sources-and-prompts.md是前期来源调研及备选提示词；实际提交内容以prompt-v1.txt、prompt-v2.txt和版本instruction为准。
- 调用间发生代理审批服务额度中断；下载自动化曾误用按钮定位导致监听超时，改用真实链接后下载成功。均不记为工作台/DeepSeek故障。

## 交付核验

- PDF已逐页渲染检查；11页，中文字体已嵌入，来源链接可点击。
- 两版使用同一商品资料快照；纯英文下载不含内部审阅说明。
- 工作台应用源码没有修改。新增内容仅在报告、输出、临时检查目录及本机运行数据中。
- 分享包使用明确文件清单；不包含.runtime、.env、数据库、密钥、浏览器资料、缓存或node_modules。
- MANIFEST.sha256校验包内文件；外部SHA256SUMS.txt校验PDF和分享ZIP。

本次只交付体验报告，没有重新发布工作台程序，因此不替换原工作台应用分享包。
'''
(D/'README.md').write_text(readme,encoding='utf-8')
names=['README.md','sources-and-prompts.md','prompt-v1.txt','prompt-v2.txt','listing-v1.txt','listing-v2.txt','listing-v1.json','listing-v2.json','listing-v2-customer-copy.txt','versions.json','current-runs.json','model-call-ledger.json','import-responses.json','edit-material-responses.json','create-responses.json','revise-responses.json','download.json']
files=[(pdf,pdf.name)]
for n in names:files.append((D/n,n if n=='README.md' else 'evidence/'+n))
for n in ['01-home','03-product','08-resumed-v1','09-improved-prompt','10-final-editor','12-export-menu','13-final-review','14-diff-detail']:
 for ext in ['png','txt']:files.append((D/'screenshots'/f'{n}.{ext}','evidence/screenshots/'+f'{n}.{ext}'))
for n in ['04-edit-facts.txt','05-saved-facts.txt','11-version-diff.txt']:
 files.append((D/'screenshots'/n,'evidence/screenshots/'+n))
for p,n in files:
 assert p.exists(),n
 assert not any(part in {'.runtime','.env','node_modules','cache'} for part in Path(n).parts)
 if p.suffix in {'.json','.txt','.md'}:
  text=p.read_text(encoding='utf-8')
  assert not re.search(r'sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_-]{20,}|"api_key"\s*:',text),f'Potential secret in {n}'
manifest='\n'.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+n for p,n in files)+'\n'
(D/'MANIFEST.sha256').write_text(manifest,encoding='utf-8')
with zipfile.ZipFile(zpath,'w',zipfile.ZIP_DEFLATED) as z:
 for p,n in files:z.write(p,n)
 z.writestr('MANIFEST.sha256',manifest)
with zipfile.ZipFile(zpath) as z:assert z.testzip() is None
checks='\n'.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name for p in [pdf,zpath])+'\n'
(OUT/'SHA256SUMS.txt').write_text(checks,encoding='utf-8')
print(json.dumps({'pdf_pages':11,'zip_files':len(files)+1,'zip_bytes':zpath.stat().st_size,'secrets_scan':'passed','versions_and_download':'passed'},ensure_ascii=False))
