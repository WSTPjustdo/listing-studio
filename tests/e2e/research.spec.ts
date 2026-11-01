import { test, expect } from '@playwright/test';

test('research flow combines sources, requires candidate selection, sends style and opens editable draft', async ({ page }) => {
  const bootstrap = await (await page.request.get('/api/bootstrap')).json();
  const created = await (await page.request.post('/api/listings/create', { data: { product_id: bootstrap.products[0].product_id } })).json();
  let done = created;
  for (let i=0;i<100 && done.status !== 'succeeded';i++) { await new Promise(r=>setTimeout(r,50)); done = await (await page.request.get(`/api/runs/${created.run_id}`)).json(); }
  const analysis = { id: 'analysis-browser', name: '测试棉布袋', category: '棉布手提袋', search_query: 'cotton tote', observations: ['黑色提手'], facts: [{ label: '材质', value: '100% cotton', source: 'merchant_text', evidence: '100% cotton' }, { label: '尺寸', value: '15 x 16 inches', source: 'own_link', evidence: '15 x 16 inches' }], missing: [], own_link: { url: 'https://www.amazon.com/dp/B000000001' } };
  await page.route('**/api/research/analyze', route => route.fulfill({ json: analysis }));
  await page.route('**/api/research/product', async route => {
    const input = route.request().postDataJSON(); expect(input.analysis_id).toBe('analysis-browser'); expect(input.facts).toContain('15 x 16 inches');
    await route.fulfill({ json: bootstrap.products[0] });
  });
  await page.route('**/api/research/search', async route => {
    expect(route.request().postDataJSON().comparison.target_price).toBe(10);
    await route.fulfill({ json: { id: 'research-browser', query: 'cotton tote', checked_at: new Date().toISOString(), items: [{ asin: 'B000000002', url: 'https://www.amazon.com/dp/B000000002', title: 'Cotton tote zipper bag', brand: 'Test Brand', bullets: ['Zipper closure'], specifications: [], price: 11, currency: 'USD', rating: 4.5, comparison: { status: 'potential', matched: ['cotton'], missing: [], notes: ['品牌溢价、客群与质量定位尚未核实'] } }], terms: [{ term: 'cotton', count: 1, asins: ['B000000002'] }] } });
  });
  await page.route('**/api/research/generate', async route => {
    const input = route.request().postDataJSON(); expect(input.selected_asins).toEqual(['B000000002']); expect(input.terms).toEqual(['cotton']); expect(input.style).toBe('Professional and concise');
    await route.fulfill({ json: done });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '图片与竞品研究', exact: true }).click();
  await page.getByLabel('商品文字说明与参数').fill('Material: 100% cotton');
  await page.getByLabel('自己的 Amazon US 商品链接或 ASIN（可选）').fill('B000000001');
  await page.getByRole('button', { name: '识别图片与提取参数', exact: true }).click();
  await expect(page.getByLabel('提取的参数（可直接修改，保留单位）')).toHaveValue(/15 x 16 inches/);
  await page.getByLabel('这是自己的棉布手提袋，以上文字资料可用于文案').check();
  await page.getByRole('button', { name: '保存并选用此商品' }).click();
  await page.getByLabel('自己的销售总价（USD，可选）').fill('10');
  await page.getByRole('button', { name: '搜索候选商品', exact: true }).click();
  await expect(page.getByText('价格与文字初筛匹配 · 待核实')).toBeVisible();
  await expect(page.getByRole('button', { name: '生成优化后的英文草稿' })).toBeDisabled();
  await page.getByLabel('已核对价格、规格与品牌定位，纳入竞品池').check();
  await page.locator('.research-terms input').check();
  await page.getByLabel('自定义风格（可修改）').fill('Professional and concise');
  await page.getByRole('button', { name: '生成优化后的英文草稿' }).click();
  await page.getByRole('button', { name: '打开草稿并手动编辑' }).click();
  await expect(page.locator('.version-badge')).toHaveText('V1');
});

test('research missing configuration fails clearly and fits mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '图片与竞品研究', exact: true }).click();
  await page.getByText(/接口连接 ·/).click();
  await page.getByLabel('商品数据来源').selectOption('rainforest');
  await page.getByRole('button', { name: '保存接口配置', exact: true }).click();
  await expect(page.getByText('配置已保存在本机。')).toBeVisible();
  await page.getByLabel('英文搜索词').fill('cotton tote');
  await page.getByRole('button', { name: '搜索候选商品', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Rainforest API Key');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/research-mobile.png', fullPage: true });
});


test('local provider saves delivery ZIP and shows unverified prices', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '图片与竞品研究', exact: true }).click();
  await page.getByText(/接口连接 ·/).click();
  await page.getByLabel('商品数据来源').selectOption('local');
  await page.getByLabel('美国配送邮编（本地爬虫）').fill('90001');
  await page.getByRole('button', { name: '保存接口配置', exact: true }).click();
  await expect(page.getByText('配置已保存在本机。')).toBeVisible();
  const config = await (await page.request.get('/api/research/config')).json();
  expect(config.amazon_provider).toBe('local'); expect(config.postal_code).toBe('90001');
  await page.route('**/api/research/search', r => r.fulfill({ json: { id:'research-local', query:'cotton', checked_at:new Date().toISOString(), items:[{asin:'B0819W9CSW',url:'https://www.amazon.com/dp/B0819W9CSW',title:'Cotton tote',brand:'',price:8.99,currency:'USD',rating:null,bullets:[],specifications:[],delivery:{verified:false,visible_delivery_location:'Deliver to China'},missing_fields:['details'],comparison:{status:'needs_review',matched:[],missing:[],notes:[]}}],terms:[] } }));
  await page.getByLabel('英文搜索词').fill('cotton tote');
  await page.getByRole('button', { name:'搜索候选商品',exact:true }).click();
  await expect(page.getByText(/邮编未验证，价格不可直接比较/)).toBeVisible();
  await expect(page.getByText('缺失字段：details')).toBeVisible();
});
