import { useRef } from "react";
import {
  ArrowRight,
  CircleAlert,
  FileText,
  Link2,
  Plus,
  SearchCheck,
  Upload,
  X,
} from "lucide-react";
import type { Content, Product } from "./types";
import { intakeKeywords, parseIntakeText } from "./intake";
import type { IntakeDraft, IntakePayload } from "./intake";
import "./intake.css";

export default function IntakePanel({
  value,
  onChange,
  products,
  busy,
  modelConfigured,
  onSubmit,
  onSettings,
  onProducts,
}: {
  value: IntakeDraft;
  onChange: (value: IntakeDraft) => void;
  products: Product[];
  busy: boolean;
  modelConfigured: boolean;
  onSubmit: (payload: IntakePayload) => void;
  onSettings: () => void;
  onProducts: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const productInput = useRef<HTMLSelectElement>(null);
  const update = (patch: Partial<IntakeDraft>) =>
    onChange({ ...value, ...patch });
  const content = value.content;
  const terms = intakeKeywords(value.keyword_text);
  const realProducts = products.filter((product) => !product.is_demo);
  const selectedProduct = realProducts.find(
    (product) => product.product_id === value.product_id,
  );
  const stale = value.parsed_from !== value.raw_text;
  const invalidContent =
    !content?.title.trim() ||
    content.title.length > 5000 ||
    content.item_highlights.length > 10000 ||
    content.description.length > 100000 ||
    content.bullet_points.length > 20 ||
    content.bullet_points.some((b) => !b.text.trim() || b.text.length > 10000);
  const invalidTerms =
    terms.length > 60 || terms.some((term) => term.length > 100);
  const editContent = (patch: Partial<Content>) =>
    content &&
    update({ content: { ...content, ...patch }, preview_confirmed: false });
  const parse = () => {
    try {
      const parsed = parseIntakeText(value.raw_text);
      update({
        ...parsed,
        parsed_from: value.raw_text,
        error: "",
        preview_confirmed: false,
      });
    } catch (error) {
      update({
        error: (error as Error).message,
        content: null,
        preview_confirmed: false,
      });
    }
  };
  const readFile = async (file?: File) => {
    if (!file) return;
    if (!/\.txt$/i.test(file.name)) {
      update({
        error:
          "请选择 UTF-8 .txt 文案文件。CSV/XLSX 可能包含词表或商品指标，本入口不会将它们当成文案全文。",
      });
      return;
    }
    if (file.size > 100 * 1024) {
      update({ error: "TXT 文件最多 100 KB，请拆分文案后再导入。" });
      return;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (text.includes("\0")) throw new Error("文件含非文本内容。");
      update({
        raw_text: text,
        source_filename: file.name,
        error: "",
        preview_confirmed: false,
      });
    } catch {
      update({
        error:
          "无法按 UTF-8 文本读取，请另存为 UTF-8 TXT，或直接复制文案正文。",
      });
    }
  };
  const submit = () => {
    const product = selectedProduct;
    if (
      !content ||
      stale ||
      invalidContent ||
      invalidTerms ||
      !value.preview_confirmed ||
      !value.scope_confirmed ||
      busy
    )
      return;
    if (value.role === "competitor_reference" && !product) {
      update({ error: "竞品原文仅作参考，请先选择本次自家商品。" });
      productInput.current?.focus();
      return;
    }
    if (value.source_url.trim()) {
      try {
        const url = new URL(value.source_url.trim());
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error();
      } catch {
        update({
          error: "来源链接须为不含账号密码的 http(s) 地址；不知道时可以留空。",
        });
        return;
      }
    }
    if (
      value.source_asin.trim() &&
      !/^[A-Z0-9]{10}$/i.test(value.source_asin.trim())
    ) {
      update({ error: "ASIN 须为真实的 10 位字母或数字；不知道时请留空。" });
      return;
    }
    update({ error: "" });
    onSubmit({
      role: value.role,
      content,
      ...(product
        ? { product_id: product.product_id, product_revision: product.revision }
        : {}),
      source_tool: value.source_tool.trim(),
      source_url: value.source_url.trim(),
      source_asin: value.source_asin.trim().toUpperCase(),
      selected_terms: terms,
      scope_confirmed: value.scope_confirmed,
      ...(value.raw_text ? { raw_text: value.raw_text } : {}),
      ...(value.source_filename
        ? { source_filename: value.source_filename }
        : {}),
    });
  };
  return (
    <section
      className="panel intake-panel"
      aria-label="导入后二次加工"
      data-testid="intake-panel"
    >
      <div className="intake-heading">
        <span className="app-icon purple">
          <FileText size={22} />
        </span>
        <div>
          <h2>接着你已有的文案，继续处理</h2>
          <p>
            复制插件、外部 AI 或人工稿。先确认材料角色和字段，再检查或写稿。
          </p>
        </div>
      </div>
      <fieldset disabled={busy} className="intake-form">
        <legend className="intake-legend">这份材料是什么？</legend>
        <div className="intake-roles" role="group" aria-label="导入材料角色">
          <button
            type="button"
            aria-pressed={value.role === "own_draft"}
            onClick={() => update({ role: "own_draft", error: "" })}
          >
            <strong>我的初稿</strong>
            <span>直接检查，保留正文再局部修改</span>
          </button>
          <button
            type="button"
            aria-pressed={value.role === "competitor_reference"}
            onClick={() => update({ role: "competitor_reference", error: "" })}
          >
            <strong>竞品参考</strong>
            <span>结合自家事实另写草稿，再独立审核</span>
          </button>
        </div>
        <label className="intake-label" htmlFor="intake-raw">
          导入文案原文
        </label>
        <textarea
          id="intake-raw"
          aria-label="导入文案原文"
          rows={8}
          maxLength={100000}
          value={value.raw_text}
          onChange={(event) =>
            update({
              raw_text: event.target.value,
              source_filename: "",
              preview_confirmed: false,
              error: "",
            })
          }
          placeholder="粘贴标题、五点和描述。可以保留 Title / Bullet Points / Description 等分段标签；未提供的字段保持为空。"
        />
        <div className="intake-file-actions">
          <input
            ref={fileInput}
            aria-label="读取 UTF-8 TXT 文案"
            type="file"
            accept=".txt,text/plain"
            onChange={(event) => {
              void readFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="secondary-button"
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={15} />
            读取 TXT
          </button>
          <button
            type="button"
            className="primary-button"
            data-testid="intake-parse"
            disabled={!value.raw_text.trim()}
            onClick={parse}
          >
            识别并预览字段 <ArrowRight size={15} />
          </button>
          <span>
            {value.source_filename ||
              "UTF-8 TXT · 最多 100 KB；CSV/XLSX 尚未适配"}
          </span>
        </div>
        {value.error && (
          <p className="intake-error" role="alert">
            <CircleAlert size={16} />
            {value.error}
          </p>
        )}
        {content && (
          <section className="intake-preview" aria-label="导入字段预览">
            <div className="intake-section-title">
              <h3>核对分段，保留真实原文</h3>
              <span>{content.bullet_points.length} 条要点</span>
            </div>
            {stale && (
              <p className="intake-error" role="status">
                原文已变化，请重新识别并核对字段后提交。
              </p>
            )}
            {!!value.warnings.length && (
              <ul className="intake-warnings">
                {value.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            <label className="intake-label">
              标题
              <textarea
                aria-label="导入标题预览"
                rows={2}
                value={content.title}
                maxLength={5000}
                onChange={(event) => editContent({ title: event.target.value })}
              />
            </label>
            <label className="intake-label">
              商品亮点（原文未提供可留空）
              <textarea
                aria-label="导入亮点预览"
                rows={2}
                value={content.item_highlights}
                maxLength={10000}
                onChange={(event) =>
                  editContent({ item_highlights: event.target.value })
                }
              />
            </label>
            <div className="intake-bullets">
              {content.bullet_points.map((bullet, index) => (
                <div key={bullet.id}>
                  <label className="intake-label">
                    要点 {index + 1}
                    <textarea
                      aria-label={`导入要点 ${index + 1}`}
                      rows={2}
                      maxLength={10000}
                      value={bullet.text}
                      onChange={(event) =>
                        editContent({
                          bullet_points: content.bullet_points.map((item) =>
                            item.id === bullet.id
                              ? { ...item, text: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`移除导入要点 ${index + 1}`}
                    onClick={() =>
                      editContent({
                        bullet_points: content.bullet_points.filter(
                          (item) => item.id !== bullet.id,
                        ),
                      })
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="text-button"
              disabled={content.bullet_points.length >= 20}
              onClick={() => {
                let n = content.bullet_points.length + 1;
                while (
                  content.bullet_points.some((item) => item.id === `b${n}`)
                )
                  n++;
                editContent({
                  bullet_points: [
                    ...content.bullet_points,
                    { id: `b${n}`, text: "" },
                  ],
                });
              }}
            >
              <Plus size={15} />
              添加一条原文要点
            </button>
            <label className="intake-label">
              商品描述
              <textarea
                aria-label="导入描述预览"
                rows={5}
                maxLength={100000}
                value={content.description}
                onChange={(event) =>
                  editContent({ description: event.target.value })
                }
              />
            </label>
            <label className="intake-check">
              <input
                type="checkbox"
                aria-label="确认导入字段"
                checked={value.preview_confirmed}
                disabled={stale || Boolean(invalidContent)}
                onChange={(event) =>
                  update({ preview_confirmed: event.target.checked })
                }
              />
              <span>我已核对分段，确认这份内容作为本次输入</span>
            </label>
            {invalidContent && (
              <p className="helper warm-text">
                请填写标题，移除空要点，并将要点整理为最多 20
                条；超出字段长度的内容请先拆分。
              </p>
            )}
          </section>
        )}
        <div className="intake-context-grid">
          <section>
            <label className="intake-label">
              关联本次自家商品
              <select
                ref={productInput}
                aria-label="导入关联自家商品"
                value={value.product_id}
                onChange={(event) =>
                  update({ product_id: event.target.value, error: "" })
                }
              >
                <option value="">
                  {value.role === "own_draft"
                    ? "不关联，仅检查文本范围"
                    : "请选择自家商品（必选）"}
                </option>
                {realProducts.map((product) => (
                  <option key={product.product_id} value={product.product_id}>
                    {product.name_zh} · V{product.revision}
                  </option>
                ))}
              </select>
            </label>
            <p className="helper">
              {value.role === "competitor_reference"
                ? "竞品的材质、包装、性能和认证不作为自家事实；生成须使用选中的自家资料。"
                : "未关联时不执行以商品档案为准的核对，也不代表事实已经核验。"}
            </p>
            {!realProducts.length && (
              <button
                type="button"
                className="text-button"
                onClick={onProducts}
              >
                去录入真实商品资料 <ArrowRight size={13} />
              </button>
            )}
          </section>
          <section>
            <label className="intake-label">
              导入关键词（可选）
              <textarea
                aria-label="导入关键词"
                rows={3}
                maxLength={12000}
                value={value.keyword_text}
                onChange={(event) =>
                  update({ keyword_text: event.target.value })
                }
                placeholder="每行一个词组，或用逗号分隔。保留有依据的词，不强行加入性能或认证。"
              />
            </label>
            <p className={`helper ${invalidTerms ? "warm-text" : ""}`}>
              {terms.length} 个去重词组 · 最多 60 个，每个最多 100
              字符。词表不等于商品事实。
            </p>
          </section>
        </div>
        <details className="intake-source">
          <summary>
            <Link2 size={14} />
            补充来源（可选）
          </summary>
          <div className="intake-context-grid">
            <label className="intake-label">
              来源工具
              <input
                aria-label="导入来源工具"
                maxLength={100}
                list="intake-tools"
                value={value.source_tool}
                onChange={(event) =>
                  update({ source_tool: event.target.value })
                }
                placeholder="不知道可留空"
              />
              <datalist id="intake-tools">
                <option value="卖家精灵" />
                <option value="Helium 10" />
                <option value="Jungle Scout" />
                <option value="人工文案" />
              </datalist>
            </label>
            <label className="intake-label">
              来源 ASIN
              <input
                aria-label="导入来源 ASIN"
                maxLength={10}
                value={value.source_asin}
                onChange={(event) =>
                  update({ source_asin: event.target.value })
                }
                placeholder="真实 ASIN，不知道可留空"
              />
            </label>
          </div>
          <label className="intake-label">
            来源链接
            <input
              type="url"
              aria-label="导入来源链接"
              maxLength={1000}
              value={value.source_url}
              onChange={(event) => update({ source_url: event.target.value })}
              placeholder="https://…"
            />
          </label>
          <p className="helper">
            来源记录仅说明取得材料的位置，不证明竞品宣称适用于自家商品。
          </p>
        </details>
        <label className="intake-check intake-scope">
          <input
            type="checkbox"
            aria-label="确认检查范围"
            checked={value.scope_confirmed}
            onChange={(event) =>
              update({ scope_confirmed: event.target.checked })
            }
          />
          <span>
            确认本次用于 Amazon 美国站棉布手提袋的英文文本审改
            <small>
              站点或品类未知时可先预览，不套用美国站专属规则，也不启动模型。
            </small>
          </span>
        </label>
        <div className="intake-submit-row">
          <button
            type="button"
            className="primary-button"
            data-testid="intake-submit"
            disabled={
              busy ||
              stale ||
              Boolean(invalidContent) ||
              invalidTerms ||
              !value.preview_confirmed ||
              !value.scope_confirmed ||
              !modelConfigured ||
              (value.role === "competitor_reference" && !selectedProduct)
            }
            onClick={submit}
          >
            <SearchCheck size={17} />
            {value.role === "own_draft"
              ? "检查我的初稿"
              : "按自家资料生成并审核"}
          </button>
          <p className="helper">
            {value.role === "own_draft"
              ? "将调用真实模型审阅，保留原稿。"
              : !selectedProduct
                ? "请先选择真实自家商品；竞品原文不能代替自家商品资料。"
                : "将先生成自家草稿，再独立调用模型审核。"}
            格式失败重试可能增加调用，按实际用量计费。
          </p>
        </div>
        {!modelConfigured && (
          <button type="button" className="text-button" onClick={onSettings}>
            配置本机真实模型后提交 <ArrowRight size={13} />
          </button>
        )}
      </fieldset>
    </section>
  );
}
