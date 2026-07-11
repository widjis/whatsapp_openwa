import axios from 'axios';

export const CATEGORY_MAPPING: Record<string, string> = {
  mouse: 'Mouse',
  switch: 'Switch',
  tablet: 'Tablet',
  pc: 'PC Desktop',
  ht: 'HT',
  phone: 'Mobile Phone [Non Assets]',
  monitor: 'Monitor',
  sim: 'SIM CARD',
  notebook: 'Notebook',
  license: 'Misc Software',
  software: 'Software License',
  antivirus: 'Antivirus License',
  office: 'Office License',
  windows: 'Windows License',
  adobe: 'Adobe License',
  cad: 'CAD License',
  database: 'Database License',
  security: 'Security Software License',
};

type SnipeItConfig = {
  url: string;
  token: string;
};

type SnipeCategory = {
  id: number;
  name: string;
};

type AssetSummary = {
  totalAssets: number;
  totalDeployed: number;
  totalReadyToDeploy: number;
  totalArchived: number;
  totalPending: number;
  deployedI5?: number;
  deployedI7?: number;
  deployedUltra5?: number;
  deployedUltra7?: number;
  readyToDeployI5?: number;
  readyToDeployI7?: number;
  readyToDeployUltra5?: number;
  readyToDeployUltra7?: number;
};

export type SnipeLicense = {
  id: number;
  name: string | null;
  categoryName: string | null;
  manufacturerName: string | null;
  seats: number;
  freeSeats: number;
  expirationDateIso: string | null;
  expirationDateFormatted: string | null;
  purchaseDateIso: string | null;
  purchaseDateFormatted: string | null;
  purchaseCost: string | null;
  notes: string | null;
};

export type GetLicensesResult =
  | { success: true; total: number; licenses: SnipeLicense[]; pagination: { limit: number; offset: number; total: number } }
  | { success: false; error: string; licenses: SnipeLicense[]; total: number };

export type GetLicenseByNameResult =
  | { success: true; license: SnipeLicense }
  | { success: false; error: string; suggestions?: string[] };

export type GetExpiringLicensesResult =
  | { success: true; total: number; licenses: SnipeLicense[]; daysChecked: number; checkDate: string }
  | { success: false; error: string; licenses: SnipeLicense[]; total: number };

export type LicenseUtilizationCategory = {
  count: number;
  totalSeats: number;
  usedSeats: number;
};

export type LicenseUtilizationData = {
  totalLicenses: number;
  categories: Record<string, LicenseUtilizationCategory>;
  utilization: {
    fullyUtilized: number;
    partiallyUtilized: number;
    underUtilized: number;
    notUtilized: number;
  };
  expiration: {
    expired: number;
    expiringSoon: number;
    valid: number;
    noExpiration: number;
  };
};

export type GetLicenseUtilizationResult =
  | { success: true; data: LicenseUtilizationData; generatedAt: string }
  | { success: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function getSnipeItConfig(): { ok: true; config: SnipeItConfig } | { ok: false; error: string } {
  const urlRaw = process.env.SNIPEIT_URL;
  const tokenRaw = process.env.SNIPEIT_TOKEN;
  const url = typeof urlRaw === 'string' ? urlRaw.trim() : '';
  const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : '';

  if (!url || !token) {
    return {
      ok: false,
      error:
        '*Snipe-IT is not configured.*\n\nPlease set these environment variables:\n- SNIPEIT_URL\n- SNIPEIT_TOKEN',
    };
  }

  return { ok: true, config: { url: normalizeBaseUrl(url), token } };
}

function pickRowsArray(data: unknown): unknown[] | null {
  if (!isRecord(data)) return null;
  const rows = data.rows;
  return Array.isArray(rows) ? rows : null;
}

function parseCategories(data: unknown): SnipeCategory[] {
  const rows = pickRowsArray(data);
  if (!rows) return [];

  const categories: SnipeCategory[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = row.id;
    const name = row.name;
    if (typeof id !== 'number' || !Number.isFinite(id)) continue;
    if (typeof name !== 'string' || !name.trim()) continue;
    categories.push({ id, name: name.trim() });
  }
  return categories;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readNestedString(obj: Record<string, unknown>, key: string): string | null {
  const raw = obj[key];
  if (!isRecord(raw)) return null;
  const name = raw.name;
  if (typeof name !== 'string' || !name.trim()) return null;
  return name.trim();
}

function readDateParts(raw: unknown): { iso: string | null; formatted: string | null } {
  if (!isRecord(raw)) return { iso: null, formatted: null };
  const date = typeof raw.date === 'string' && raw.date.trim() ? raw.date.trim() : null;
  const formatted = typeof raw.formatted === 'string' && raw.formatted.trim() ? raw.formatted.trim() : null;
  return { iso: date, formatted };
}

function parseLicense(raw: unknown): SnipeLicense | null {
  if (!isRecord(raw)) return null;
  const idRaw = toFiniteNumber(raw.id);
  if (idRaw === null) return null;

  const seatsRaw = toFiniteNumber(raw.seats);
  const freeSeatsRaw = toFiniteNumber(raw.free_seats_count);
  const expiration = readDateParts(raw.expiration_date);
  const purchaseDate = readDateParts(raw.purchase_date);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  const notes = typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : null;
  const purchaseCost =
    typeof raw.purchase_cost === 'number'
      ? String(raw.purchase_cost)
      : typeof raw.purchase_cost === 'string' && raw.purchase_cost.trim()
        ? raw.purchase_cost.trim()
        : null;

  return {
    id: Math.trunc(idRaw),
    name,
    categoryName: readNestedString(raw, 'category'),
    manufacturerName: readNestedString(raw, 'manufacturer'),
    seats: seatsRaw === null ? 0 : Math.max(0, Math.trunc(seatsRaw)),
    freeSeats: freeSeatsRaw === null ? 0 : Math.max(0, Math.trunc(freeSeatsRaw)),
    expirationDateIso: expiration.iso,
    expirationDateFormatted: expiration.formatted,
    purchaseDateIso: purchaseDate.iso,
    purchaseDateFormatted: purchaseDate.formatted,
    purchaseCost,
    notes,
  };
}

function parseLicenses(data: unknown): { total: number; rows: SnipeLicense[] } {
  if (!isRecord(data)) return { total: 0, rows: [] };
  const rowsUnknown = Array.isArray(data.rows) ? data.rows : [];
  const rows = rowsUnknown
    .map((r) => parseLicense(r))
    .filter((r): r is SnipeLicense => r !== null);
  const totalRaw = toFiniteNumber(data.total);
  return { total: totalRaw === null ? rows.length : Math.max(rows.length, Math.trunc(totalRaw)) , rows };
}

function getAssetStatusName(asset: Record<string, unknown>): string | null {
  const statusLabel = asset.status_label;
  if (!isRecord(statusLabel)) return null;
  const name = statusLabel.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function getAssetCoreType(asset: Record<string, unknown>): string | null {
  const customFields = asset.custom_fields;
  if (!isRecord(customFields)) return null;

  const coreTypeField = customFields['Core Type'];
  if (!isRecord(coreTypeField)) return null;
  const value = coreTypeField.value;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function countStatus(assets: Record<string, unknown>[], statusName: string): number {
  const want = normalizeText(statusName);
  let count = 0;
  for (const asset of assets) {
    const status = getAssetStatusName(asset);
    if (!status) continue;
    if (normalizeText(status) === want) count += 1;
  }
  return count;
}

function countStatusAndCore(assets: Record<string, unknown>[], statusName: string, coreType: string): number {
  const wantStatus = normalizeText(statusName);
  const wantCore = normalizeText(coreType);

  let count = 0;
  for (const asset of assets) {
    const status = getAssetStatusName(asset);
    if (!status) continue;
    if (normalizeText(status) !== wantStatus) continue;

    const core = getAssetCoreType(asset);
    if (!core) continue;
    if (normalizeText(core) === wantCore) count += 1;
  }
  return count;
}

function summarizeAssets(args: { assets: Record<string, unknown>[]; categoryName: string }): AssetSummary {
  const { assets, categoryName } = args;
  const totalAssets = assets.length;
  const totalDeployed = countStatus(assets, 'deployed');
  const totalReadyToDeploy = countStatus(assets, 'ready to deploy');
  const totalArchived = countStatus(assets, 'archived');
  const totalPending = countStatus(assets, 'pending');

  if (normalizeText(categoryName) !== 'notebook') {
    return { totalAssets, totalDeployed, totalReadyToDeploy, totalArchived, totalPending };
  }

  return {
    totalAssets,
    totalDeployed,
    deployedI5: countStatusAndCore(assets, 'deployed', 'i5'),
    deployedI7: countStatusAndCore(assets, 'deployed', 'i7'),
    deployedUltra5: countStatusAndCore(assets, 'deployed', 'Ultra 5'),
    deployedUltra7: countStatusAndCore(assets, 'deployed', 'Ultra 7'),
    totalReadyToDeploy,
    readyToDeployI5: countStatusAndCore(assets, 'ready to deploy', 'i5'),
    readyToDeployI7: countStatusAndCore(assets, 'ready to deploy', 'i7'),
    readyToDeployUltra5: countStatusAndCore(assets, 'ready to deploy', 'Ultra 5'),
    readyToDeployUltra7: countStatusAndCore(assets, 'ready to deploy', 'Ultra 7'),
    totalArchived,
    totalPending,
  };
}

async function fetchCategories(config: SnipeItConfig): Promise<SnipeCategory[]> {
  const response = await axios.get<unknown>(`${config.url}/categories`, {
    headers: { Authorization: `Bearer ${config.token}` },
    params: { limit: 500, offset: 0 },
  });
  return parseCategories(response.data);
}

async function fetchAssetsByCategoryId(config: SnipeItConfig, categoryId: number): Promise<Record<string, unknown>[]> {
  const response = await axios.get<unknown>(`${config.url}/hardware`, {
    headers: { Authorization: `Bearer ${config.token}` },
    params: { category_id: categoryId, limit: 1000, offset: 0 },
  });
  const rows = pickRowsArray(response.data);
  if (!rows) return [];
  return rows.filter(isRecord);
}

async function fetchLicensesPage(args: {
  config: SnipeItConfig;
  limit: number;
  offset: number;
  search?: string;
}): Promise<{ total: number; rows: SnipeLicense[] }> {
  const params: Record<string, string | number> = {
    limit: args.limit,
    offset: args.offset,
    sort: 'created_at',
    order: 'desc',
  };
  if (args.search && args.search.trim()) params.search = args.search.trim();

  const response = await axios.get<unknown>(`${args.config.url}/licenses`, {
    headers: { Authorization: `Bearer ${args.config.token}` },
    params,
  });
  return parseLicenses(response.data);
}

async function fetchLicenseById(config: SnipeItConfig, id: number): Promise<SnipeLicense | null> {
  const response = await axios.get<unknown>(`${config.url}/licenses/${id}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  return parseLicense(response.data);
}

async function fetchAllLicenses(config: SnipeItConfig): Promise<SnipeLicense[]> {
  const pageSize = 500;
  let offset = 0;
  let total = 0;
  const merged: SnipeLicense[] = [];

  while (offset === 0 || offset < total) {
    const page = await fetchLicensesPage({ config, limit: pageSize, offset });
    total = page.total;
    merged.push(...page.rows);
    if (page.rows.length === 0) break;
    offset += pageSize;
    if (offset > 10_000) break;
  }

  return merged;
}

async function getCategoryIdByName(config: SnipeItConfig, categoryName: string): Promise<number | null> {
  const categories = await fetchCategories(config);
  const want = normalizeText(categoryName);
  const hit = categories.find((c) => normalizeText(c.name) === want);
  return hit?.id ?? null;
}

function formatTwoColumnTable(rows: Array<{ label: string; value: string }>): string {
  const maxLabel = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  return rows.map((r) => `${r.label.padEnd(maxLabel)}  ${r.value}`).join('\n');
}

function renderAvailableTypesTable(): string {
  const entries = Object.entries(CATEGORY_MAPPING)
    .map(([k, v]) => ({ key: k, name: v }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const maxKey = entries.reduce((m, e) => Math.max(m, e.key.length), 0);
  const header = `${'Type'.padEnd(maxKey)}  Category`;
  const lines = entries.map((e) => `${e.key.padEnd(maxKey)}  ${e.name}`);
  return [header, ...lines].join('\n');
}

function renderCategorySummary(categoryName: string, summary: AssetSummary): string {
  const header = `*Snipe-IT Asset Summary*\n*Category:* ${categoryName}`;
  const statusTable = formatTwoColumnTable([
    { label: 'Total Assets', value: String(summary.totalAssets) },
    { label: 'Deployed', value: String(summary.totalDeployed) },
    { label: 'Ready to Deploy', value: String(summary.totalReadyToDeploy) },
    { label: 'Archived', value: String(summary.totalArchived) },
    { label: 'Pending', value: String(summary.totalPending) },
  ]);

  if (normalizeText(categoryName) !== 'notebook') {
    return `${header}\n\n\`\`\`\n${statusTable}\n\`\`\``;
  }

  const coreDeployed = `i5 ${summary.deployedI5 ?? 0} | i7 ${summary.deployedI7 ?? 0} | Ultra 5 ${summary.deployedUltra5 ?? 0} | Ultra 7 ${summary.deployedUltra7 ?? 0}`;
  const coreReady = `i5 ${summary.readyToDeployI5 ?? 0} | i7 ${summary.readyToDeployI7 ?? 0} | Ultra 5 ${summary.readyToDeployUltra5 ?? 0} | Ultra 7 ${summary.readyToDeployUltra7 ?? 0}`;
  const coreTable = formatTwoColumnTable([
    { label: 'Deployed', value: coreDeployed },
    { label: 'Ready to Deploy', value: coreReady },
  ]);

  return `${header}\n\n\`\`\`\n${statusTable}\n\nCore Type\n${coreTable}\n\`\`\``;
}

export async function buildGetAssetReply(messageContent: string): Promise<string> {
  const cfgRes = getSnipeItConfig();
  if (!cfgRes.ok) return cfgRes.error;
  const config = cfgRes.config;

  const parts = messageContent.split(/\s+/).filter(Boolean);
  const categoryKey = parts[1];

  if (!categoryKey) {
    const categories = await fetchCategories(config);
    if (categories.length === 0) return '*No categories found.*';

    const sorted = [...categories].sort((a, b) => a.name.localeCompare(b.name));
    const items: Array<{ category: string; total: number }> = [];
    for (const category of sorted) {
      const assets = await fetchAssetsByCategoryId(config, category.id);
      items.push({ category: category.name, total: assets.length });
    }

    const maxCat = items.reduce((m, i) => Math.max(m, i.category.length), 0);
    const header = `${'Category'.padEnd(maxCat)}  Total`;
    const lines = items.map((i) => `${i.category.padEnd(maxCat)}  ${String(i.total)}`);
    const table = [header, ...lines].join('\n');

    return `*Snipe-IT Asset Summary*\n\n\`\`\`\n${table}\n\`\`\`\n\nUse: /getasset <type>\n\`\`\`\n${renderAvailableTypesTable()}\n\`\`\``;
  }

  const mapped = CATEGORY_MAPPING[normalizeText(categoryKey)];
  if (!mapped) {
    return (
      `*Unknown asset type:* "${categoryKey}"\n\n`
      + `Use: /getasset <type>\n\`\`\`\n${renderAvailableTypesTable()}\n\`\`\``
    );
  }

  const categoryId = await getCategoryIdByName(config, mapped);
  if (!categoryId) return `Category "${mapped}" not found.`;

  const assets = await fetchAssetsByCategoryId(config, categoryId);
  const summary = summarizeAssets({ assets, categoryName: mapped });
  return renderCategorySummary(mapped, summary);
}

export async function getLicenses(args?: { limit?: number; offset?: number }): Promise<GetLicensesResult> {
  try {
    const cfgRes = getSnipeItConfig();
    if (!cfgRes.ok) {
      return { success: false, error: cfgRes.error, licenses: [], total: 0 };
    }

    const limitValue = args?.limit;
    const offsetValue = args?.offset;
    const limit = typeof limitValue === 'number' && Number.isFinite(limitValue) ? Math.max(1, Math.trunc(limitValue)) : 50;
    const offset = typeof offsetValue === 'number' && Number.isFinite(offsetValue) ? Math.max(0, Math.trunc(offsetValue)) : 0;

    const page = await fetchLicensesPage({ config: cfgRes.config, limit, offset });
    return {
      success: true,
      total: page.total,
      licenses: page.rows,
      pagination: { limit, offset, total: page.total },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message, licenses: [], total: 0 };
  }
}

export async function getLicenseByName(identifier: string): Promise<GetLicenseByNameResult> {
  try {
    const cfgRes = getSnipeItConfig();
    if (!cfgRes.ok) return { success: false, error: cfgRes.error };

    const query = identifier.trim();
    if (!query) return { success: false, error: 'License identifier is required.' };

    if (/^\d+$/.test(query)) {
      const byId = await fetchLicenseById(cfgRes.config, Number(query));
      if (byId) return { success: true, license: byId };
    }

    const page = await fetchLicensesPage({ config: cfgRes.config, limit: 50, offset: 0, search: query });
    const lowered = query.toLowerCase();
    const exact = page.rows.find((item) => (item.name ?? '').toLowerCase() === lowered);
    const partial = page.rows.find((item) => (item.name ?? '').toLowerCase().includes(lowered));
    const picked = exact ?? partial;
    if (picked) return { success: true, license: picked };

    const suggestions = page.rows.map((item) => item.name).filter((name): name is string => Boolean(name)).slice(0, 5);
    return { success: false, error: `License '${query}' not found`, suggestions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export async function getExpiringLicenses(days = 30): Promise<GetExpiringLicensesResult> {
  try {
    const cfgRes = getSnipeItConfig();
    if (!cfgRes.ok) return { success: false, error: cfgRes.error, licenses: [], total: 0 };

    const safeDays = Number.isFinite(days) ? Math.max(1, Math.trunc(days)) : 30;
    const currentDate = new Date();
    const futureDate = new Date(currentDate);
    futureDate.setDate(futureDate.getDate() + safeDays);

    const licenses = await fetchAllLicenses(cfgRes.config);
    const expiring = licenses
      .filter((license) => {
        if (!license.expirationDateIso) return false;
        const expirationDate = new Date(license.expirationDateIso);
        if (Number.isNaN(expirationDate.getTime())) return false;
        return expirationDate >= currentDate && expirationDate <= futureDate;
      })
      .sort((a, b) => {
        const aTime = a.expirationDateIso ? new Date(a.expirationDateIso).getTime() : Number.POSITIVE_INFINITY;
        const bTime = b.expirationDateIso ? new Date(b.expirationDateIso).getTime() : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });

    return {
      success: true,
      total: expiring.length,
      licenses: expiring,
      daysChecked: safeDays,
      checkDate: currentDate.toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message, licenses: [], total: 0 };
  }
}

export async function getLicenseUtilization(): Promise<GetLicenseUtilizationResult> {
  try {
    const cfgRes = getSnipeItConfig();
    if (!cfgRes.ok) return { success: false, error: cfgRes.error };

    const licenses = await fetchAllLicenses(cfgRes.config);
    const currentDate = new Date();
    const thirtyDaysFromNow = new Date(currentDate);
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const data: LicenseUtilizationData = {
      totalLicenses: licenses.length,
      categories: {},
      utilization: {
        fullyUtilized: 0,
        partiallyUtilized: 0,
        underUtilized: 0,
        notUtilized: 0,
      },
      expiration: {
        expired: 0,
        expiringSoon: 0,
        valid: 0,
        noExpiration: 0,
      },
    };

    for (const license of licenses) {
      const seats = Math.max(0, license.seats);
      const availableSeats = Math.max(0, license.freeSeats);
      const usedSeats = Math.max(0, seats - availableSeats);
      const utilizationPercent = seats > 0 ? (usedSeats / seats) * 100 : 0;

      if (utilizationPercent >= 100) data.utilization.fullyUtilized += 1;
      else if (utilizationPercent >= 50) data.utilization.partiallyUtilized += 1;
      else if (utilizationPercent > 0) data.utilization.underUtilized += 1;
      else data.utilization.notUtilized += 1;

      if (license.expirationDateIso) {
        const expirationDate = new Date(license.expirationDateIso);
        if (Number.isNaN(expirationDate.getTime())) data.expiration.noExpiration += 1;
        else if (expirationDate < currentDate) data.expiration.expired += 1;
        else if (expirationDate <= thirtyDaysFromNow) data.expiration.expiringSoon += 1;
        else data.expiration.valid += 1;
      } else {
        data.expiration.noExpiration += 1;
      }

      const categoryName = license.categoryName ?? 'Uncategorized';
      const category = data.categories[categoryName] ?? { count: 0, totalSeats: 0, usedSeats: 0 };
      category.count += 1;
      category.totalSeats += seats;
      category.usedSeats += usedSeats;
      data.categories[categoryName] = category;
    }

    return { success: true, data, generatedAt: currentDate.toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
