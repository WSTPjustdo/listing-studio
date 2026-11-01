from pathlib import Path
import json, html, hashlib, zipfile
from datetime import datetime, timezone, timedelta
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Table, TableStyle
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
D=Path(__file__).resolve().parent
OUT=ROOT/'output'/'pdf'; OUT.mkdir(parents=True,exist_ok=True)
PDF=OUT/'亚马逊商家工作台真实体验报告.pdf'
V=json.loads((D/'versions.json').read_text(encoding='utf-8'))
A,B=V
RUNS=json.loads((D/'current-runs.json').read_text(encoding='utf-8'))
pdfmetrics.registerFont(TTFont('CN','C:/Windows/Fonts/simhei.ttf'))
pdfmetrics.registerFont(TTFont('EN','C:/Windows/Fonts/segoeui.ttf'))
pdfmetrics.registerFont(TTFont('ENB','C:/Windows/Fonts/segoeuib.ttf'))
W,H=595.276,841.89; M=44; CW=W-2*M
NAVY=colors.HexColor('#132B46'); BLUE=colors.HexColor('#0866DD'); GRAY=colors.HexColor('#526274'); LIGHT=colors.HexColor('#EEF4FC')
C=canvas.Canvas(str(PDF),pagesize=(W,H)); C.setTitle('Listing Studio 亚马逊商家真实体验报告'); C.setAuthor('Codex 商家视角体验')
page_num=0; y=0
def esc(s): return html.escape(str(s)).replace('\n','<br/>')
def page(title,kicker):
 global page_num,y
 if page_num: C.showPage()
 page_num+=1; C.setFillColor(BLUE); C.rect(M,H-48,22,4,fill=1,stroke=0)
 C.setFont('ENB',8); C.setFillColor(GRAY); C.drawString(M+32,H-48,'LISTING STUDIO  /  MERCHANT EXPERIENCE')
 C.setFont('CN',22); C.setFillColor(NAVY); C.drawString(M,H-90,title)
 C.setFont('CN',9); C.setFillColor(GRAY); C.drawString(M,H-111,kicker)
 C.setStrokeColor(colors.HexColor('#DBE3ED')); C.line(M,44,W-M,44)
 C.setFont('CN',8); C.drawString(M,29,'2026-10-23 · Asia/Shanghai · 真实商品 / 真实模型 / 未上架')
 C.setFont('EN',8); C.drawRightString(W-M,29,f'{page_num:02d} / 11')
 y=H-138
def p(s,size=10.3,leading=16,color=NAVY,font='CN',gap=9,x=M,width=CW):
 global y
 style=ParagraphStyle('p',fontName=font,fontSize=size,leading=leading,textColor=color,wordWrap='CJK' if font=='CN' else None)
 q=Paragraph(s,style); _,h=q.wrap(width,1000)
 if y-h<58: raise RuntimeError(f'Page {page_num} overflow {y-h}: {s[:50]}')
 q.drawOn(C,x,y-h);y-=h+gap
def h(s): p(esc(s),13,18,BLUE,gap=7)
def gap(n=8):
 global y;y-=n
def table(rows,widths=None,size=9.3):
 global y
 if widths is None: widths=[CW/len(rows[0])]*len(rows[0])
 data=[]
 for i,row in enumerate(rows):
  data.append([Paragraph(esc(cell),ParagraphStyle('cell',fontName='CN',fontSize=size,leading=size*1.5,textColor=colors.white if i==0 else NAVY,wordWrap='CJK')) for cell in row])
 t=Table(data,colWidths=widths,hAlign='LEFT');t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),('ROWBACKGROUNDS',(0,1),(-1,-1),[LIGHT,colors.white]),('LINEBELOW',(0,1),(-1,-1),.4,colors.HexColor('#D9E3EF'))]))
 _,hh=t.wrap(CW,1000)
 if y-hh<58:raise RuntimeError(f'Table overflow page{page_num}')
 t.drawOn(C,M,y-hh);y-=hh+12
def shot(name,caption,maxh=300,crop=None):
 global y
 src=D/'screenshots'/name; im=Image.open(src)
 if crop:
  im=im.crop(crop); target=ROOT/'tmp'/'pdfs'/('crop-'+name);im.save(target);src=target
 iw,ih=im.size; scale=min(CW/iw,maxh/ih);dw,dh=iw*scale,ih*scale
 if y-dh-30<58:raise RuntimeError(f'Image overflow page {page_num}')
 C.drawImage(str(src),M+(CW-dw)/2,y-dh,dw,dh);y-=dh+6
 p(esc(caption),8.3,12,GRAY,gap=11)
def en(s,size=10,gap=9):p(esc(s),size,size*1.5,font='EN',gap=gap)
def local(t):return datetime.fromisoformat(t.replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8))).strftime('%H:%M:%S')

page('没有 SKU，也能走到英文草稿','商家视角全过程体验报告 · Amazon US · DALIX B0732NPDRB')
p('结论：能完成真实商品导入、英文生成、提示词修改、复检与导出。当前更适合有人工核对的内部内容工作流；这次结果仍不是可直接上架的完整商品资料。',13,21,gap=15)
table([['真实商品','真实模型调用','审核变化'],['1 个 Amazon ASIN','4 次 deepseek-flash','5 处发现 → 0 处发现'],['没有自有 Seller SKU','2 个文案版本，均保存','仍有 2 项资料待确认']],size=10)
shot('13-final-review.png','图 1｜最终 V2：已执行检查未发现问题，同时保留颜色、零售包装待确认。',270,crop=(560,110,1390,720))
h('从商家角度的感受')
p('最有帮助的是看到“哪里缺依据”以及修改前后的差别。最费力的是导入后还要自己补资料：链接能读到，并不代表已经提取出足够的卖点。')
p('本次体验者是 AI 代理，以无现成 SKU 商家的任务为视角操作，并非招募到的真实商家访谈。未修改工作台应用代码；仅新增体验记录、报告与本次商品/文案数据。',9.4,15,GRAY)

page('01 真实商品与来源核验','先找到公开商品，再区分网页披露、已入档事实和未知项')
p('选用 DALIX 22-inch Cotton Canvas Zippered Tote。公开 Amazon 页面关联 ASIN B0732NPDRB，调研快照显示 Natural 变体；本轮实时导入未取得颜色，所以工作台继续保持颜色未知。')
table([['来源','本次获取方式与时效'],['Amazon.com / B0732NPDRB','工作台 direct_http 实时读取：21:25:29；取得标题、品牌与 In Stock 文字。另一个网页调研通道返回约四周前抓取快照。'],['DALIX 品牌官网','浏览工具显示当天抓取；用于交叉核对材质与其他公开规格。网页最后更新时间未知。']],[140,CW-140])
h('可核对的事实，不全部等于已入档事实')
table([['项目','来源所示','本次工作台处理'],['品牌 / 拉链','DALIX / 顶部拉链','品牌成功导入；拉链来自导入标题'],['材质','官网：100% cotton canvas','人工填写，保存商品资料 V2'],['尺寸 / 面料','22 × 16 × 6 inches / 12 oz','未填入结构化字段；12 oz 不当容量'],['外袋 / 颜色','外置开口袋 / Natural','未作为本轮模型可用事实'],['提手落差','官网 9 inches；Amazon 11 inches','来源冲突，不选择任何一个值']], [90,185,CW-275],9)
p('Amazon 表格中的 Capacity: 12 ounces 不能可靠证明容积；官网默认变体为 Pink，不能混入本次 ASIN。没有取得商家 SKU、供货授权、承重证明、认证或 Seller Central 上架证据。',9.3,15)
p('来源链接：<br/><link href="https://www.amazon.com/dp/B0732NPDRB" color="#0866DD">Amazon 商品页 · B0732NPDRB</link><br/><link href="https://www.dalix.com/products/heavy-duty-cotton-canvas-tote-bag" color="#0866DD">DALIX 官方产品页 · Heavy Duty Cotton Canvas Tote Bag</link>',9.5,16)

page('02 从入口到商品资料','步骤 1-3 · 来源可查，导入成功，但核心参数缺失')
table([['步骤','实际操作','体验状态'],['1 找商品','核对 Amazon ASIN 与官网','可完成；遇到来源差异'],['2 导入','在首页粘贴 Amazon 链接','成功；HTTP 200，mode=live'],['3 确认资料','打开商品资料，核查空字段','信息不足，需要人工补充']],[70,265,CW-335])
shot('03-product.png','图 2｜导入后的真实商品资料：品牌已取得，材质、尺寸等仍显示未知或待补。',385,crop=(560,448,1405,1225))
p('商家感受：我不需要先编造 SKU 就能建立草稿，这是顺畅的；但“资料已导入”容易让人以为准备好了。8 个主要展示字段中仅品牌有值，其他 7 项仍空缺，下一步该补什么需要自己判断。',9.8,16)
p('首页的 Amazon 导入区位于创建/审核大卡片下方，1440 × 1000 视口中接近底部。对没有资料的新商家，这个入口比“创建英文 Listing”更晚被看到。证据：01-home.png。',9.1,14,GRAY)

page('03 补材质，生成第一版','步骤 4 · 使用已配置的 DeepSeek，生成与独立审阅共 2 次调用')
p('我在“编辑资料”填入官网明确披露的 100% cotton canvas，保存为商品资料 V2。其余数字、颜色与包装仍空缺。界面将该修改标记为“商家确认”；应用内引用为 LOCAL-MERCHANT-INPUT，本报告另保留官网链接。')
h('实际提交的基础英文提示词')
en(A['instruction'],10.2)
table([['V1 输出 / 审核','本次结果'],['生成保存时间',local(A['created_at'])+'（北京时间）'],['标题',A['content']['title']],['完成检查','13/13 项；5 处 EVID-01 参数证据发现'],['资料缺口','颜色、零售包装；正式上架状态 not_verified']],[122,CW-122])
h('为什么出现 5 处问题')
p('模型从导入标题沿用 22 英寸，将它写入标题、亮点、第三条要点及描述的两句话。但结构化尺寸仍为空，程序无法把数值关联到对应参数。这 5 处来自同一个证据缺口，不能理解成 5 个不同商品错误。')
en(A['content']['bullet_points'][2]['text'],10)
p('模型语义审阅认为尺寸有商品页支持，程序却仍提示参数待核。两者共同暴露了“标题里存在”与“参数已结构化确认”的差别。商家需要看到统一解释。',10,16)
p('本轮没有用缺失资料去捏造完整规格，也没有把网页中的 In Stock 文字写成用户自己的库存或已上架状态。',9.5,15,GRAY)

page('04 用英文指令修改整份文案','步骤 5 · 相同商品资料 V2，调整指令后保存文案 V2')
p('进入“继续调整这份文案”，选择“整份文案”。改进重点：限定可用事实，明确禁止项，缩短标题和描述，把缺失信息留在内部审核。以下为实际提交指令。',10,16)
en(B['instruction'],10.1,gap=14)
h('交互体验')
p('长提示词可以提交成功，但输入框是单行，屏幕只能看到局部文字；写复杂约束时不容易复核。提交后，版本页完整保留了指令，能追溯这次修改的依据。')
shot('09-improved-prompt.png','图 3｜真实提交前的单行输入框：只能看到长指令的结尾，复核成本较高。',78,crop=(560,900,1390,1000))
p('注意：这里修改的是本次任务的英文指令，并没有改应用系统提示词或任何应用代码。标题少于 100 字符、描述少于 70 词是本次编辑目标，不是对 Amazon 最新平台限制的声明。',9.5,15,GRAY)

page('05 修改到底改善了什么','步骤 6 · 版本对比与复检；风险收敛，但卖点仍偏薄')
table([['观察项','V1','V2'],['标题字符数',str(len(A['content']['title'])),str(len(B['content']['title']))],['描述词数（空白分词）',str(len(A['content']['description'].split())),str(len(B['content']['description'].split()))],['已发现内容问题','5 处','0 处'],['待补资料','2 项','2 项'],['正式上架准备状态','未验证','未验证']],[205,151,CW-356])
h('标题')
en('Before: '+A['content']['title'],10)
en('After: '+B['content']['title'],10)
h('描述')
en('Before: '+A['content']['description'],9.6)
en('After: '+B['content']['description'],9.6)
h('质量判断')
p('改善成立：删除 22 英寸、Heavy Duty、sturdy 和 roomy 等本轮不采用的表达，标题缩短，描述更直接，5 处参数问题未再检出。',10,16)
p('不足仍在：五点中的材质、品牌和拉链信息重复；“打开拉链放入物品，再拉上”这类说明价值有限。五点形式达成，但“各有独立卖点”的目标只部分达成。少事实时，提示词不能替代补充商品资料。',10,16)
p('这是一条商品、一次修改的观察，没有 A/B 流量、点击率、转化率或真实商家效率对照；不能据此声称销量提升。',9.3,15,GRAY)

page('06 最终英文文案实录','真实 DeepSeek V2 输出 · 作为待运营确认的内部草稿')
h('Product title')
en(B['content']['title'],13)
h('Item highlights')
en(B['content']['item_highlights'],10.5)
h('Five bullet points')
for i,b in enumerate(B['content']['bullet_points'],1): en(f'{i}. '+b['text'],10.5,gap=12)
h('Description')
en(B['content']['description'],10.5,gap=18)
table([['已保留','仍未确认'],['DALIX 品牌、棉帆布材质、顶部拉链；英文正文与内部说明可分别导出。','颜色、零售包装、结构化尺寸、面料克重、容量、提手等；SKU、供货权限和上架状态未取得。']],size=10)
p('工作台只将颜色和零售包装列入当前“待补资料”计数；这个数字不是所有未知商品信息的完整清单。删除尺寸后不再触发数值检查，也不意味着尺寸已经核验。',9.8,16)

page('07 版本留存与导出','步骤 7 · 页面下载成功；交付仍清楚标记为草稿')
shot('12-export-menu.png','图 4｜稳定状态下的导出弹窗。支持纯英文、带审核说明、JSON 与 HTML。',360,crop=(460,183,980,818))
p('通过界面“仅英文文案”链接下载成功，下载记录 failure=null；另通过同一工作台导出接口保存 V1/V2 的 TXT 与 JSON。纯英文文件没有内部审核段落，两版完整结构化记录均保留真实调用信息。',10,16)
table([['检查项','本次结果'],['版本留存','同一 listing_id，V1 与 V2 均可读取；商品快照均为资料 V2。'],['差异查看','标题、亮点、五点和描述逐字段展示修改前后。'],['导出提醒','0 项内容风险，2 项资料待补；明确导出不代表 Amazon 上架审核通过。'],['发布','没有连接 Seller Central，没有发布或手动登记已上架。']],[100,CW-100],9.2)
p('证据：11-version-diff.txt、14-diff-detail.png、download.json、listing-v2-customer-copy.txt。',8.7,13,GRAY)

page('08 按商家任务排序的改进建议','只提出建议，本次不实施代码修改')
table([['优先级 / 发现','证据与影响','建议'],['P1 导入成功但信息不足','图 2；只得到标题、品牌与页面状态，7 个展示项仍空。','显示已提取/缺失字段摘要，明确下一步补资料。'],['P1 来源与确认断开','手填材质仅关联商家输入，官网链接没有随该字段保存。','编辑参数时关联来源链接、原文、适用变体。'],['P1 相同尺寸出现两种判断','V1 模型认为有页面支持，程序有5处证据待核。','统一解释来源、结构化字段及冲突；将同因问题合并处理。'],['P1 零发现易被理解为完成','V2仍缺颜色包装；更多参数未进入缺失计数。','区分文案风险、资料完整度、上架准备三种状态。'],['P2 五点结构带来重复','V2第1/4条重复材质品牌，第2/5条重复拉链。','资料少时提示卖点不足，先补事实再丰富表达。'],['P2 长指令不易复核','图3：单行输入，只见尾部；版本页才显示全文。','提供多行编辑、提交前预览和可复用模板。'],['P2 新商家入口与辅助体验','首页导入入口靠下；较小浅灰说明需放大阅读。','提高无资料入口；再测对比度、缩放与键盘流程。']],[111,200,CW-311],9)
h('保留的优点')
p('不要求虚构 Seller SKU；缺失值继续显示未知；真实调用、独立复检、版本差异和纯英文导出形成闭环。最终状态没有因为“0 处发现”自动变成“已上架”。',10,16)
p('可访问性边界：本轮只观察桌面截图与可操作控件；未进行屏幕阅读器、完整键盘导航、移动端、200% 缩放或色彩对比度测量，不能声明 WCAG 合规。',9.5,15,GRAY)

page('09 真实调用台账与体验边界','以每次 trace.calls 为用量口径，避免只统计最后一次审阅')
calls=[]
for v in V:
 for j,c in enumerate(v['trace']['calls']):calls.append((v['version'],'生成' if v['version']==1 and j==0 else '改写' if j==0 else '独立审阅',c))
table([['阶段','耗时','输入 tokens','输出 tokens','合计']]+[[f'V{v} {stage}',f"{c['elapsed_ms']/1000:.3f}s",str(c['usage']['prompt_tokens']),str(c['usage']['completion_tokens']),str(c['usage']['total_tokens'])] for v,stage,c in calls],[100,75,110,110,CW-395],9.1)
total=sum(c['usage']['total_tokens'] for _,_,c in calls);sec=sum(c['elapsed_ms'] for _,_,c in calls)/1000
p(f'全部 4 次调用模型：deepseek-flash；actual_model_call=true。累计 {total:,} tokens，模型调用耗时合计 {sec:.3f} 秒。实际费用未取得，不自行估算。',10.5,17)
h('服务商请求 ID')
for v,stage,c in calls:
 p(f'V{v} {stage}',9.7,14,BLUE,gap=3);en(c['provider_request_id'],9,gap=9)
h('本次时间与中断')
p(f'商品导入：21:25:29；V1 保存：{local(A["created_at"])}；V2 保存：{local(B["created_at"])}；页面下载：23:20:38。均为 2026-10-23 北京时间。',9.7,15)
p('中间因代理自动审批服务额度不足而暂停，用户要求继续后恢复浏览器和工作台。这属于体验执行环境中断，不是 DeepSeek 失败；不能把本轮总历时当成商家操作耗时或模型响应时间。',9.7,15)
p('截图自动化另有一次下载监听超时：最初把下载链接识别成按钮，修正定位后真实下载成功。该异常属于体验脚本问题，不归为工作台下载故障。',9.3,15,GRAY)

page('10 交付、证据索引与下一步','本报告及证据包可独立审阅；不包含凭据或本机数据库')
h('此次完成的流程')
table([['步骤','结果','证据'],['1 查找公开商品','完成，来源冲突保留','来源文档 / 第2页'],['2 Amazon 导入','真实读取成功，信息不足','import-responses.json / 图2'],['3 补充材质','人工确认，商品资料升至V2','edit-material-responses.json'],['4 生成英文 V1','2次真实调用；5处待处理','listing-v1.json'],['5 改进英文提示词','整份改写完成，保留指令','prompt-v2.txt'],['6 复检与版本对比','V2零发现，仍待资料核验','versions.json / 图1'],['7 导出','页面下载和接口导出成功','download.json / 图4']],[112,188,CW-300],9.1)
h('可直接复用的交付物')
p('PDF 报告、V1/V2 英文及审核记录、纯英文 V2、实际提示词、4次调用台账、来源说明、关键截图、README 与 SHA-256 校验随分享 ZIP 提供。分享包不含 .runtime、.env、数据库、密钥、缓存或浏览器个人资料。',10,16)
h('下一步应验证的商家问题')
p('优先补齐与当前变体对应的尺寸、颜色、零售件数和外袋资料，并把来源关联到字段；再判断是否值得将具体卖点加入英文文案。提示词只能控制表达，不能证明产品事实。',10,16)
p('本次未覆盖：批量任务、采购补证闭环、多商家试用、发布权限、Seller Central 发布、转化效果和视觉识别。没有以旧自动测试或模拟结果替代本轮验收。',9.6,15,GRAY)
p('公开来源：<link href="https://www.amazon.com/dp/B0732NPDRB" color="#0866DD">Amazon 商品页</link> · <link href="https://www.dalix.com/products/heavy-duty-cotton-canvas-tote-bag" color="#0866DD">DALIX 品牌官网</link>。<br/>网页事实与工作台已入档事实的差别见第 2-4 页；未取得的信息均保留未知。',9.4,15)
C.save()

audit={'model':'deepseek-flash','total_tokens':total,'total_model_elapsed_ms':round(sec*1000),'calls':[{'version':v,'stage':stage,**c} for v,stage,c in calls],'listing_id':B['listing_id'],'publication_readiness':B['review']['publication_readiness'],'app_code_changed':False}
(D/'model-call-ledger.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8')
(D/'prompt-v1.txt').write_text(A['instruction'],encoding='utf-8')
(D/'prompt-v2.txt').write_text(B['instruction'],encoding='utf-8')
print(json.dumps({'pdf':str(PDF),'pages':page_num,'tokens':total,'model_seconds':sec},ensure_ascii=False))
