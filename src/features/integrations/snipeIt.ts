type SnipeItConfig = {
  url: string
  token: string
}

type SnipeCategory = {
  id: number
  name: string
}

type AssetSummary = {
  totalAssets: number
  totalDeployed: number
  totalReadyToDeploy: number
  totalArchived: number
  totalPending: number
  deployedI5?: number
  deployedI7?: number
  deployedUltra5?: number
  deployedUltra7?: number
  readyToDeployI5?: number
  readyToDeployI7?: number
  readyToDeployUltra5?: number
  readyToDeployUltra7?: number
}

export type SnipeLicense = {
  id: number
  name: string | null
  categoryName: string | null
  manufacturerName: string | null
  seats: number
  freeSeats: number
  expirationDateIso: string | null
  expirationDateFormatted: string | null
  purchaseDateIso: string | null
  purchaseDateFormatted: string | null
  purchaseCost: string | null
  notes: string | null
}

export type GetLicensesResult =
  | {
      success: true
      total: number
      licenses: SnipeLicense[]
      pagination: { limit: number; offset: number; total: number }
    }
  | {
      success: false
      error: string
      licenses: SnipeLicense[]
      total: number
    }

export type GetLicenseByNameResult =
  | {
      success: true
      license: SnipeLicense
    }
  | {
      success: false
      error: string
      suggestions?: string[]
    }

export type GetExpiringLicensesResult =
  | {
      success: true
      total: number
      licenses: SnipeLicense[]
      daysChecked: number
      checkDate: string
    }
  | {
      success: false
      error: string
      licenses: SnipeLicense[]
      total: number
    }

export type LicenseUtilizationCategory = {
  count: number
  totalSeats: number
  usedSeats: number
}

export type LicenseUtilizationData = {
  totalLicenses: number
  categories: Record<string, LicenseUtilizationCategory>
  utilization: {
    fullyUtilized: number
    partiallyUtilized: number
    underUtilized: number
    notUtilized: number
  }
  expiration: {
    expired: number
    expiringSoon: number
    valid: number
    noExpiration: number
  }
}

export type GetLicenseUtilizationResult =
  | {
      success: true
      data: LicenseUtilizationData
      generatedAt: string
    }
  | {
      success: false
      error: string
    }

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase()
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function getSnipeItConfig(): { ok: true; config: SnipeItConfig } | { ok: false; error: string } {
  const url = process.env.SNIPEIT_URL?.trim() ?? ''
  const token = process.env.SNIPEIT_TOKEN?.trim() ?? ''

  if (!url || !token) {
    return {
      ok: false,
      error:
        '*Snipe-IT is not configured.*\n\nPlease set these environment variables:\n- SNIPEIT_URL\n- SNIPEIT_TOKEN',
    }
  }

  return {
    ok: true,
    config: {
      url: normalizeBaseUrl(url),
      token,
    },
  }
}

async function fetchJson(args: {
  config: SnipeItConfig
  pathname: string
  params?: Record<string, string | number>
}): Promise<unknown> {
  const url = new URL(args.pathname.replace(/^\//, ''), `${args.config.url}/`)
  for (const [key, value] of Object.entries(args.params ?? {})) {
    url.searchParams.set(key, String(value))
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${args.config.token}`,
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Snipe-IT request failed (${response.status}): ${text || response.statusText}`)
  }

  return await response.json()
}

function pickRowsArray(data: unknown): unknown[] | null {
  if (!isRecord(data)) return null
  return Array.isArray(data.rows) ? data.rows : null
}

function parseCategories(data: unknown): SnipeCategory[] {
  const rows = pickRowsArray(data)
  if (!rows) return []

  const categories: SnipeCategory[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = toFiniteNumber(row.id)
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (id === null || !name) continue
    categories.push({ id: Math.trunc(id), name })
  }
  return categories
}

function readNestedString(obj: Record<string, unknown>, key: string): string | null {
  const raw = obj[key]
  if (!isRecord(raw)) return null
  const name = raw.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

function readDateParts(raw: unknown): { iso: string | null; formatted: string | null } {
  if (!isRecord(raw)) return { iso: null, formatted: null }
  const iso = typeof raw.date === 'string' && raw.date.trim() ? raw.date.trim() : null
  const formatted = typeof raw.formatted === 'string' && raw.formatted.trim() ? raw.formatted.trim() : null
  return { iso, formatted }
}

function parseLicense(raw: unknown): SnipeLicense | null {
  if (!isRecord(raw)) return null
  const id = toFiniteNumber(raw.id)
  if (id === null) return null

  const expiration = readDateParts(raw.expiration_date)
  const purchaseDate = readDateParts(raw.purchase_date)
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null
  const notes = typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : null
  const purchaseCost =
    typeof raw.purchase_cost === 'number'
      ? String(raw.purchase_cost)
      : typeof raw.purchase_cost === 'string' && raw.purchase_cost.trim()
        ? raw.purchase_cost.trim()
        : null

  return {
    id: Math.trunc(id),
    name,
    categoryName: readNestedString(raw, 'category'),
    manufacturerName: readNestedString(raw, 'manufacturer'),
    seats: Math.max(0, Math.trunc(toFiniteNumber(raw.seats) ?? 0)),
    freeSeats: Math.max(0, Math.trunc(toFiniteNumber(raw.free_seats_count) ?? 0)),
    expirationDateIso: expiration.iso,
    expirationDateFormatted: expiration.formatted,
    purchaseDateIso: purchaseDate.iso,
    purchaseDateFormatted: purchaseDate.formatted,
    purchaseCost,
    notes,
  }
}

function parseLicenses(data: unknown): { total: number; rows: SnipeLicense[] } {
  if (!isRecord(data)) return { total: 0, rows: [] }
  const rows = (Array.isArray(data.rows) ? data.rows : [])
    .map((row) => parseLicense(row))
    .filter((row): row is SnipeLicense => row !== null)
  const totalRaw = toFiniteNumber(data.total)
  return {
    total: totalRaw === null ? rows.length : Math.max(rows.length, Math.trunc(totalRaw)),
    rows,
  }
}

function getAssetStatusName(asset: Record<string, unknown>): string | null {
  const statusLabel = asset.status_label
  if (!isRecord(statusLabel)) return null
  return typeof statusLabel.name === 'string' && statusLabel.name.trim() ? statusLabel.name.trim() : null
}

function getAssetCoreType(asset: Record<string, unknown>): string | null {
  const customFields = asset.custom_fields
  if (!isRecord(customFields)) return null
  const coreTypeField = customFields['Core Type']
  if (!isRecord(coreTypeField)) return null
  return typeof coreTypeField.value === 'string' && coreTypeField.value.trim() ? coreTypeField.value.trim() : null
}

function countStatus(assets: Record<string, unknown>[], statusName: string): number {
  const wanted = normalizeText(statusName)
  return assets.reduce((count, asset) => {
    const status = getAssetStatusName(asset)
    return status && normalizeText(status) === wanted ? count + 1 : count
  }, 0)
}

function countStatusAndCore(assets: Record<string, unknown>[], statusName: string, coreType: string): number {
  const wantedStatus = normalizeText(statusName)
  const wantedCore = normalizeText(coreType)

  return assets.reduce((count, asset) => {
    const status = getAssetStatusName(asset)
    const core = getAssetCoreType(asset)
    if (!status || !core) return count
    if (normalizeText(status) !== wantedStatus) return count
    return normalizeText(core) === wantedCore ? count + 1 : count
  }, 0)
}

function summarizeAssets(args: { assets: Record<string, unknown>[]; categoryName: string }): AssetSummary {
  const { assets, categoryName } = args
  const summary: AssetSummary = {
    totalAssets: assets.length,
    totalDeployed: countStatus(assets, 'deployed'),
    totalReadyToDeploy: countStatus(assets, 'ready to deploy'),
    totalArchived: countStatus(assets, 'archived'),
    totalPending: countStatus(assets, 'pending'),
  }

  if (normalizeText(categoryName) !== 'notebook') return summary

  return {
    ...summary,
    deployedI5: countStatusAndCore(assets, 'deployed', 'i5'),
    deployedI7: countStatusAndCore(assets, 'deployed', 'i7'),
    deployedUltra5: countStatusAndCore(assets, 'deployed', 'Ultra 5'),
    deployedUltra7: countStatusAndCore(assets, 'deployed', 'Ultra 7'),
    readyToDeployI5: countStatusAndCore(assets, 'ready to deploy', 'i5'),
    readyToDeployI7: countStatusAndCore(assets, 'ready to deploy', 'i7'),
    readyToDeployUltra5: countStatusAndCore(assets, 'ready to deploy', 'Ultra 5'),
    readyToDeployUltra7: countStatusAndCore(assets, 'ready to deploy', 'Ultra 7'),
  }
}

async function fetchCategories(config: SnipeItConfig): Promise<SnipeCategory[]> {
  return parseCategories(
    await fetchJson({
      config,
      pathname: '/categories',
      params: { limit: 500, offset: 0 },
    })
  )
}

async function fetchAssetsByCategoryId(config: SnipeItConfig, categoryId: number): Promise<Record<string, unknown>[]> {
  const rows = pickRowsArray(
    await fetchJson({
      config,
      pathname: '/hardware',
      params: { category_id: categoryId, limit: 1000, offset: 0 },
    })
  )

  return (rows ?? []).filter(isRecord)
}

async function fetchLicensesPage(args: {
  config: SnipeItConfig
  limit: number
  offset: number
  search?: string
}): Promise<{ total: number; rows: SnipeLicense[] }> {
  const params: Record<string, string | number> = {
    limit: args.limit,
    offset: args.offset,
    sort: 'created_at',
    order: 'desc',
  }
  if (args.search?.trim()) params.search = args.search.trim()

  return parseLicenses(
    await fetchJson({
      config: args.config,
      pathname: '/licenses',
      params,
    })
  )
}

async function fetchLicenseById(config: SnipeItConfig, id: number): Promise<SnipeLicense | null> {
  return parseLicense(
    await fetchJson({
      config,
      pathname: `/licenses/${id}`,
    })
  )
}

async function fetchAllLicenses(config: SnipeItConfig): Promise<SnipeLicense[]> {
  const pageSize = 500
  let offset = 0
  let total = 0
  const merged: SnipeLicense[] = []

  while (offset === 0 || offset < total) {
    const page = await fetchLicensesPage({ config, limit: pageSize, offset })
    total = page.total
    merged.push(...page.rows)
    if (page.rows.length === 0) break
    offset += pageSize
    if (offset > 10_000) break
  }

  return merged
}

async function getCategoryIdByName(config: SnipeItConfig, categoryName: string): Promise<number | null> {
  const wanted = normalizeText(categoryName)
  const categories = await fetchCategories(config)
  return categories.find((category) => normalizeText(category.name) === wanted)?.id ?? null
}

function formatTwoColumnTable(rows: Array<{ label: string; value: string }>): string {
  const maxLabel = rows.reduce((max, row) => Math.max(max, row.label.length), 0)
  return rows.map((row) => `${row.label.padEnd(maxLabel)}  ${row.value}`).join('\n')
}

function renderAvailableTypesTable(): string {
  const entries = Object.entries(CATEGORY_MAPPING)
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => a.key.localeCompare(b.key))

  const maxKey = entries.reduce((max, entry) => Math.max(max, entry.key.length), 0)
  const header = `${'Type'.padEnd(maxKey)}  Category`
  const lines = entries.map((entry) => `${entry.key.padEnd(maxKey)}  ${entry.name}`)
  return [header, ...lines].join('\n')
}

function renderCategorySummary(categoryName: string, summary: AssetSummary): string {
  const header = `*Snipe-IT Asset Summary*\n*Category:* ${categoryName}`
  const statusTable = formatTwoColumnTable([
    { label: 'Total Assets', value: String(summary.totalAssets) },
    { label: 'Deployed', value: String(summary.totalDeployed) },
    { label: 'Ready to Deploy', value: String(summary.totalReadyToDeploy) },
    { label: 'Archived', value: String(summary.totalArchived) },
    { label: 'Pending', value: String(summary.totalPending) },
  ])

  if (normalizeText(categoryName) !== 'notebook') {
    return `${header}\n\n\`\`\`\n${statusTable}\n\`\`\``
  }

  const coreTable = formatTwoColumnTable([
    {
      label: 'Deployed',
      value: `i5 ${summary.deployedI5 ?? 0} | i7 ${summary.deployedI7 ?? 0} | Ultra 5 ${summary.deployedUltra5 ?? 0} | Ultra 7 ${summary.deployedUltra7 ?? 0}`,
    },
    {
      label: 'Ready to Deploy',
      value: `i5 ${summary.readyToDeployI5 ?? 0} | i7 ${summary.readyToDeployI7 ?? 0} | Ultra 5 ${summary.readyToDeployUltra5 ?? 0} | Ultra 7 ${summary.readyToDeployUltra7 ?? 0}`,
    },
  ])

  return `${header}\n\n\`\`\`\n${statusTable}\n\nCore Type\n${coreTable}\n\`\`\``
}

export async function buildGetAssetReply(messageContent: string): Promise<string> {
  const cfgRes = getSnipeItConfig()
  if (!cfgRes.ok) return cfgRes.error
  const config = cfgRes.config

  const parts = messageContent.split(/\s+/).filter(Boolean)
  const categoryKey = parts[1]

  if (!categoryKey) {
    const categories = [...(await fetchCategories(config))].sort((a, b) => a.name.localeCompare(b.name))
    if (categories.length === 0) return '*No categories found.*'

    const items: Array<{ category: string; total: number }> = []
    for (const category of categories) {
      const assets = await fetchAssetsByCategoryId(config, category.id)
      items.push({ category: category.name, total: assets.length })
    }

    const maxCategory = items.reduce((max, item) => Math.max(max, item.category.length), 0)
    const header = `${'Category'.padEnd(maxCategory)}  Total`
    const lines = items.map((item) => `${item.category.padEnd(maxCategory)}  ${item.total}`)
    const table = [header, ...lines].join('\n')

    return `*Snipe-IT Asset Summary*\n\n\`\`\`\n${table}\n\`\`\`\n\nUse: /getasset <type>\n\`\`\`\n${renderAvailableTypesTable()}\n\`\`\``
  }

  const mapped = CATEGORY_MAPPING[normalizeText(categoryKey)]
  if (!mapped) {
    return `*Unknown asset type:* "${categoryKey}"\n\nUse: /getasset <type>\n\`\`\`\n${renderAvailableTypesTable()}\n\`\`\``
  }

  const categoryId = await getCategoryIdByName(config, mapped)
  if (!categoryId) return `Category "${mapped}" not found.`

  const assets = await fetchAssetsByCategoryId(config, categoryId)
  return renderCategorySummary(mapped, summarizeAssets({ assets, categoryName: mapped }))
}

export async function getLicenses(args?: { limit?: number; offset?: number }): Promise<GetLicensesResult> {
  try {
    const cfgRes = getSnipeItConfig()
    if (!cfgRes.ok) {
      return { success: false, error: cfgRes.error, licenses: [], total: 0 }
    }

    const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.trunc(args?.limit ?? 50)) : 50
    const offset = Number.isFinite(args?.offset) ? Math.max(0, Math.trunc(args?.offset ?? 0)) : 0
    const page = await fetchLicensesPage({ config: cfgRes.config, limit, offset })

    return {
      success: true,
      total: page.total,
      licenses: page.rows,
      pagination: { limit, offset, total: page.total },
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      licenses: [],
      total: 0,
    }
  }
}

export async function getLicenseByName(identifier: string): Promise<GetLicenseByNameResult> {
  try {
    const cfgRes = getSnipeItConfig()
    if (!cfgRes.ok) return { success: false, error: cfgRes.error }

    const query = identifier.trim()
    if (!query) return { success: false, error: 'License identifier is required.' }

    if (/^\d+$/.test(query)) {
      const byId = await fetchLicenseById(cfgRes.config, Number(query))
      if (byId) return { success: true, license: byId }
    }

    const page = await fetchLicensesPage({ config: cfgRes.config, limit: 50, offset: 0, search: query })
    const lowered = query.toLowerCase()
    const exact = page.rows.find((license) => (license.name ?? '').toLowerCase() === lowered)
    const partial = page.rows.find((license) => (license.name ?? '').toLowerCase().includes(lowered))
    const picked = exact ?? partial
    if (picked) return { success: true, license: picked }

    return {
      success: false,
      error: `License '${query}' not found`,
      suggestions: page.rows
        .map((license) => license.name)
        .filter((name): name is string => Boolean(name))
        .slice(0, 5),
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function getExpiringLicenses(days = 30): Promise<GetExpiringLicensesResult> {
  try {
    const cfgRes = getSnipeItConfig()
    if (!cfgRes.ok) return { success: false, error: cfgRes.error, licenses: [], total: 0 }

    const safeDays = Number.isFinite(days) ? Math.max(1, Math.trunc(days)) : 30
    const currentDate = new Date()
    const futureDate = new Date(currentDate)
    futureDate.setDate(futureDate.getDate() + safeDays)

    const licenses = await fetchAllLicenses(cfgRes.config)
    const expiring = licenses
      .filter((license) => {
        if (!license.expirationDateIso) return false
        const expirationDate = new Date(license.expirationDateIso)
        if (Number.isNaN(expirationDate.getTime())) return false
        return expirationDate >= currentDate && expirationDate <= futureDate
      })
      .sort((a, b) => {
        const aTime = a.expirationDateIso ? new Date(a.expirationDateIso).getTime() : Number.POSITIVE_INFINITY
        const bTime = b.expirationDateIso ? new Date(b.expirationDateIso).getTime() : Number.POSITIVE_INFINITY
        return aTime - bTime
      })

    return {
      success: true,
      total: expiring.length,
      licenses: expiring,
      daysChecked: safeDays,
      checkDate: currentDate.toISOString(),
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      licenses: [],
      total: 0,
    }
  }
}

export async function getLicenseUtilization(): Promise<GetLicenseUtilizationResult> {
  try {
    const cfgRes = getSnipeItConfig()
    if (!cfgRes.ok) return { success: false, error: cfgRes.error }

    const licenses = await fetchAllLicenses(cfgRes.config)
    const currentDate = new Date()
    const thirtyDaysFromNow = new Date(currentDate)
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30)

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
    }

    for (const license of licenses) {
      const seats = Math.max(0, license.seats)
      const availableSeats = Math.max(0, license.freeSeats)
      const usedSeats = Math.max(0, seats - availableSeats)
      const utilizationPercent = seats > 0 ? (usedSeats / seats) * 100 : 0

      if (utilizationPercent >= 100) data.utilization.fullyUtilized += 1
      else if (utilizationPercent >= 50) data.utilization.partiallyUtilized += 1
      else if (utilizationPercent > 0) data.utilization.underUtilized += 1
      else data.utilization.notUtilized += 1

      if (license.expirationDateIso) {
        const expirationDate = new Date(license.expirationDateIso)
        if (Number.isNaN(expirationDate.getTime())) data.expiration.noExpiration += 1
        else if (expirationDate < currentDate) data.expiration.expired += 1
        else if (expirationDate <= thirtyDaysFromNow) data.expiration.expiringSoon += 1
        else data.expiration.valid += 1
      } else {
        data.expiration.noExpiration += 1
      }

      const categoryName = license.categoryName ?? 'Uncategorized'
      const category = data.categories[categoryName] ?? { count: 0, totalSeats: 0, usedSeats: 0 }
      category.count += 1
      category.totalSeats += seats
      category.usedSeats += usedSeats
      data.categories[categoryName] = category
    }

    return {
      success: true,
      data,
      generatedAt: currentDate.toISOString(),
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
