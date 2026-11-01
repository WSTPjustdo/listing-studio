import { validateReadinessRegistration } from './seller-workspace.mjs';

const STATUS_LABEL={complete:'商家已登记',blocking:'待登记关键资料',todo:'待补充',warning:'待核实',na:'不适用'};
export {validateReadinessRegistration};
export function buildReadiness(product,options={}){
  const marketplace=options.marketplace||'US',registration=options.registration||null,entries=registration?.items||{},items=[];
  const push=(key,label,status,reason,action)=>{
    const manual=entries[key];
    if(manual&&manual.state!=='not_registered'){
      if(manual.state==='not_applicable'){
        status='warning';reason=`商家登记不适用：${manual.value}。依据：${manual.evidence}；仍需确认适用范围。`;action='核对不适用依据';
      }else{status=key==='compliance'?'warning':'complete';reason=`商家登记：${manual.value}。依据：${manual.evidence}；未向 Amazon 核验。`;action=key==='compliance'?'人工核验资料真实性、型号及适用范围':'';}
    }
    items.push({key,label,status,status_label:STATUS_LABEL[status],reason,action,registration:manual||{state:'not_registered',value:'',evidence:'',note:''}});
  };
  push('brand','品牌信息',product?.brand?.value?'complete':'todo',product?.brand?.value?`商品档案品牌：${product.brand.value}；不表示已核验品牌授权。`:'未登记品牌，或未确认使用 Generic','登记品牌名/授权依据，或确认 Generic');
  push('category','商品分类（Product Type / Browse Node）','todo','尚未登记分类；不表示卖家没有分类资料。','登记 Product Type / Browse Node');
  push('gtin','商品识别码（UPC/EAN/GTIN）','blocking','尚未登记识别码或豁免依据；不表示实际没有识别码。','登记真实识别码，或记录 GTIN 豁免依据');
  const variation=product?.variation;
  push('variation','变体关系',!variation?'na':!variation.parent_sku||!variation.parentage||!variation.theme||!variation.relationship_type?'blocking':'complete',!variation?'当前档案未登记父子变体；请确认确实为单独商品。':`父 SKU：${variation.parent_sku||'未登记'}；主题：${variation.theme||'未登记'}`,'核对父 SKU、变体主题与父子关系');
  push('image','主图','todo','尚未登记图片或外部完成依据；图片内容没有执行自动审核。','登记主图地址或文件名与人工核对记录');
  push('packaging','包装 / 零售件数',product?.retail_pack_count?.value!=null?'complete':'todo',product?.retail_pack_count?.value!=null?`商品档案零售件数：${product.retail_pack_count.value}`:'尚未确认零售件数','登记零售件数与包装核对依据');
  const evidence=product?.evidence_submissions||[];
  push('compliance','合规资料',evidence.length?'warning':'todo',evidence.length?`已提交 ${evidence.length} 份材料，尚未独立核验`:'尚未登记合规资料及适用性判断；并非所有商品都要求同一证书。','登记资料或不适用依据，保留人工核验');
  push('inventory','库存字段（SKU / 配送）',product?.sku?'complete':'todo',product?.sku?`档案 SKU：${product.sku}；库存及配送状态未向平台核验。`:'尚未登记商家 SKU 与配送方式','登记真实 SKU 和配送方式');
  const counted=items.filter(i=>i.status!=='na'),count=status=>counted.filter(i=>i.status===status).length;
  return{marketplace,generated_at:new Date().toISOString(),score:counted.length?Math.round(count('complete')/counted.length*100):0,total:counted.length,complete:count('complete'),blocking:count('blocking'),todo:count('todo'),warning:count('warning'),items,blockers:counted.filter(i=>i.status==='blocking'),registration,listing_version:options.record?.version||null,product_revision:product?.revision||null,notice:'此处衡量本机资料登记完整度，非 Amazon 审核通过率。商家登记不会修改商品参数、代替证据核验或证明已上架；未登记与实际缺失分别对待。'};
}
