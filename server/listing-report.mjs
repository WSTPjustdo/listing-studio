import { auditContext } from './audit-context.mjs';
import { actionPlanSection, checksSection, escapeHtml as esc, identitySection, issueBasis, issueChangesSection, parameterSection, riskSummarySection, safeHref, unlinkedNotice, unmodeledSection, verdictSection, versionDiffSection } from './report.mjs';
import { trendSection } from './version-trend.mjs';
import { buildWorklist, worklistDocument, worklistSection } from './worklist.mjs';
import { charBudget, charBudgetSection } from './char-budget.mjs';
import { benchmarkSection, recordedBenchmarkScope } from './benchmark-section.mjs';
import { printFooter, reportShell, formatStamp } from './report-style.mjs';
import { citationForField } from './rules-doc.mjs';
import { PARTY_LABELS, summarizeParty } from './gpsr-parties.mjs';

/**
 * 商品档案里的 GPSR 责任方（第 9 轮新增的两个专门字段）。
 *
 * 为什么单列一屏：导出报告是给评委/商家拿在手上的那张纸，如果责任方只藏在
 * 「未完成检查」的一段长理由里，读者看不出「这份档案里到底填了谁」。
 * 但这一段只复述档案 + 逐项齐全度，**不给合规结论** —— 页面有没有展示本地看不到。
 */
export function gpsrPartiesSection(record) {
  const product = record.product_snapshot;
  const parties = [
    ['manufacturer', product?.manufacturer],
    ['eu_responsible', product?.eu_responsible],
  ].filter(([, fact]) => fact?.value);
  if (!parties.length) return '';
  const items = parties
    .map(([key, fact]) => {
      const value = fact.value;
      const address = [
        value.name,
        value.street,
        [value.postal_code, value.city].filter(Boolean).join(' '),
        value.country,
      ]
        .filter(Boolean)
        .join('，');
      return `<li><strong>${esc(PARTY_LABELS[key] || key)}</strong>：${esc(address || '未填')}${
        value.electronic_address ? ` · 电子地址 ${esc(value.electronic_address)}` : ''
      }<br><span class="muted">${esc(summarizeParty(value))}</span></li>`;
    })
    .join('');
  return `<h2>商品档案 · GPSR 责任方（本次快照）</h2><ul>${items}</ul><p class="muted">这些值来自商家档案，本地只核对「填了没有、写得像不像」，不核对公司是否存在、地址是否可达；报价页面上有没有展示，本工具看不到，仍需人工确认。电子地址只作档案记录 —— Amazon 详情页禁止出现邮箱，写进文案会被按阻断处理。</p>`;
}

export function factSourceExport(record) {
  const product = record.product_snapshot;
  const entries = [
    ...Object.entries(product?.fact_sources || {}).map(([field, source]) => ({ field, source })),
    ...(product?.additional_facts || []).filter(f => f.source).map(f => ({ field: f.label, source: f.source })),
  ];
  const material = product?.material_context;
  return [
    ...entries.map(({ field, source }) => `参数来源（商家关联，未独立核验）：${field}\n参数：${JSON.stringify(source.value)}\n来源：${source.publisher}；${source.url}\n适用型号：${source.applicable_model}\n原文：${source.excerpt}\n记录：${source.source_id}；${source.recorded_at}`),
    ...(material ? [
      `工厂原始材料（本机识别、商家确认，未独立核验）\n识别记录：${material.preview_id}；接收时间：${material.received_at}`,
      ...material.documents.map(doc => `文件：${doc.filename}\nSHA256：${doc.sha256}\n位置：${doc.segments.map(segment => segment.locator).join('、')}\n${doc.warnings.join('\n')}`),
      ...(material.correction_source ? ['本次采用了商家更正文字；原始识别内容与更正内容随商品版本保留。'] : []),
      ...(product.additional_facts || []).filter(fact => fact.source_refs?.length).map(fact => `参数：${fact.label}：${fact.value}\n材料位置：${fact.source_refs.map(ref => `${ref.filename} / ${ref.locator}`).join('；')}`),
    ] : []),
  ];
}

const contentText = content => [
  `Title\n${content.title}`, `Item Highlights\n${content.item_highlights}`,
  `Bullet Points\n${content.bullet_points.map(b => `• ${b.text}`).join('\n')}`,
  `Description\n${content.description}`,
].join('\n\n');

// Intake provenance describes submitted material, never verification of product facts.
export function intakeSourceText(record) {
  const intake = record.intake_context;
  const usage = record.keyword_usage || [];
  if (!intake && !usage.length) return '';
  const statuses = { retained: '仍有使用', removed: '本版未再出现，请核对移除原因', added: '本版新增使用', absent: '前后均未出现' };
  return [
    '导入材料与关键词',
    ...(intake ? [
      `材料角色：${intake.role === 'competitor_reference' ? '竞品参考，不能作为自家商品事实' : '自家待审初稿，尚需核对'}`,
      `来源工具：${intake.source_tool || '未提供'}`,
      `来源地址：${intake.source_url || '未提供'}`,
      `来源 ASIN：${intake.source_asin || '未提供'}`,
      `来源文件：${intake.source_filename || '未提供'}`,
      `本机接收时间：${intake.imported_at || '未记录'}；不代表来源独立核验时间。`,
      '本次已确认范围：Amazon 美国站棉布手提袋；来源与关键词不证明商品事实。',
    ] : []),
    ...usage.map(item => `词条：${item.term}；输入/前版 ${item.before_count} 处，本版 ${item.after_count} 处；${statuses[item.status] || '待核对'}`),
    '出现次数仅为文案匹配，不是搜索量、排名、相关性或合规结论。保留词须服从自家商品事实和适用规则。',
  ].join('\n');
}

export function intakeSection(record) {
  const text = intakeSourceText(record);
  return text ? `<h2>导入材料与关键词变化</h2><pre>${esc(text)}</pre>` : '';
}

export function guidedSourceText(record) {
  const plan = record.guided_plan;
  if (!plan) return '';
  const research = { available: '已取得并由运营选择参考资料', failed: '检索失败，已明确选择只采用自家资料', not_requested: '本次未使用竞品参考' };
  return [
    '引导写作方案',
    `入口：${plan.mode === 'improve' ? '有现成提示词，改进后写稿' : '没有提示词，依据确认的商品资料整理写作要求'}`,
    `写作方案记录：${plan.id}`,
    `参考资料状态：${research[plan.research_status] || '未知'}`,
    ...(plan.research_context?.provider ? [`参考来源：${plan.research_context.provider}`, ...(plan.research_context.notice ? [plan.research_context.notice] : [])] : []),
    `方案模型：${plan.trace?.model || '未记录'}；请求 ID：${plan.trace?.provider_request_id || '未知'}`,
    '可复用提示词（占位内容在实际写稿时采用本次确认的商品资料，不继承其他产品参数）：',
    plan.optimized_prompt || '',
    ...(plan.changes || []).map(value => `调整说明：${value}`),
    ...(plan.missing || []).map(value => `方案待确认：${value}`),
    '写作方案不是商品事实或平台审核结论；最终文案仍须核对未完成检查与待补资料。',
  ].join('\n');
}

export function guidedSection(record) {
  const text = guidedSourceText(record);
  return text ? `<h2>写作方案与参考来源</h2><pre>${esc(text)}</pre>` : '';
}

export function exportListingWorklist(record, recordedSources = []) {
  const context = auditContext(record, recordedSources);
  const citations = new Map(context.citations.map(x => [x.rule_id, x]));
  const worklist = buildWorklist(record.review.issues, context.pack.rules, citations);
  const identity = (context.notice ? '<p class="muted">' + esc(context.notice) + '</p>' : '')
    + identitySection(record, { ruleCount: context.known ? context.pack.rules.length : null });
  const body = worklistDocument(record, worklist, esc, charBudget(record.content, context.pack.rules))
    .replace('</h1>', '</h1>' + identity);
  return reportShell(body + intakeSection(record) + guidedSection(record) + unmodeledSection(record.review.unmodeled_parameters)
    + (record.product_snapshot?.material_context ? `<h2>商品原始材料与来源位置</h2><pre>${esc(factSourceExport(record).join('\n\n'))}</pre>` : ''), { title: '改稿工作单 V' + record.version });
}

export function exportListingReport(record, history = [], recordedSources = []) {
  const { pack, sources, known, notice, citations } = auditContext(record, recordedSources);
  const index = new Map(citations.map(x => [x.rule_id, x]));
  const previous = history.find(item => item.version === record.parent_version);
  const used = new Set([...(record.trace?.source_ids || []), ...record.review.issues.flatMap(x => x.source_ids)]);
  const issues = record.review.issues.map(x => `<div class="issue"><strong>${esc(x.rule_id)} · ${esc(x.title)}</strong><blockquote>${esc(x.original)}</blockquote><p>${esc(x.reason)}</p><p>建议：${esc(x.suggestion)}</p><p class="muted">判断方式：${esc(x.method)} · 字段：${esc(x.field_path)}</p>${issueBasis(citationForField(index.get(x.rule_id), x.field_path))}</div>`).join('');
  const submitted = (record.product_snapshot?.evidence_submissions || []).map(item =>
    `${item.title}\n适用型号：${item.applicable_model}\n发布方：${item.publisher}\n来源：${item.url || '未提供链接'}\n原文：${item.excerpt}\n状态：提交材料待核验，不代表问题已解决。`).join('\n\n');
  return reportShell(
    `<h1>Listing 审阅报告 · V${record.version}</h1><p class="muted">${esc(record.content.title)}<br>${esc(formatStamp(record.created_at))}</p>`
    + verdictSection(record) + unlinkedNotice(record)
    + (notice ? `<p class="muted">${esc(notice)}</p>` : '')
    + identitySection(record, { ruleCount: known ? pack.rules.length : null })
    + actionPlanSection(record) + trendSection(history.filter(x => x.version <= record.version), esc)
    + `<h2>${{ en: '英文文案', es: '西班牙语文案', zh: '中文文案', de: '德语文案', fr: '法语文案' }[record.language || 'en'] || '文案'}</h2><pre>${esc(contentText(record.content))}</pre>` + intakeSection(record) + guidedSection(record)
    + charBudgetSection(charBudget(record.content, pack.rules), esc)
    + benchmarkSection(record.content, recordedBenchmarkScope(record))
    + `<h2>卖点证据对照与资料版本</h2><p class="muted">商品资料版本：${esc(record.product_ref || '未关联')}</p>`
    + parameterSection(record.review.evidence, record.review.unmodeled_parameters)
    + gpsrPartiesSection(record)
    + versionDiffSection(previous, record) + issueChangesSection(previous, record)
    + '<h2>发现与建议</h2>' + (riskSummarySection(record.review.issues, pack.rules) || '<p>本版在已检查范围内没有发现问题。</p>')
    + worklistSection(buildWorklist(record.review.issues, pack.rules, index), esc)
    + '<h2>逐条说明</h2>' + (issues || '<p>请继续核对未完成检查、未覆盖参数和待补资料。</p>')
    + checksSection(record.review.checks, pack.rules) + unmodeledSection(record.review.unmodeled_parameters)
    + `<h2>待补资料与未完成检查</h2><ul>${record.review.missing_data.map(x => `<li>${esc(x.label)}：${esc(x.reason)}</li>`).join('')}${record.review.checks.filter(x => ['not_checked', 'error'].includes(x.state)).map(x => `<li>${esc(x.rule_id)}：${esc(x.reason)}</li>`).join('')}</ul>`
    + `<h2>商家关联的参数来源</h2><pre>${esc(factSourceExport(record).join('\n\n') || '本版本没有商家关联来源。')}</pre>`
    + `<h2>已提交材料（待核验）</h2><pre>${esc(submitted || '本版本没有提交材料。')}</pre>`
    + `<h2>依据</h2><ul>${sources.filter(x => used.has(x.source_id)).map(x => {
      const href = safeHref(x.url);
      const link = href ? `<a href="${esc(href)}" rel="noreferrer">查看原文</a>` : x.url ? `来源地址不是 http(s)：${esc(x.url)}` : '（本地资料／项目约定）';
      return `<li>${esc(x.publisher || x.description || x.source_id)} ${link}</li>`;
    }).join('')}</ul>`
    // 原来这里还有一行"运行 ID · 规则版本 · 算法版本"，三样东西身份卡第一页都已经有。
    // 第 10 轮打印实测：删掉它页数不变（9 → 9），但同一份纸里同一件事不再说两遍。
    + printFooter(record),
    { title: `Listing 审阅报告 V${record.version}` },
  );
}
