export type Brief = { audience: string; use_case: string; concern: string; style: string };
export const defaultBrief: Brief = { audience: '日常购物用户', use_case: '日常携带', concern: '尺寸与使用便利', style: '简洁自然' };
const choices: [keyof Brief, string, string[]][] = [
  ['audience', '目标买家', ['日常购物用户', '活动采购人员', '企业采购人员']],
  ['use_case', '使用场景', ['日常携带', '活动赠品', '企业定制']],
  ['concern', '主要购买顾虑', ['尺寸与使用便利', '材质与规格', '定制适用性']],
  ['style', '表达风格', ['简洁自然', '参数清晰', '场景导向']],
];
export default function ContentBrief({ value, onChange }: { value: Brief; onChange: (brief: Brief) => void }) {
  return <div className="product-edit-grid" aria-label="目标买家与表达方向">{choices.map(([key, label, options]) => <label key={key}>{label}<select value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })}>{options.map(option => <option key={option}>{option}</option>)}</select></label>)}</div>;
}
