/**
 * 多版本趋势：一个 listing 改到第 N 版，问题到底在怎么动（第 15 轮自提 86）
 *
 * 为什么需要单独一个模块：
 *   报告里已经有两段"和上一版比"（`versionDiffSection` 比正文、`issueChangesSection` 比问题），
 *   但**它们只能看相邻两版**。一个商品改到 V5，商家真正想知道的是"我这几轮改下来，
 *   是越改越干净，还是原地打转"——两两对比回答不了这个，只会给出四份互不相干的差异。
 *
 * 这个模块唯一的硬判断（也是整份趋势里最容易做错的地方）：
 *
 *   **问题数下降不等于变好。**
 *
 *   数字变小至少有四个原因：真改了、那句话被删了、这一版没关联商品、这一版有检查项报错。
 *   后三个都会让报告看起来更干净，而且更安静——没人会去追问"为什么突然没问题了"。
 *   所以每条趋势都必须带着「这一版查了几项」一起看：
 *
 *   - 完成项**减少**了 → 判 `incomparable`，明说"问题变少可能只是因为查得少"，
 *     哪怕阻断项从 5 掉到 0 也不许说"变好"；
 *   - 只有完成项没退，才轮到比阻断项。
 *
 * 第二条判断：**「不再报出」不等于「已解决」**（和 `issueChangesSection` 同一口径）。
 * 趋势给出的结论只描述"数字在怎么动"，不替商家认"这条问题解决了"。
 */

const SEVERITIES = ["blocking", "needs_review", "suggestion"];

const countBy = (issues, severity) =>
  issues.filter((issue) => issue.severity === severity).length;

/**
 * 把一串版本记录压成一条时间线。
 *
 * 输入允许乱序（store 里取出来可能是倒序），输出**一定按 version 升序**——
 * 趋势图反着画比不画更糟。
 *
 * 每一条都带 `checks_missing` 和 `linked`：前者是"这一版少查了几项"的直接证据，
 * 后者是"为什么少查"的最常见原因（没关联商品）。两者都不做推断，只照抄记录里的字段。
 */
export function trendSeries(records = []) {
  const ordered = (records || [])
    .filter((record) => record && Number.isFinite(Number(record.version)))
    .sort((a, b) => Number(a.version) - Number(b.version));

  let previousRules = null;
  return ordered.map((record) => {
    const review = record.review || {};
    const issues = (review.issues || []).filter(Boolean);
    const checks = review.checks || [];
    // coverage 是引擎算的权威数字；记录里没有 coverage（老版本）就退回去数 checks，
    // 不许因为拿不到 coverage 就写 0——那会把"不知道"说成"没查"。
    const coverage = review.coverage || {};
    const total = Number.isFinite(Number(coverage.total))
      ? Number(coverage.total)
      : checks.length;
    const completed = Number.isFinite(Number(coverage.completed))
      ? Number(coverage.completed)
      : checks.filter((x) => !["not_checked", "error"].includes(x.state)).length;
    const ruleIds = [...new Set(issues.map((x) => x.rule_id).filter(Boolean))].sort();

    const entry = {
      version: Number(record.version),
      created_at: record.created_at || null,
      operation: record.operation || null,
      issues: issues.length,
      blocking: countBy(issues, "blocking"),
      needs_review: countBy(issues, "needs_review"),
      suggestion: countBy(issues, "suggestion"),
      checks_total: total,
      checks_completed: completed,
      checks_missing: Math.max(0, total - completed),
      rule_ids: ruleIds,
      new_rule_ids: previousRules
        ? ruleIds.filter((ruleId) => !previousRules.includes(ruleId))
        : [],
      closed_rule_ids: previousRules
        ? previousRules.filter((ruleId) => !ruleIds.includes(ruleId))
        : [],
      // 没关联商品 → 以档案为准的检查根本没执行。这不是"查了没问题"。
      linked: Boolean(record.product_ref),
      product_ref: record.product_ref || null,
      algorithm_version: record.trace?.parameter_link_version || null,
      uncovered_parameters: review.unmodeled_parameters?.length || 0,
      actual_model_call: Boolean(record.trace?.actual_model_call),
      // 这一版用哪个规则包/哪一版规则。换包或规则升版之后，两版的问题数不是同一把尺子量的，
      // 趋势必须能看出来——记录里只有 rule_pack_version，它同时覆盖"换包"和"规则改了一版"两种情况。
      rule_pack: record.rule_pack_version || record.rule_pack || record.trace?.rule_pack || null,
    };
    previousRules = ruleIds;
    return entry;
  });
}

/**
 * 最后一段"查的是同一批东西"的版本（第 17 轮）。
 *
 * 时间线上如果有过"关不关联商品"的翻转，翻转点之后的那些版本彼此可比——
 * 这正是商家补完档案之后要看的区间。不足两版就返回 null（一版看不出趋势，别硬给结论）。
 * 递归调用自己时**不会再翻**：这里切的是最后一个翻转点之后的尾巴，那一段的 `linked` 全相同。
 */
function comparableTail(records, series) {
  if (series.length < 3) return null;
  let lastFlip = 0;
  for (let index = 1; index < series.length; index++)
    if (series[index].linked !== series[index - 1].linked) lastFlip = index;
  if (!lastFlip) return null;
  const fromVersion = series[lastFlip].version;
  const tail = (records || []).filter((item) => Number(item?.version) >= fromVersion);
  if (tail.length < 2) return null;
  const inner = trendVerdict(tail);
  if (inner.direction === "scope_changed" || inner.direction === "no_data" || inner.direction === "insufficient")
    return null;
  return {
    from_version: fromVersion,
    direction: inner.direction,
    headline: inner.headline,
    caveat: inner.caveat,
    linked: series[lastFlip].linked,
  };
}

/** 最好的一版：先看阻断项，再看问题总数，最后取版本号靠前的（同分时越早越好解释）。 */
function bestOf(series) {
  return series.reduce((best, entry) => {
    if (entry.blocking !== best.blocking) return entry.blocking < best.blocking ? entry : best;
    if (entry.issues !== best.issues) return entry.issues < best.issues ? entry : best;
    return best;
  }, series[0]);
}

/**
 * 一句话结论 + 一句必须跟着说的话。
 *
 * `headline` 是给第一屏看的（谁说、降了几个），`caveat` 是这条结论的边界。
 * 两个都返回，调用方不许只显示 headline——趋势是所有报告结论里最容易被误读的一段。
 */
export function trendVerdict(records = []) {
  const series = trendSeries(records);

  if (!series.length)
    return {
      direction: "no_data",
      headline: "还没有任何版本，无法给出趋势。",
      caveat: "",
      series,
    };

  const first = series[0];
  const last = series[series.length - 1];

  if (series.length === 1)
    return {
      direction: "insufficient",
      headline: `只有 V${first.version} 一版，还看不出趋势。`,
      caveat: "改一版之后再回来看这里：这一节比的是「第一版 → 最新版」，不是「这一版比上一版」。",
      series,
    };

  const contexts = new Set(series.map(x => JSON.stringify([x.rule_pack, x.algorithm_version])));
  if (contexts.size > 1) return {
    direction: 'incomparable',
    headline: '规则包或参数识别算法发生变化，历史版本的问题数不能直接比较。',
    caveat: '请在相同规则和算法版本下重新检查；旧记录保持原结论。', series,
  };
  const references = new Set(series.map(x => x.product_ref));
  const coverageBounds = new Set(series.map(x => x.uncovered_parameters));
  if (series.every(x => x.linked) && references.size > 1) return {
    direction: 'scope_changed', headline: '商品资料版本发生变化，问题变化可能来自资料更新。',
    caveat: '请同时查看商品版本、正文差异和检查范围，不能直接将数字下降称为改稿改善。', series,
  };
  if (coverageBounds.size > 1 && series.every(x => x.linked === first.linked)) return {
    direction: 'incomparable', headline: '未覆盖参数的数量发生变化，不能仅按问题数判断改善。',
    caveat: '请逐项核对未覆盖参数及正文差异；删去一句也会让问题数量下降。', series,
  };

  const best = bestOf(series);
  const regressions = series
    .slice(1)
    .filter((entry, index) => {
      const before = series[index];
      return entry.blocking > before.blocking || entry.issues > before.issues;
    }).length;

  // 检查完整度退步 → 一切数字比较都无效。这一条必须排在所有比较之前。
  //
  // 第 16 轮把它拆成**两支**，因为"查得少了"和"这一版查的是另一批东西"是两件事，
  // 而原来的措辞（"这一轮少查了 N 项检查"）只解释了前一种：
  //
  //   - 没关联商品 → 以档案为准的检查根本不执行。这时候问题变少是必然的，
  //     正确动作是"把商品档案关联回来再改一版"，不是"再去补几项检查"；
  //   - 关联状态下少查 → 有检查没跑完（报错/被跳过），那才是"查少了"。
  //
  // 还有一种以前完全没挡：**这一版查得更多**。补完商品资料重新对照，检查项从 12 涨到 14，
  // 新跑的两项把先前没资格检查的问题报了出来——旧代码会落到下面比阻断项，
  // 然后写"改稿引入了新的硬伤"。这不是改坏了，是这次真的拿档案比了一遍。
  const scopeChanged = first.linked !== last.linked;
  const checksDelta = last.checks_completed - first.checks_completed;

  // 换了规则包 → 两版的问题不是同一套尺子量出来的。放在"检查项"之前：
  // 换包本身就会改变检查项的数量与归属，先说"换了尺子"比说"少查了几项"更接近事实。
  if (first.rule_pack && last.rule_pack && first.rule_pack !== last.rule_pack) {
    return {
      direction: "incomparable",
      headline:
        `V${first.version} 用的是规则包 ${first.rule_pack}，V${last.version} 换成了 ${last.rule_pack}，` +
        "两版的问题数不是同一套规则量出来的，不能直接比。",
      caveat: "要比较改动效果，请在同一规则包下再看一版。",
      series,
      best,
      regressions,
    };
  }

  if (scopeChanged) {
    const unlinked = last.linked ? first : last;
    const linked = last.linked ? last : first;
    return {
      direction: "scope_changed",
      headline:
        `V${unlinked.version} 没有关联商品档案，只查了 ${unlinked.checks_completed} 项；` +
        `V${linked.version} 关联了商品，查了 ${linked.checks_completed} 项。` +
        "两版查的不是同一批东西，问题数不能直接比。",
      caveat:
        (unlinked === last
          ? "这一版问题变少，是因为以档案为准的检查（尺寸、材质、承重对照）根本没执行——" +
            "这不是改好了。要比较改动效果，先把商品档案关联回来，再改一版。"
          : "这一版问题变多，是因为这次真的拿商品档案逐项比了一遍——不是改坏了。" +
            "要看改动有没有用，得让两版都关联同一份档案。"),
      // 整条时间线不可比，不等于"从此以后都不可比"（第 17 轮补）：
      // 补上商品档案之后又改了三四版的情况，商家真正想知道的是"**补上之后**这几版在变好还是变差"。
      // 所以再切出最后一个翻转点之后的那些版本单独给一次结论——它只算段内比较，
      // 不改变"整条不可比"这个主结论（跨边界那两个数永远不能直接比）。
      segment: comparableTail(records, series),
      series,
      best,
      regressions,
    };
  }

  if (checksDelta < 0) {
    const missing = -checksDelta;
    return {
      direction: "incomparable",
      headline:
        `从 V${first.version} 到 V${last.version}，问题从 ${first.issues} 条变成 ${last.issues} 条、` +
        `阻断从 ${first.blocking} 条变成 ${last.blocking} 条，但这一轮少查了 ${missing} 项检查，` +
        "不能当作变好。",
      caveat:
        `V${first.version} 查了 ${first.checks_completed} 项，V${last.version} 只查了 ${last.checks_completed} 项。` +
        "少查的那几项没有结论，它们既不算通过也不算失败——先按「检查没做全」看这一版。",
      series,
      best,
      regressions,
    };
  }

  if (checksDelta > 0) {
    return {
      direction: "incomparable",
      headline:
        `从 V${first.version} 到 V${last.version}，问题从 ${first.issues} 条变成 ${last.issues} 条、` +
        `阻断从 ${first.blocking} 条变成 ${last.blocking} 条，但这一版多查了 ${checksDelta} 项检查，` +
        "问题变多不等于改坏了。",
      caveat:
        `V${first.version} 查了 ${first.checks_completed} 项，V${last.version} 查了 ${last.checks_completed} 项。` +
        "新执行的检查会把先前没有资格检查的问题报出来（比如补全商品资料后才做得了参数对照）；" +
        "要看改动本身有没有用，得让两版都查完再去比。",
      series,
      best,
      regressions,
    };
  }

  const blockingDelta = last.blocking - first.blocking;
  const issueDelta = last.issues - first.issues;
  const upDown = regressions ? `中间有 ${regressions} 次回升，` : "";
  const bestNote =
    best.version !== last.version
      ? `最干净的是 V${best.version}（阻断 ${best.blocking} 条），之后又回升了。`
      : "最新一版就是这几版里最干净的一版。";

  if (blockingDelta < 0) {
    return {
      direction: "improving",
      headline:
        `从 V${first.version} 到 V${last.version}，${upDown}阻断项 ${first.blocking} → ${last.blocking}，` +
        `问题总数 ${first.issues} → ${last.issues}。`,
      caveat: `${bestNote} 数字下降只说明「这一版不再报出这么多」，不等于每一条都已经解决——被删掉的句子也会让数字变小。`,
      series,
      best,
      regressions,
    };
  }

  if (blockingDelta > 0) {
    return {
      direction: "worsening",
      headline:
        `从 V${first.version} 到 V${last.version}，阻断项 ${first.blocking} → ${last.blocking}，` +
        `问题总数 ${first.issues} → ${last.issues}；改稿引入了新的硬伤。`,
      caveat: `${bestNote} 先看下面「这一版新出现的规则」，那几条通常就是这次改动的代价。`,
      series,
      best,
      regressions,
    };
  }

  // 阻断项没变，看总数。
  if (issueDelta < 0) {
    // 阻断本来就是 0 的时候，不能写「阻断项一条都没减少」——那听起来像出了什么事，
    // 而实际上这一版压根没有阻断项。这一支单独说清楚，后面接"还剩几项没查"。
    if (first.blocking === 0) {
      return {
        direction: "improving",
        headline:
          `从 V${first.version} 到 V${last.version}，${upDown}两版都没有阻断项，` +
          `问题总数从 ${first.issues} 条降到 ${last.issues} 条（少的是待核对与措辞建议）。`,
        caveat:
          `${bestNote} 没有阻断项不等于可以上架：这一版还有 ${last.checks_missing} 项检查没做完，` +
          "「已查/应查」那一列没补齐之前，结论只能是「已查的范围内没问题」。",
        series,
        best,
        regressions,
      };
    }
    return {
      direction: "improving",
      headline:
        `从 V${first.version} 到 V${last.version}，${upDown}阻断项一直是 ${first.blocking} 条没动，` +
        `但问题总数从 ${first.issues} 条降到 ${last.issues} 条（少的是待核对与措辞建议）。`,
      caveat: `${bestNote} 阻断项一条都没减少，所以这一版仍然不能直接提交。`,
      series,
      best,
      regressions,
    };
  }

  if (issueDelta > 0) {
    return {
      direction: "worsening",
      headline:
        `从 V${first.version} 到 V${last.version}，阻断项一直是 ${first.blocking} 条，` +
        `但问题总数从 ${first.issues} 条涨到 ${last.issues} 条。`,
      caveat: `${bestNote} 涨的多半是待核对项：改动带进了新的数字或宣称，需要再核一遍。`,
      series,
      best,
      regressions,
    };
  }

  return {
    direction: "flat",
    headline:
      `从 V${first.version} 到 V${last.version}，问题总数一直是 ${first.issues} 条、阻断 ${first.blocking} 条，` +
      "这几版在审核结论上没有变化。",
    caveat:
      "结论没变有两种可能：改的地方不属于规则覆盖范围，或者改动被同一条规则重新命中。看下面的「新出现 / 不再出现」分得出来。",
    series,
    best,
    regressions,
  };
}

function tone(direction) {
  if (direction === "improving") return "#236b55";
  if (direction === "worsening") return "#b95245";
  return "#b36c32";
}

/**
 * 报告里的「这几版怎么变的」一节。
 *
 * 位置：紧跟在结论后面、行动清单之前——它是"上一版到现在"这件事的总览，
 * 放在逐条说明里读者已经读累了。
 *
 * 只有一版时返回空串（单版报告不该塞一节"没有趋势"的噪音），
 * 这是和 `trendVerdict` 不同的地方：那个函数要回答"为什么没有结论"，
 * 报告不需要回答一个没人问的问题。
 */
export function trendSection(records = [], escape = (x) => String(x ?? "")) {
  const series = trendSeries(records);
  if (series.length < 2) return "";
  const verdict = trendVerdict(records);
  const color = tone(verdict.direction);
  const maxIssues = Math.max(...series.map((entry) => entry.issues), 1);

  const rows = series
    .map((entry) => {
      const width = Math.max(3, Math.round((entry.issues / maxIssues) * 110));
      const blockingWidth = entry.issues
        ? Math.round((entry.blocking / entry.issues) * width)
        : 0;
      // 条形按像素给长度（长度要能比大小），但**必须能被压窄**：
      // 手机 390px 下 7 张列本来就挤，一个 110px 的死宽度会把它顶出屏幕（第 16 轮实测 +32px）。
      // 显示方式必须写在类上（`report-style.mjs` 的 `.trend-bar`），**不能写内联**：
      // 内联 `display:inline-block` 会压过媒体查询里的 `.trend-bar{display:none}`，
      // 手机上照样占 110px（第一次修就是栽在这——样式改了两遍，屏幕上一点没变）。
      const bar =
        `<span class="trend-bar" style="width:${width}px">` +
        `<span class="trend-bar-fill" style="width:${blockingWidth}px"></span></span>`;
      const ruleBits = [
        entry.new_rule_ids.length
          ? `新 ${escape(entry.new_rule_ids.join("、"))}`
          : "",
        entry.closed_rule_ids.length
          ? `不再报出 ${escape(entry.closed_rule_ids.join("、"))}`
          : "",
      ]
        .filter(Boolean)
        .join("；");
      // 这里**不许**写 white-space:nowrap：手机宽度下它会让表头竖排成「阻 断」「待 核 对」，
      // 并且把最后一列推出屏幕。列宽让浏览器自己分，数字短，不会排乱。
      return (
        `<tr>` +
        `<td><strong>V${entry.version}</strong></td>` +
        `<td>${bar} <strong>${entry.issues}</strong> 条</td>` +
        `<td>${entry.blocking}</td>` +
        `<td>${entry.needs_review}</td>` +
        `<td>${entry.suggestion}</td>` +
        `<td>${entry.checks_completed}/${entry.checks_total}` +
        `${entry.checks_missing ? ` <span style="color:#b36c32">缺 ${entry.checks_missing}</span>` : ""}</td>` +
        `<td>${ruleBits || '<span class="muted">—</span>'}</td>` +
        `</tr>`
      );
    })
    .join("");

  return (
    `<h2>这几版怎么变的（V${series[0].version} → V${series[series.length - 1].version}）</h2>` +
    `<div style="border:1px solid ${color};border-left:6px solid ${color};border-radius:10px;padding:12px 16px;margin:12px 0">` +
    `<p style="margin:0;color:${color}">${escape(verdict.headline)}</p>` +
    `<p class="muted" style="margin:6px 0 0">${escape(verdict.caveat)}</p>` +
    (verdict.segment
      ? `<p style="margin:6px 0 0">从 <strong>V${verdict.segment.from_version}</strong> 起` +
        `（那之后每一版${verdict.segment.linked ? "都挂着商品档案" : "都没有关联商品"}）可以单独比：` +
        `${escape(verdict.segment.headline)}</p>`
      : "") +
    `</div>` +
    `<table><thead><tr><th>版本</th><th>问题总数</th><th>阻断</th><th>待核对</th><th>建议</th>` +
    `<th>已查/应查</th><th>规则变化</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="muted" style="margin-top:8px">条形长度按问题总数算，其中红色段是阻断项（手机上不显示条形，读数看数字）。「已查/应查」是这一版真正执行完的检查项：` +
    `它变小的时候，上面那些数字也跟着变小，那不是改好了，是查少了。` +
    `规则变化一列只列<strong>和上一版比</strong>多了或不再报出的规则号，不是累计。</p>`
  );
}
