import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, id } from "./domain.mjs";
import { withProjectChecks } from './project-checks.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const loadJson = (path) =>
  JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
export const scenarios = loadJson("amazon-focus/scenarios.json");
/*
 * 规则包按市场分开存，但**默认市场仍是美国站**：
 * 老代码里到处 `import { rulePack }`，那些入口照旧拿到美国包，行为一个字不变；
 * 需要按市场取包的地方（生成链路、规则页）改调 `rulePackFor(marketplace)`。
 * 复制规则内容是不行的（两份迟早对不上），所以这里只做「按 key 选包」。
 */
export const rulePacks = {
  US: loadJson("amazon-focus/rules.json"),
  DE: loadJson("amazon-focus/rules-de.json"),
  /*
   * 英国站（2026-10-31 接通）：法域独立 —— 脱欧后有 UKCA、CMA Green Claims Code、
   * 英国版 GPSR 2005、以 SI 2012/1102 执行的纺织品标注。
   * 10 条里 4 条平台层（标题长度、禁用字符、同词两次、亮点长度）能本地判，
   * 6 条法域规则没有本地实现，一律 not_checked（没有实现就不许给 pass）。
   */
  UK: loadJson("amazon-focus/rules-uk.json"),
  /*
   * 法国站（2026-10-31 接通）：4 条平台层 + 6 条法国/EU 法域。
   * 平台层与英美德同值（同一个帮助页换 locale）；法域层里只有「文案是不是法语」
   * 这条能本地判一半，其余记 not_checked 或只列清单。
   */
  FR: loadJson("amazon-focus/rules-fr.json"),
};
export const DEFAULT_MARKETPLACE = "US";
for (const marketplace of ['UK', 'FR'])
  rulePacks[marketplace] = withProjectChecks(rulePacks[marketplace], rulePacks.US);
export const supportedMarketplaces = () => Object.keys(rulePacks);
/*
 * **生成与批量链路**能看到的市场。比 `supportedMarketplaces()` 窄：
 * 那张表回答的是「引擎取不取得到包」，这张回答的是「敢不敢拿它出文案」。
 *
 * 2026-10-31 把 UK 开进来：链路层该有的都有了（站点选项、locale en-GB、报告、
 * 测试），差的是英国那 6 条法域规则的出处 —— 它们照约定记 not_checked，只列清单
 * 不给结论。所以英国站是「能用，但只对 4 条平台层检查负责」，不是全通。
 *
 * 同一天把 FR 也开进来。法国站比英国站多一条能本地判的东西：法语文案本身
 * （Loi Toubon 第 2 条要求面向法国消费者的商品信息用法语）。所以法国站
 * 是「4 条平台层 + 法语语言要求的候选检测」，其余法域仍只列清单。
 */
export const WORKFLOW_MARKETPLACES = ["US", "DE", "UK", "FR"];
/*
 * 站点 → 允许写哪些语言，以及每种语言能不能直接上架。
 *
 * **语言和规则包在技术上是正交的**：规则包按站点取（决定 75/125、禁用词、法域依据），
 * 文案语言单独选。所以这张表不是技术限制，是**商业限制** —— 列的是"这个语言在这个站点
 * 真的有人看、真的能上架"，不是"引擎能不能写"。
 *
 * 三档的含义：
 *   primary   该站点的主体语言，也是默认选项。
 *   listing   能在该站点上架的第二语言：有平台界面支撑，也确实有人用这种语言买。
 *   internal  **不能直接上架**，只作内部核对或翻译对照。中文在任何站点都是这一档 ——
 *            平台没有中文 listing 这回事，拿中文稿上架美国站没人看得懂。
 *
 * 每站 2–3 种，按市场价值派：美国站和德国站是各自大洲最大的一站，给三种；
 * 英国站与法国站给两种。多出来的那些语言（土耳其语在德国、波兰语在英国）人口不少，
 * 但两个平台都没有对应界面，做了就是假功能，所以不做。
 *
 * 法国站那一条要特别看：法语是 primary，英语是 **internal** 而不是 listing。
 * 原因是法国的 Loi Toubon 第 2 条要求面向消费者的商品信息用法语，而且第 4 条要求
 * 法语版的呈现必须和外语版"同样易读"——只生成一份英文稿时，法国买家拿不到法语版，
 * 这份稿子就不能上架。所以法国站的英语只作翻译对照，界面上要标死。
 */
export const SITE_LANGUAGES = {
  US: [
    { language: "en", tier: "primary", note: "主体语言" },
    { language: "es", tier: "listing", note: "美国西语人口约 6500 万，Amazon.com 有官方西语（es-US）界面" },
    { language: "zh", tier: "internal", note: "内部核对用；平台没有中文 listing" },
  ],
  DE: [
    { language: "de", tier: "primary", note: "主体语言" },
    { language: "en", tier: "listing", note: "Amazon.de 有英文界面；德国英语普及率高，但不是平台首选" },
    { language: "zh", tier: "internal", note: "内部核对用；平台没有中文 listing" },
  ],
  UK: [
    { language: "en", tier: "primary", note: "主体语言（英式英语）" },
    { language: "zh", tier: "internal", note: "内部核对用；平台没有中文 listing" },
  ],
  FR: [
    { language: "fr", tier: "primary", note: "主体语言，且是 Loi Toubon 第 2 条的法定要求" },
    {
      language: "en",
      tier: "internal",
      note: "只作翻译对照：法国要求法语版与外语版同样易读，单份英文稿不能上架",
    },
  ],
};
/** 这个站点能写哪些语言（按表内顺序，第一种是默认）。 */
export const languagesFor = (marketplace) =>
  (SITE_LANGUAGES[normalizeMarketplace(marketplace)] || SITE_LANGUAGES[DEFAULT_MARKETPLACE]).map((item) => item.language);
/** 这个语言在这个站点是什么档位；不在表里返回 null（调用方据此报错，不静默放行）。 */
export const languageTier = (marketplace, language) =>
  SITE_LANGUAGES[normalizeMarketplace(marketplace)]?.find((item) => item.language === language)?.tier ?? null;
/** 每个站点所有可能出现过的语言（用于 zod 枚举与旧记录读取，不用于校验组合）。 */
export const ALL_LANGUAGES = [...new Set(Object.values(SITE_LANGUAGES).flatMap((items) => items.map((item) => item.language)))];
export function normalizeMarketplace(value) {
  const key = String(value ?? DEFAULT_MARKETPLACE).trim().toUpperCase();
  return rulePacks[key] ? key : null;
}
export function rulePackFor(value) {
  const key = normalizeMarketplace(value);
  const pack = key && rulePacks[key];
  if (!pack)
    throw new AppError(
      "UNKNOWN_MARKETPLACE",
      `没有 ${value} 站的规则包；当前支持 ${supportedMarketplaces().join(" / ")}。`,
      400,
    );
  return pack;
}
export const rulePack = rulePacks[DEFAULT_MARKETPLACE];
const publicData = loadJson("data-research/public-product-facts.json");
export const sourceCatalog = [
  ...rulePack.sources,
  ...publicData.sources,
  ...scenarios.sources,
  {
    source_id: "LOCAL-MERCHANT-INPUT",
    kind: "merchant_input",
    url: null,
    description: "在本机商品档案中确认的商家资料，不等同于第三方检测证明。",
  },
];

export function createStore(
  filename = process.env.DATABASE_PATH ||
    resolve(ROOT, ".runtime/listing-studio.sqlite"),
) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS products (id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));
    CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS versions (listing_id TEXT NOT NULL REFERENCES listings(id), version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(listing_id,version));
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS call_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, batch_id TEXT);
    CREATE TABLE IF NOT EXISTS library_entries (product_id TEXT NOT NULL, marketplace TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(product_id,marketplace,revision));
    CREATE TABLE IF NOT EXISTS listing_variant_sets (id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, base_version INTEGER NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_listing_variant_sets_base ON listing_variant_sets(listing_id,base_version,created_at);
  `);
  /*
   * 旧库升级：`call_telemetry` 原来只有 (id, data) 两列，台账里的每一行都不知道自己属于哪一批，
   * 于是「这一批花了多少钱」根本算不出来（第 12 轮实测：300 行批次 600 次调用，能归到它的 0 条）。
   * 新列 batch_id 单独成列而不是塞进 JSON，是为了能走索引按批查，不必把整张表读出来再过滤。
   * CREATE TABLE IF NOT EXISTS 对已存在的表不生效，所以这里补一次 ALTER。
   */
  const telemetryColumns = db.prepare("PRAGMA table_info(call_telemetry)").all().map((column) => column.name);
  if (!telemetryColumns.includes("batch_id"))
    db.exec("ALTER TABLE call_telemetry ADD COLUMN batch_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_call_telemetry_batch ON call_telemetry(batch_id)");
  const libraryColumns = db.prepare("PRAGMA table_info(library_entries)").all();
  if (!libraryColumns.some((column) => column.name === "marketplace" && column.pk > 0)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE library_entries RENAME TO library_entries_legacy");
      db.exec("CREATE TABLE library_entries (product_id TEXT NOT NULL, marketplace TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(product_id,marketplace,revision))");
      const legacyRows = db.prepare("SELECT data FROM library_entries_legacy ORDER BY product_id,revision").all();
      const insert = db.prepare("INSERT INTO library_entries VALUES (?,?,?,?)");
      const version = db.prepare("SELECT data FROM versions WHERE listing_id=? AND version=?");
      for (const row of legacyRows) {
        const entry = JSON.parse(row.data);
        const savedRecord = entry.listing_id && entry.listing_version
          ? version.get(entry.listing_id, entry.listing_version)
          : null;
        const recordMarketplace = savedRecord ? JSON.parse(savedRecord.data).marketplace : null;
        const marketplace = normalizeMarketplace(entry.marketplace || recordMarketplace) || DEFAULT_MARKETPLACE;
        entry.marketplace = marketplace;
        insert.run(entry.product_id, marketplace, entry.revision, JSON.stringify(entry));
      }
      db.exec("DROP TABLE library_entries_legacy");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  for (const profile of scenarios.product_profiles)
    db.prepare("INSERT OR IGNORE INTO products VALUES (?,?,?)").run(
      profile.product_id,
      profile.revision,
      JSON.stringify(profile),
    );
  const reference = publicData.products.find((x) => x.model === "W201");
  const second = structuredClone(scenarios.product_profiles[0]);
  second.product_id = "AMZ-DEMO-TOTE-200";
  second.reference_product_id = reference.product_id;
  second.name_zh = "加厚棉布袋演示商品";
  for (const key of [
    "material",
    "dimensions_cm",
    "fabric_weight_gsm",
    "capacity_l",
    "handle_length_cm",
  ])
    second[key].source_ids = ["SRC-WM-W201"];
  second.fabric_weight_gsm.value = 200;
  db.prepare("INSERT OR IGNORE INTO products VALUES (?,?,?)").run(
    second.product_id,
    1,
    JSON.stringify(second),
  );
  const parse = (row) => (row ? JSON.parse(row.data) : null);
  return {
    researchSettings: () => parse(db.prepare("SELECT data FROM settings WHERE id='research'").get()) || {},
    saveResearchSettings: (value) => db.prepare("INSERT INTO settings VALUES ('research',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(value)),
    research: (key) => parse(db.prepare("SELECT data FROM imports WHERE id=?").get(key)),
    researchHistory: () => db.prepare("SELECT data FROM imports WHERE id LIKE 'research-%' ORDER BY rowid DESC LIMIT 20").all().map(parse),
    saveImport: (value) => db.prepare("INSERT INTO imports VALUES (?,?)").run(value.id, JSON.stringify(value)),
    getImport: (key) => parse(db.prepare("SELECT data FROM imports WHERE id=?").get(key)),
    markImportBatch: (key,batchId) => { const value=parse(db.prepare("SELECT data FROM imports WHERE id=?").get(key)); value.batch_id=batchId; db.prepare("UPDATE imports SET data=? WHERE id=?").run(JSON.stringify(value),key); },
    batches: () => db.prepare("SELECT data FROM batches ORDER BY rowid DESC").all().map(parse),
    batch: (key) => parse(db.prepare("SELECT data FROM batches WHERE id=?").get(key)),
    saveBatch: (value) => db.prepare("INSERT INTO batches VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(value.id, JSON.stringify(value)),
    close: () => db.close(),
    libraryEntries: () => db.prepare('SELECT data FROM library_entries e WHERE revision=(SELECT MAX(revision) FROM library_entries WHERE product_id=e.product_id AND marketplace=e.marketplace)').all().map(parse),
    libraryEntry: (productId, marketplace = DEFAULT_MARKETPLACE) => parse(db.prepare('SELECT data FROM library_entries WHERE product_id=? AND marketplace=? ORDER BY revision DESC LIMIT 1').get(productId, normalizeMarketplace(marketplace) || DEFAULT_MARKETPLACE)),
    saveLibraryEntry: (entry) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const marketplace = normalizeMarketplace(entry.marketplace) || DEFAULT_MARKETPLACE;
        const current = db.prepare('SELECT MAX(revision) AS revision FROM library_entries WHERE product_id=? AND marketplace=?').get(entry.product_id, marketplace);
        if ((current.revision || 0) + 1 !== entry.revision) throw new AppError('STALE_LIBRARY_ENTRY', '台账已更新，请刷新后重试。', 409);
        db.prepare('INSERT INTO library_entries VALUES (?,?,?,?)').run(entry.product_id, marketplace, entry.revision, JSON.stringify({ ...entry, marketplace }));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return entry;
    },
    latestVariantSet: (listingId, baseVersion) => parse(db.prepare('SELECT data FROM listing_variant_sets WHERE listing_id=? AND base_version=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(listingId, baseVersion)),
    variantSet: (variantSetId) => parse(db.prepare('SELECT data FROM listing_variant_sets WHERE id=?').get(variantSetId)),
    saveVariantSet: (variantSet) => db.prepare('INSERT INTO listing_variant_sets VALUES (?,?,?,?,?)').run(variantSet.variant_set_id, variantSet.listing_id, variantSet.base_version, variantSet.generated_at, JSON.stringify(variantSet)),
    allLatestListings: () => db.prepare('SELECT v.data FROM versions v WHERE v.version=(SELECT MAX(version) FROM versions WHERE listing_id=v.listing_id) ORDER BY v.rowid DESC').all().map(parse),
    sources: () => [...sourceCatalog, ...db.prepare("SELECT data FROM sources ORDER BY id").all().map(parse)],
    saveCallTelemetry: row => db.prepare('INSERT INTO call_telemetry (data, batch_id) VALUES (?,?)').run(JSON.stringify(row), row.batch_id ?? null),
    callTelemetry: (limit = 50) => db.prepare('SELECT data FROM call_telemetry ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, Math.floor(Number(limit) || 50)))).map(parse),
    /**
     * 某一批的全部调用记录。**不套 500 条上限**：2000 行一批是 4000 次调用，
     * 沿用全局台账那个上限会把成本悄悄截掉 87.5%，报出来的钱比真花的少。
     * 上限 50000 只是防呆（一批最多 2000 行 × 重试几次也不会到这个量级）。
     */
    callTelemetryForBatch: (batchId, limit = 50000) => db.prepare('SELECT data FROM call_telemetry WHERE batch_id=? ORDER BY id DESC LIMIT ?')
      .all(batchId, Math.min(50000, Math.max(1, Math.floor(Number(limit) || 50000)))).map(parse),
    callTelemetryUnattributed: () => db.prepare('SELECT COUNT(*) AS n FROM call_telemetry WHERE batch_id IS NULL').get().n,
    saveSource: (source) => db.prepare("INSERT OR IGNORE INTO sources VALUES (?,?)").run(source.source_id, JSON.stringify(source)),
    saveHandoffEvidence: (profile, sources, preview, handoff) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare('SELECT MAX(revision) AS revision FROM products WHERE id=?').get(profile.product_id);
        const latest = db.prepare('SELECT MAX(version) AS version FROM versions WHERE listing_id=?').get(handoff.listing_id);
        const stored = parse(db.prepare('SELECT data FROM imports WHERE id=?').get(preview.id));
        if (current.revision + 1 !== profile.revision || latest.version !== handoff.listing_version || stored?.confirmed_at)
          throw new AppError('STALE_HANDOFF', '商品、文案或回传状态已更新，请重新上传。', 409);
        for (const source of sources) db.prepare('INSERT INTO sources VALUES (?,?)').run(source.source_id, JSON.stringify(source));
        db.prepare('INSERT INTO products VALUES (?,?,?)').run(profile.product_id, profile.revision, JSON.stringify(profile));
        db.prepare('UPDATE imports SET data=? WHERE id=?').run(JSON.stringify(preview), preview.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    saveProductWithSources: (profile, sources) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current=db.prepare('SELECT MAX(revision) AS revision FROM products WHERE id=?').get(profile.product_id);
        if((current.revision || 0)+1!==profile.revision)throw new AppError('STALE_PRODUCT','商品已更新，请刷新。',409);
        for(const source of sources){
          const saved=db.prepare('SELECT data FROM sources WHERE id=?').get(source.source_id);
          if(saved && saved.data!==JSON.stringify(source))throw new AppError('SOURCE_CONFLICT','来源记录已存在且内容不同，请重新读取。',409);
          if(!saved)db.prepare('INSERT INTO sources VALUES (?,?)').run(source.source_id,JSON.stringify(source));
        }
        db.prepare('INSERT INTO products VALUES (?,?,?)').run(profile.product_id,profile.revision,JSON.stringify(profile));
        db.exec('COMMIT');
      } catch(error) {db.exec('ROLLBACK');throw error;}
    },
    saveProductWithSource: (profile, source) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare('SELECT MAX(revision) AS revision FROM products WHERE id=?').get(profile.product_id);
        if (current.revision + 1 !== profile.revision) throw new AppError('STALE_PRODUCT', '商品已更新，请刷新。', 409);
        db.prepare('INSERT INTO sources VALUES (?,?)').run(source.source_id, JSON.stringify(source));
        db.prepare('INSERT INTO products VALUES (?,?,?)').run(profile.product_id, profile.revision, JSON.stringify(profile));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    products: () =>
      db
        .prepare(
          "SELECT data FROM products p WHERE revision=(SELECT MAX(revision) FROM products WHERE id=p.id) ORDER BY id",
        )
        .all()
        .map(parse),
    product: (productId, revision) =>
      parse(
        revision
          ? db
              .prepare("SELECT data FROM products WHERE id=? AND revision=?")
              .get(productId, revision)
          : db
              .prepare(
                "SELECT data FROM products WHERE id=? ORDER BY revision DESC LIMIT 1",
              )
              .get(productId),
      ),
    saveProduct: (profile) => {
      const current = db
        .prepare("SELECT MAX(revision) AS revision FROM products WHERE id=?")
        .get(profile.product_id);
      if (current.revision + 1 !== profile.revision)
        throw new AppError("STALE_PRODUCT", "商品已有新版本，请刷新。", 409);
      db.prepare("INSERT INTO products VALUES (?,?,?)").run(
        profile.product_id,
        profile.revision,
        JSON.stringify(profile),
      );
      return profile;
    },
    createRun: (input) => {
      const run = {
        run_id: id("run"),
        status: "queued",
        stage: "等待处理",
        created_at: new Date().toISOString(),
        ...input,
      };
      db.prepare("INSERT INTO runs VALUES (?,?)").run(
        run.run_id,
        JSON.stringify(run),
      );
      return run;
    },
    run: (runId) =>
      parse(db.prepare("SELECT data FROM runs WHERE id=?").get(runId)),
    updateRun: (runId, patch) => {
      const run = parse(
        db.prepare("SELECT data FROM runs WHERE id=?").get(runId),
      );
      Object.assign(run, patch);
      db.prepare("UPDATE runs SET data=? WHERE id=?").run(
        JSON.stringify(run),
        runId,
      );
      return run;
    },
    runs: () =>
      db
        .prepare("SELECT data FROM runs ORDER BY rowid DESC LIMIT 100")
        .all()
        .map(parse),
    list: () =>
      db
        .prepare(
          "SELECT v.data FROM versions v WHERE v.version=(SELECT MAX(version) FROM versions WHERE listing_id=v.listing_id) ORDER BY v.rowid DESC LIMIT 100",
        )
        .all()
        .map(parse),
    latest: (listingId) =>
      parse(
        db
          .prepare(
            "SELECT data FROM versions WHERE listing_id=? ORDER BY version DESC LIMIT 1",
          )
          .get(listingId),
      ),
    versions: (listingId) =>
      db
        .prepare(
          "SELECT data FROM versions WHERE listing_id=? ORDER BY version",
        )
        .all(listingId)
        .map(parse),
    version: (listingId, version) =>
      parse(
        db
          .prepare("SELECT data FROM versions WHERE listing_id=? AND version=?")
          .get(listingId, version),
      ),
    saveVersion: (record) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const latest = db
          .prepare(
            "SELECT MAX(version) AS version FROM versions WHERE listing_id=?",
          )
          .get(record.listing_id);
        const next = (latest.version || 0) + 1;
        if (record.version !== next)
          throw new AppError(
            "STALE_VERSION",
            "当前任务已有新版本，请刷新后重试。",
            409,
          );
        db.prepare("INSERT OR IGNORE INTO listings VALUES (?,?,?)").run(
          record.listing_id,
          record.workflow,
          record.created_at,
        );
        db.prepare("INSERT INTO versions VALUES (?,?,?)").run(
          record.listing_id,
          record.version,
          JSON.stringify(record),
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return record;
    },
    settings: () =>
      parse(
        db.prepare("SELECT data FROM settings WHERE id='provider'").get(),
      ) || {},
    saveSettings: (settings) =>
      db
        .prepare(
          "INSERT INTO settings VALUES ('provider',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(JSON.stringify(settings)),
    /**
     * 把 WAL 里的页并回主文件并截断 WAL。
     *
     * 为什么需要它：第 7 轮量到——点「清除密钥」后接口已经读不回 Key（逻辑上删了），
     * 但 sqlite 的 `-wal` 文件里还留着 152KB 旧页，逐字节仍能搜到那个 Key 一次；
     * 要等到服务关掉（WAL 落盘）才归零。**删了但没删干净**，对一个自称"只在本机"的工具是硬伤。
     *
     * `TRUNCATE` 而不是 `PASSIVE`：只有前者会把文件长度真的截到 0。
     * 失败不抛——别的连接占着读锁时 checkpoint 会返回忙，这只影响"彻底干净"，
     * 不该让保存设置这件事整体失败。
     */
    checkpoint: () => {
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* 忙碌时下次再说 */ }
    },
    interruptRuns: () => {
      for (const row of db.prepare("SELECT id,data FROM runs").all()) {
        const run = JSON.parse(row.data);
        if (["queued", "running"].includes(run.status))
          db.prepare("UPDATE runs SET data=? WHERE id=?").run(
            JSON.stringify({
              ...run,
              status: "failed",
              stage: "服务重启",
              error: {
                code: "INTERRUPTED",
                message: "运行因服务重启中断，请重新提交。",
              },
              finished_at: new Date().toISOString(),
            }),
            row.id,
          );
      }
    },
  };
}
