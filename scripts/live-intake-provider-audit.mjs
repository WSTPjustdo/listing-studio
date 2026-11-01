// Real-fetch observation for isolated acceptance. No response substitution, headers or credentials logged.
import fs from 'node:fs';
import path from 'node:path';
const database = process.env.DATABASE_PATH;
if (!database || !path.resolve(database).startsWith(path.resolve('.runtime') + path.sep))
  throw new Error('Live intake audit requires an isolated .runtime DATABASE_PATH.');
const directory = path.dirname(path.resolve(database));
const actualFetch = globalThis.fetch;
globalThis.fetch = async (resource, options) => {
  const resourceUrl = typeof resource === 'string' || resource instanceof URL ? String(resource) : resource.url;
  if (new URL(resourceUrl).hostname !== 'api.deepseek.com') return actualFetch(resource, options);
  const payload = JSON.parse(options.body);
  const userContent = payload.messages.find(item => item.role === 'user')?.content;
  const userText = Array.isArray(userContent) ? userContent.filter(item => item.type === 'text').map(item => item.text).join('\n') : userContent;
  let request = {};
  try { request = JSON.parse(userText); } catch { /* Observe metadata without changing a real request. */ }
  const started = Date.now();
  const response = await actualFetch(resource, options);
  const raw = await response.clone().text();
  let body;
  try { body = JSON.parse(raw); } catch { body = {}; }
  const row = {
    at: new Date().toISOString(), operation: request.operation || (request.merchant_text !== undefined ? 'product_analysis' : 'unknown'), model: body.model || payload.model,
    selected_terms: request.competitor_research?.selected_terms || request.selected_terms || [],
    allowed_fields: request.allowed_fields || null,
    intake_role: request.intake_context?.role || null,
    product_id: request.product?.product_id || null,
    guided_mode: request.mode || null,
    marketplace: request.marketplace || null,
    locale: request.locale || null,
    language: request.language || null,
    rule_pack_version: request.rule_pack_version || null,
    source_ids: Array.isArray(request.sources) ? request.sources.map(source => source.source_id) : [],
    has_image: Array.isArray(userContent) && userContent.some(item => item.type === 'image_url'),
    request_id: body.id || response.headers.get('x-request-id') || null,
    elapsed_ms: Date.now() - started, http_status: response.status, usage: body.usage || null,
  };
  fs.appendFileSync(path.join(directory, 'provider-audit.jsonl'), JSON.stringify(row) + '\n');
  fs.writeFileSync(path.join(directory, `private-response-${started}.json`), raw);
  return response;
};
