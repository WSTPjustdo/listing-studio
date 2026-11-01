// 四站点规则现状：把 US / UK / DE / FR 四个市场的规则差异摆在一起。
// 只展示各站点已知的规则侧重与官方来源，不代替官方全文核验。
const SITE_PROFILES = [
  {
    market: "US",
    label: "美国 US",
    accent: "#1d4ed8",
    checks: [
      "本机规则包：标题 ≤75 / 亮点 ≤125 字符",
      "FTC 环保 / 性能 / 认证宣称审查",
      "联系方式、促销语、价格禁用",
      "GTIN / 品牌 / Product Type 上架字段",
    ],
    sources: [
      {
        name: "Seller Central · US",
        url: "https://sellercentral.amazon.com/help/hub",
      },
      {
        name: "FTC Green Guides",
        url: "https://www.ftc.gov/business-guidance/resources/environmental-claims-summary-green-guides",
      },
    ],
  },
  {
    market: "UK",
    label: "英国 UK",
    accent: "#047857",
    checks: [
      "英式英语（colour / organise）",
      "英国商品安全（先确认类目适用范围）",
      "塑料袋收费、纺织品标注适用性",
      "英国法域规则尚未本地核验",
    ],
    sources: [
      {
        name: "Seller Central · Europe",
        url: "https://sellercentral-europe.amazon.com/help/hub",
      },
      {
        name: "UK Product Safety",
        url: "https://www.gov.uk/guidance/product-safety-advice-for-businesses",
      },
    ],
  },
  {
    market: "DE",
    label: "德国 DE",
    accent: "#b45309",
    checks: [
      "GPSR 责任方与安全信息",
      "德语纤维成分 100 % Baumwolle",
      "德语单位 38 × 42 cm / 140 g/m²",
      "德国法域宣称与认证",
    ],
    sources: [
      {
        name: "Seller Central · Europe",
        url: "https://sellercentral-europe.amazon.com/help/hub",
      },
      { name: "EU Commission", url: "https://commission.europa.eu/law_en" },
    ],
  },
  {
    market: "FR",
    label: "法国 FR",
    accent: "#7c3aed",
    checks: [
      "Loi Toubon 法语强制",
      "法语纤维成分标注（尚待核验）",
      "Triman / EPR 适用性（尚待核验）",
      "法国法域环保宣称（尚待核验）",
    ],
    sources: [
      {
        name: "Seller Central · Europe",
        url: "https://sellercentral-europe.amazon.com/help/hub",
      },
      { name: "EU Commission", url: "https://commission.europa.eu/law_en" },
    ],
  },
];

export default function SiteRuleProfiles({
  rulePackVersions = {},
}: {
  rulePackVersions?: Record<string, string>;
}) {
  return (
    <section style={{ display: "grid", gap: "12px" }}>
      <div>
        <h2 style={{ fontSize: "15px", margin: 0 }}>四站点规则现状</h2>
        <p
          style={{
            margin: "5px 0 0",
            color: "#6b7280",
            fontSize: "12px",
            lineHeight: 1.65,
          }}
        >
          以下是本机当前规则包的核验主题与官方入口，适用范围以「规则与来源」为准；关注清单不代表已完成检查或已合规。一站点的变化不会自动适用于其他站点。
        </p>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
          gap: "12px",
        }}
      >
        {SITE_PROFILES.map((site) => (
          <div
            key={site.market}
            style={{
              background: "#fff",
              border: "1px solid #e6e8ed",
              borderTop: `3px solid ${site.accent}`,
              borderRadius: "10px",
              padding: "14px 16px",
              display: "grid",
              gap: "8px",
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                flexWrap: "wrap",
                gap: "8px",
              }}
            >
              <strong style={{ fontSize: "14px", color: site.accent }}>
                {site.label}
              </strong>
              <span
                style={{
                  fontSize: "11px",
                  color: "#6b7280",
                  overflowWrap: "anywhere",
                }}
              >
                {rulePackVersions[site.market]
                  ? `包 ${rulePackVersions[site.market]}`
                  : "包版本未加载"}
              </span>
            </div>
            <ul
              style={{
                margin: 0,
                paddingLeft: "18px",
                fontSize: "12px",
                color: "#4b5563",
                lineHeight: 1.8,
              }}
            >
              {site.checks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "8px",
                marginTop: "2px",
              }}
            >
              {site.sources.map((source) => (
                <a
                  key={source.name}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: "11px",
                    color: site.accent,
                    textDecoration: "none",
                  }}
                >
                  {source.name} ↗
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
