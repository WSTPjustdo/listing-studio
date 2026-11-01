import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Check, FileText, LoaderCircle, RotateCcw, Upload, X } from "lucide-react";
import { post } from "./api";
import type { MaterialContext } from "./guidedInput";
export type { MaterialContext } from "./guidedInput";
import "./materials.css";

type MaterialDocument = {
  id: string;
  filename: string;
  kind: string;
  sha256: string;
  bytes: number;
  status: "ready" | "failed" | "needs_input";
  text: string;
  segments: { locator: string; text: string }[];
  warnings: string[];
  error?: { code: string; message: string };
};

type MaterialPreview = {
  id: string;
  documents: MaterialDocument[];
  text: string;
  warnings: string[];
};

export type MaterialDraft = {
  files: File[];
  preview: MaterialPreview | null;
  selected: string[];
  text: string;
  sameProduct: boolean;
  applied: boolean;
};

export const emptyMaterialDraft = (): MaterialDraft => ({
  files: [], preview: null, selected: [], text: "", sameProduct: false, applied: false,
});

const MAX_FILES = 12;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const ACCEPT = ".docx,.pdf,.xlsx,.csv,.tsv,.txt,.png,.jpg,.jpeg,.webp";
const supported = /\.(docx|pdf|xlsx|csv|tsv|txt|png|jpe?g|webp)$/i;
const sizeLabel = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const selectedText = (documents: MaterialDocument[], selected: string[]) => documents
  .filter((document) => document.status === "ready" && selected.includes(document.id))
  .map((document) => document.segments?.length
    ? document.segments.map((segment) => `【${document.filename} / ${segment.locator}】\n${segment.text}`).join("\n")
    : document.text)
  .join("\n\n");

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}，请重新选择文件。`));
    reader.readAsDataURL(file);
  });
}

export function MaterialIntake({ draft, onChange, onUse, onInvalidate, onWorkingChange, disabled = false }: {
  draft: MaterialDraft;
  onChange: Dispatch<SetStateAction<MaterialDraft>>;
  onUse: (text: string, context: MaterialContext) => boolean | void;
  onInvalidate: () => void;
  onWorkingChange: (working: boolean) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const workingLock = useRef(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const ready = draft.preview?.documents.filter((document) => document.status === "ready") || [];
  const unavailable = draft.preview?.documents.filter((document) => document.status !== "ready") || [];
  const selectedDocuments = ready.filter((document) => draft.selected.includes(document.id));
  const locked = disabled || working;

  function invalidate() {
    if (draft.applied) onInvalidate();
  }

  function addFiles(incoming: File[]) {
    if (locked || !incoming.length) return;
    const files = [...draft.files];
    const failures: string[] = [];
    for (const file of incoming) {
      if (!supported.test(file.name)) {
        failures.push(`${file.name}：暂不支持此格式；旧版 Word .doc / Excel .xls 请另存为 .docx / .xlsx。`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        failures.push(`${file.name}：超过单文件 5 MB，请拆分或压缩。`);
        continue;
      }
      if (!file.size) {
        failures.push(`${file.name}：文件为空。`);
        continue;
      }
      if (files.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) {
        failures.push(`${file.name}：已经在资料列表中，本次未重复添加。`);
        continue;
      }
      if (files.length >= MAX_FILES || files.reduce((sum, existing) => sum + existing.size, 0) + file.size > MAX_TOTAL_BYTES) {
        failures.push(`${file.name}：每次最多 12 个文件、合计 20 MB。`);
        continue;
      }
      files.push(file);
    }
    if (failures.length) setError((previous) => [...new Set([previous, ...failures].filter(Boolean))].join("\n"));
    if (files.length !== draft.files.length) {
      invalidate();
      onChange({ ...emptyMaterialDraft(), files });
    }
  }

  function removeFile(index: number) {
    if (locked) return;
    invalidate();
    const files = draft.files.filter((_, fileIndex) => fileIndex !== index);
    onChange({ ...emptyMaterialDraft(), files });
    setError("");
  }

  async function extract() {
    if (locked || workingLock.current || !draft.files.length) return;
    workingLock.current = true;
    setWorking(true);
    onWorkingChange(true);
    setError("");
    invalidate();
    onChange((current) => ({ ...current, applied: false, sameProduct: false }));
    try {
      const files = await Promise.all(draft.files.map(async (file) => ({
        filename: file.name, base64: await fileBase64(file),
      })));
      const preview = await post<MaterialPreview>("/api/materials/preview", { files });
      const selected = preview.documents.filter((document) => document.status === "ready").map((document) => document.id);
      onChange((current) => ({ ...current, preview, selected, text: selectedText(preview.documents, selected), applied: false, sameProduct: false }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      workingLock.current = false;
      setWorking(false);
      onWorkingChange(false);
    }
  }

  function toggleDocument(id: string, checked: boolean) {
    invalidate();
    const selected = checked ? [...draft.selected, id] : draft.selected.filter((value) => value !== id);
    onChange((current) => ({ ...current, selected, text: selectedText(current.preview?.documents || [], selected), sameProduct: false, applied: false }));
  }

  return (
    <section className="material-intake" data-testid="material-intake" aria-label="工厂多格式资料导入"
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length && !locked) { event.preventDefault(); addFiles(files); }
      }}>
      <div className="material-heading">
        <span className="material-heading-icon"><FileText size={19} /></span>
        <div><h3>工厂资料，直接交过来</h3><p>中文 Word、微信截图、实拍图备注、零散 Excel、PDF 说明书可一起选。</p></div>
      </div>
      <div className={`material-dropzone${dragging ? " is-dragging" : ""}`}
        tabIndex={locked ? -1 : 0} aria-label="拖放文件或粘贴截图区域"
        onDragOver={(event) => { event.preventDefault(); if (!locked) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}>
        <input ref={input} type="file" className="material-file-input" tabIndex={-1} aria-label="选择工厂资料文件" accept={ACCEPT} multiple disabled={locked}
          onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
        <button type="button" className="secondary-button" onClick={() => input.current?.click()} disabled={locked}>
          <Upload size={16} />选择多个文件
        </button>
        <span>也可拖放文件，或在此粘贴截图</span>
        <small>每次 12 个以内 · 单文件 5 MB · 总计 20 MB</small>
      </div>
      {draft.files.length > 0 && <>
        <ul className="material-file-list" aria-label="已选择的资料文件">
          {draft.files.map((file, index) => <li key={`${file.name}-${file.size}-${file.lastModified}`}>
            <FileText size={15} /><span>{file.name}<small>{sizeLabel(file.size)}</small></span>
            <button type="button" className="text-button" aria-label={`移除资料 ${file.name}`} disabled={locked} onClick={() => removeFile(index)}><X size={15} /></button>
          </li>)}
        </ul>
        <div className="material-actions">
          <button type="button" className="secondary-button" data-testid="materials-extract" disabled={locked} onClick={() => void extract()}>
            {working ? <LoaderCircle size={15} className="spin" /> : draft.preview ? <RotateCcw size={15} /> : <FileText size={15} />}
            {working ? "正在提取文字与图片备注…" : draft.preview ? "重新提取全部文件" : "提取资料内容"}
          </button>
          <small>{working ? "图片和扫描页在本机识别，可能需要稍等。" : "先提取与核对，再使用本机模型整理商品。编辑资料不会撤销已采用内容。"}</small>
        </div>
      </>}
      {error && <p className="material-error" role="alert">{error}</p>}
      {draft.preview && <div className="material-preview" aria-live="polite">
        <p className="material-preview-count"><strong>{ready.length} 份可核对资料</strong>{unavailable.length > 0 && <span> · {unavailable.length} 份未识别成功</span>}</p>
        {(draft.preview.warnings || []).map((warning, index) => <p className="material-warning" key={index}>{warning}</p>)}
        {draft.preview.documents.map((document) => <details key={document.id} open={document.status !== "ready"} className={`material-document material-document-${document.status}`}>
          <summary><span>{document.filename}</span><small>{document.status === "ready" ? "查看提取内容与来源位置" : `需补充资料：${document.error?.message || "未取得可用文字"}`}</small></summary>
          {document.status === "ready" ? <>
            <label className="material-check"><input type="checkbox" aria-label={`采用资料 ${document.filename}`} checked={draft.selected.includes(document.id)} disabled={locked}
              onChange={(event) => toggleDocument(document.id, event.target.checked)} /><span>本次采用这份资料</span></label>
            {document.segments?.length ? document.segments.map((segment, index) => <div className="material-segment" key={index}><small>{segment.locator}</small><pre>{segment.text}</pre></div>) : <pre>{document.text}</pre>}
          </> : <p className="material-error">{document.error?.message || "没有取得可用文字。请补充清晰原文件或把备注粘贴到商品资料中。"}{document.error?.code && <small>原因：{document.error.code}</small>}</p>}
          {(document.warnings || []).map((warning, index) => <p className="material-warning" key={index}>{warning}</p>)}
        </details>)}
        {ready.length > 0 && <>
          <label className="material-text-label">核对本次使用的资料文字
            <textarea aria-label="核对工厂资料文字" value={draft.text} rows={7} maxLength={60000} disabled={locked}
              onChange={(event) => { invalidate(); onChange((current) => ({ ...current, text: event.target.value, applied: false })); }} />
            <small>可更正 OCR 错字或补充备注；原始提取内容和文件来源会保留。不同规格有冲突时，请写清采用哪一项。</small>
          </label>
          {draft.text.length > 60000 && <p className="material-error" role="alert">所选资料超过 60,000 字符，请取消部分文件或保留本商品相关段落后再使用。</p>}
          <label className="material-check material-same-product">
            <input type="checkbox" aria-label="确认所选资料属于同一商品" checked={draft.sameProduct} disabled={locked}
              onChange={(event) => { invalidate(); onChange((current) => ({ ...current, sameProduct: event.target.checked, applied: false })); }} />
            <span>我已核对，所选 {selectedDocuments.length} 份资料属于同一个商品
              <small>{unavailable.length > 0 ? "未识别成功的文件未被采用，请核对上方原因，补充文字或替换原文件。" : "多个商品请分开整理；批量 SKU 库存表请使用亚马逊模板批量导入。"}</small>
            </span>
          </label>
          <button type="button" className={draft.applied ? "secondary-button" : "primary-button"} data-testid="materials-use"
            disabled={locked || !draft.sameProduct || !draft.text.trim() || draft.text.length > 60000 || !selectedDocuments.length || draft.applied}
            onClick={() => {
              if (!draft.preview) return;
              const original = selectedText(draft.preview.documents, draft.selected);
              const accepted = onUse(draft.text, { preview_id: draft.preview.id, document_ids: selectedDocuments.map((document) => document.id), ...(draft.text !== original ? { corrected_text: draft.text } : {}) });
              if (accepted === false) return;
              onChange((current) => ({ ...current, applied: true }));
            }}>
            <Check size={16} />{draft.applied ? "已采用，继续核对下方商品资料" : "使用这些资料"}
          </button>
        </>}
      </div>}
      <p className="material-caption">图片只读取可见文字和备注。材质、尺寸、承重与认证仍需核对，缺失信息保留未知。旧版 .doc / .xls 请先另存为 .docx / .xlsx。</p>
    </section>
  );
}
