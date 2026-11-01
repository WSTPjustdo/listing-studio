import type { Product } from "./types";
import "./merchant-improvements.css";
export const productFields = [
  ["material", "材质"],
  ["dimensions_cm", "尺寸"],
  ["fabric_weight_gsm", "面料克重"],
  ["capacity_l", "容量"],
  ["handle_length_cm", "提手长度"],
  ["rated_load_kg", "额定承重"],
  ["retail_pack_count", "零售件数"],
  ["brand", "品牌"],
  ["color", "颜色"],
] as const;
export function productCompleteness(product: Product) {
  const known = productFields.filter(
    ([key]) =>
      product[key]?.value != null &&
      product[key]?.value !== "" &&
      product[key]?.status !== "unknown",
  );
  const missing = productFields.filter(
    ([key]) => !known.some(([k]) => k === key),
  );
  return { known, missing };
}
export default function ProductCompleteness({
  product,
  onEdit,
  compact = false,
}: {
  product: Product;
  onEdit?: () => void;
  compact?: boolean;
}) {
  const { known, missing } = productCompleteness(product);
  const extras = product.additional_facts?.length || 0;
  // 深度是第三轴，可选项。填了宽高没填深度不算"资料不全"，只说明三轴文案暂不能逐轴对照。
  const depthPending =
    product.dimensions_cm?.value != null &&
    typeof product.dimensions_cm.value.depth !== "number";
  return (
    <section className="product-completeness" aria-label="商品资料完整度">
      <h3>
        资料准备：{known.length} / {productFields.length} 项基础参数已填写
      </h3>
      <p>
        已取得：{known.map(([, label]) => label).join("、") || "暂无基础参数"}
        {extras ? `；另有 ${extras} 条原文资料` : ""}。
      </p>
      <p>
        仍待核对：
        {missing.map(([, label]) => label).join("、") ||
          "基础字段均有值，仍需核对来源与适用变体"}
        。
      </p>
      {depthPending && (
        <p className="helper">
          尺寸只填了宽、高：深度未确认。不影响两轴文法的核对；文案里写成
          「长 × 宽 × 高」的三轴尺寸，会一直停在「深度未确认」而不是判定对错。
        </p>
      )}
      {!compact && (
        <p>
          此清单表示资料是否已填写，不证明参数真实性或上架准备完成。原文尺寸可保留英寸与轴顺序，无需为了填表推算容量、承重或包装。
        </p>
      )}
      {known.length + extras < 5 && (
        <p>
          可用资料较少，先补充有依据的差异化卖点；生成时可少写要点，避免重复凑满五点。
        </p>
      )}
      {onEdit && (
        <button className="text-button" onClick={onEdit}>
          核对参数与原文来源
        </button>
      )}
    </section>
  );
}
