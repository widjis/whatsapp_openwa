import axios from 'axios'
import https from 'node:https'
import OpenAI from 'openai'

type ServiceDeskCategory = {
  name?: string
}

export type ServiceDeskAttachment = {
  id?: string
  name: string
  content_url: string
  content_type: string
}

type ServiceDeskDisplayTime = {
  display_value?: string
}

type ServiceDeskRequester = {
  name?: string
  email_id?: string
  mobile?: string
}

type ServiceDeskTechnician = {
  name?: string
}

type ServiceDeskGroup = {
  name?: string
}

type ServiceDeskTemplate = {
  is_service_template?: boolean
  name?: string
  id?: string
}

type ServiceDeskUdfFields = {
  udf_pick_601?: string | null
}

export type ServiceDeskRequest = {
  id: string
  subject?: string
  description?: string
  requester?: ServiceDeskRequester
  service_category?: ServiceDeskCategory
  template?: ServiceDeskTemplate
  status?: ServiceDeskCategory
  priority?: ServiceDeskCategory
  group?: ServiceDeskGroup
  udf_fields?: ServiceDeskUdfFields
  technician?: ServiceDeskTechnician
  created_time?: ServiceDeskDisplayTime
  attachments?: ServiceDeskAttachment[]
}

type ServiceDeskListRequest = {
  id: string
  created_time?: ServiceDeskDisplayTime
}

type ServiceDeskViewResponse = {
  request?: ServiceDeskRequest
}

type ServiceDeskListResponse = {
  requests?: ServiceDeskListRequest[]
}

type UpdateRequestArgs = {
  templateId?: string
  templateName?: string
  isServiceTemplate?: boolean
  serviceCategory?: string
  status?: string
  groupName?: string | null
  technicianName?: string | null
  ictTechnician?: string | null
  priority?: string
}

export type UpdateRequestResult = {
  success: boolean
  message: string
}

type ServiceDeskUrls = {
  apiBaseUrl: string
  hostBaseUrl: string
}

const httpsAgent = new https.Agent({ rejectUnauthorized: false })
const DEBUG_SERVICEDESK_UPDATES = process.env.DEBUG_SERVICEDESK_UPDATES === 'true'

const serviceCategories = [
  '01. PC/Laptop',
  '02. Office Application',
  '03. Printer&Scanner',
  '04. IT Peripheral',
  '05. LED Monitor',
  '06. Television',
  '07. Merdeka System Apps',
  '08. File Server',
  '09. Network',
  '10. Radio HT',
  '11. Deskphone',
  '12. Access Card',
  '13. CCTV',
  '14. IT Service Request Form',
  '15. Other',
  '16. IT System and Mail',
  '17. IT Project Related to System',
  '18. IT Project Related to Network',
  '19. Preventive Maintenance Support',
  '20. Preventive Maintenance Network',
  '21. Document Control',
]

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} must be set in environment`)
  return value
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function formatDebugValue(value: unknown): string {
  if (value === undefined) return '-'
  if (value === null) return '<null>'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'object') {
    try {
      const text = JSON.stringify(value)
      return text.length > 120 ? `${text.slice(0, 117)}...` : text
    } catch {
      return '[object]'
    }
  }

  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) return '""'
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

function formatDebugLine(details: Record<string, unknown>, preferredOrder: string[] = []): string {
  const keys = new Set<string>([...preferredOrder, ...Object.keys(details)])
  return Array.from(keys)
    .filter((key) => key in details)
    .map((key) => `${key}=${formatDebugValue(details[key])}`)
    .join(' | ')
}

function summarizeUpdateRequest(request: Record<string, unknown>): Record<string, unknown> {
  const status = (request.status as { name?: string } | undefined)?.name ?? null
  const priority = (request.priority as { name?: string } | undefined)?.name ?? null
  const group = request.group === null ? '<clear>' : ((request.group as { name?: string } | undefined)?.name ?? null)
  const technician =
    request.technician === null ? '<clear>' : ((request.technician as { name?: string } | undefined)?.name ?? null)
  const ictTechnician =
    request.udf_fields && typeof request.udf_fields === 'object'
      ? ((request.udf_fields as { udf_pick_601?: string | null }).udf_pick_601 ?? '<clear>')
      : null

  return {
    status,
    priority,
    group,
    technician,
    ictTechnician,
    fields: Object.keys(request).join(','),
  }
}

function isServiceCategoryAiEnabled(): boolean {
  const raw = getOptionalEnv('SERVICE_CATEGORY_AI_ENABLED')
  if (!raw) return true
  return raw.toLowerCase() !== 'false'
}

function getServiceDeskUrls(): ServiceDeskUrls {
  const rawApiBase = requireEnv('SD_BASE_URL')
  const apiBaseUrl = rawApiBase.endsWith('/') ? rawApiBase.slice(0, -1) : rawApiBase
  const hostBaseUrl = apiBaseUrl.endsWith('/api/v3') ? apiBaseUrl.slice(0, -'/api/v3'.length) : apiBaseUrl
  return { apiBaseUrl, hostBaseUrl }
}

function getServiceDeskHeaders(): Record<string, string> {
  return {
    authtoken: requireEnv('SERVICE_DESK_TOKEN'),
    'Content-Type': 'application/x-www-form-urlencoded',
  }
}

function normalizeCategoryText(subject: string, description: string): string {
  const combined = `${subject} ${description}`.toLowerCase()
  return combined.replace(/<[^>]*>/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
}

function guessServiceCategoryFromText(subject: string, description: string): string {
  const text = ` ${normalizeCategoryText(subject, description)} `
  const rules: Array<{ category: string; keywords: string[] }> = [
    { category: '14. IT Service Request Form', keywords: ['service request form', 'srf', 'form'] },
    { category: '03. Printer&Scanner', keywords: ['printer', 'scanner', 'scan'] },
    { category: '09. Network', keywords: ['lan', 'wifi', 'network', 'internet', 'kabel', 'cable', 'switch', 'router', 'vpn', 'ip'] },
    { category: '08. File Server', keywords: ['file server', 'fileserver', 'shared folder', 'share folder', 'nas'] },
    { category: '02. Office Application', keywords: ['office', 'excel', 'word', 'powerpoint', 'ppt'] },
    { category: '16. IT System and Mail', keywords: ['email', 'mail', 'outlook', 'smtp'] },
    { category: '13. CCTV', keywords: ['cctv', 'camera'] },
    { category: '12. Access Card', keywords: ['access card', 'rfid', 'door access'] },
    { category: '11. Deskphone', keywords: ['deskphone', 'extension', 'pabx'] },
    { category: '10. Radio HT', keywords: ['radio', 'ht'] },
    { category: '05. LED Monitor', keywords: ['monitor'] },
    { category: '04. IT Peripheral', keywords: ['mouse', 'keyboard', 'webcam', 'headset', 'speaker'] },
    { category: '01. PC/Laptop', keywords: ['laptop', 'notebook', 'pc', 'komputer', 'computer'] },
    { category: '06. Television', keywords: ['television', 'tv'] },
    { category: '21. Document Control', keywords: ['document control'] },
    { category: '15. Other', keywords: [] },
  ]

  let bestCategory = '15. Other'
  let bestScore = 0

  for (const rule of rules) {
    let score = 0
    for (const keyword of rule.keywords) {
      const normalizedKeyword = ` ${keyword.replace(/[^a-z0-9]+/g, ' ').trim()} `
      if (normalizedKeyword.trim() && text.includes(normalizedKeyword)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      bestCategory = rule.category
    }
  }

  return bestCategory
}

function getOpenAiClient(): OpenAI {
  return new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') })
}

async function getAnswerAI(prompt: string): Promise<string> {
  const openai = getOpenAiClient()
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  })
  return response.choices[0]?.message?.content ?? ''
}

export async function viewRequest(requestId: string): Promise<ServiceDeskRequest | null> {
  const { apiBaseUrl } = getServiceDeskUrls()
  const url = `${apiBaseUrl}/requests/${encodeURIComponent(requestId)}`

  try {
    const response = await axios.get<ServiceDeskViewResponse>(url, {
      headers: getServiceDeskHeaders(),
      httpsAgent,
    })
    return response.data.request ?? null
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      const message = error.response?.data ? JSON.stringify(error.response.data) : error.message
      console.error(`ServiceDesk viewRequest failed${status ? ` (${status})` : ''}: ${message}`)
      return null
    }
    console.error(`ServiceDesk viewRequest failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export async function downloadServiceDeskAttachment(args: { contentUrl: string }): Promise<Buffer> {
  const { hostBaseUrl } = getServiceDeskUrls()
  const headers = getServiceDeskHeaders()
  const raw = args.contentUrl.trim()
  const downloadUrl = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `${hostBaseUrl}${raw}`

  const response = await axios.get<ArrayBuffer>(downloadUrl, {
    headers,
    httpsAgent,
    responseType: 'arraybuffer',
  })

  return Buffer.from(response.data)
}

export async function updateRequest(requestId: string, args: UpdateRequestArgs): Promise<UpdateRequestResult> {
  const { apiBaseUrl } = getServiceDeskUrls()
  const url = `${apiBaseUrl}/requests/${encodeURIComponent(requestId)}`

  const request: Record<string, unknown> = {}
  if (args.priority?.trim()) request.priority = { name: args.priority.trim() }
  if (args.status?.trim()) request.status = { name: args.status.trim() }
  if (args.serviceCategory?.trim()) request.service_category = { name: args.serviceCategory.trim() }
  if (args.groupName === null) request.group = null
  else if (args.groupName?.trim()) request.group = { name: args.groupName.trim() }
  if (args.technicianName === null) request.technician = null
  else if (args.technicianName?.trim()) request.technician = { name: args.technicianName.trim() }
  if (args.ictTechnician === null) request.udf_fields = { udf_pick_601: null }
  else if (args.ictTechnician?.trim()) request.udf_fields = { udf_pick_601: args.ictTechnician.trim() }

  if (args.templateId?.trim() && args.templateName?.trim()) {
    request.template = {
      is_service_template: args.isServiceTemplate ?? false,
      name: args.templateName.trim(),
      id: args.templateId.trim(),
      service_category: args.serviceCategory?.trim() ? { name: args.serviceCategory.trim() } : null,
    }
  }

  if (Object.keys(request).length < 1) {
    return { success: false, message: 'No fields to update.' }
  }

  const payload = new URLSearchParams({
    input_data: JSON.stringify({ request }),
  })

  if (DEBUG_SERVICEDESK_UPDATES) {
    console.log(
      '[servicedesk:update_request]',
      formatDebugLine(
        {
          requestId,
          ...summarizeUpdateRequest(request),
          url,
        },
        ['requestId', 'status', 'priority', 'group', 'technician', 'ictTechnician', 'fields', 'url']
      )
    )
  }

  try {
    const response = await axios.put(url, payload.toString(), {
      headers: getServiceDeskHeaders(),
      httpsAgent,
    })
    if (DEBUG_SERVICEDESK_UPDATES) {
      console.log(
        '[servicedesk:update_response]',
        formatDebugLine(
          {
            requestId,
            httpStatus: response.status,
            responseKeys:
              response.data && typeof response.data === 'object' ? Object.keys(response.data as Record<string, unknown>).join(',') : null,
            data: response.data ?? null,
          },
          ['requestId', 'httpStatus', 'responseKeys', 'data']
        )
      )
    }
    return { success: true, message: 'Request updated successfully.' }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      const message = error.response?.data ? JSON.stringify(error.response.data) : error.message
      return { success: false, message: `HTTP error${status ? ` (${status})` : ''}: ${message}` }
    }
    return { success: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function assignTechnicianToRequest(args: {
  requestId: string
  groupName: string
  technicianName: string
}): Promise<UpdateRequestResult> {
  const { apiBaseUrl } = getServiceDeskUrls()
  const url = `${apiBaseUrl}/requests/${encodeURIComponent(args.requestId)}/assign`
  const payload = new URLSearchParams({
    input_data: JSON.stringify({
      request: {
        group: { name: args.groupName },
        technician: { name: args.technicianName },
      },
    }),
  })

  try {
    await axios.put(url, payload.toString(), {
      headers: getServiceDeskHeaders(),
      httpsAgent,
    })
    return { success: true, message: 'Request assigned successfully.' }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      const message = error.response?.data ? JSON.stringify(error.response.data) : error.message
      return { success: false, message: `HTTP error${status ? ` (${status})` : ''}: ${message}` }
    }
    return { success: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function getAllRequests(days = 7): Promise<string[]> {
  const { apiBaseUrl } = getServiceDeskUrls()
  const url = `${apiBaseUrl}/requests`
  const maxRows = 100
  const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  let startIndex = 1
  const filteredRequests: string[] = []
  let continueFetching = true

  while (continueFetching) {
    const params = {
      list_info: {
        row_count: maxRows,
        start_index: startIndex,
        sort_field: 'created_time',
        sort_order: 'desc',
        get_total_count: true,
      },
    }

    try {
      const response = await axios.get<ServiceDeskListResponse>(url, {
        headers: getServiceDeskHeaders(),
        params: { input_data: JSON.stringify(params) },
        httpsAgent,
      })

      const requests = response.data.requests ?? []
      for (const request of requests) {
        const requestId = request.id
        const createdTimeStr = request.created_time?.display_value

        if (!createdTimeStr) continue
        const createdTime = new Date(createdTimeStr)
        if (createdTime >= threshold) {
          filteredRequests.push(requestId)
          continue
        }

        continueFetching = false
        break
      }

      if (requests.length < maxRows) break
      startIndex += maxRows
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status
        const message = error.response?.data ? JSON.stringify(error.response.data) : error.message
        console.error(`ServiceDesk getAllRequests failed${status ? ` (${status})` : ''}: ${message}`)
        return filteredRequests
      }
      console.error(`ServiceDesk getAllRequests failed: ${error instanceof Error ? error.message : String(error)}`)
      return filteredRequests
    }
  }

  return filteredRequests
}

export function buildTicketLink(ticketId: string): string {
  const { hostBaseUrl } = getServiceDeskUrls()
  const base = hostBaseUrl.endsWith('/') ? hostBaseUrl.slice(0, -1) : hostBaseUrl
  return `${base}/WorkOrder.do?woMode=viewWO&woID=${encodeURIComponent(ticketId)}`
}

export async function defineServiceCategory(requestId: string): Promise<string | null> {
  const request = await viewRequest(requestId)
  if (!request) return null

  const subject = request.subject ?? ''
  const description = request.description ?? ''
  if (!subject && !description) return null

  const heuristic = guessServiceCategoryFromText(subject, description)
  if (!isServiceCategoryAiEnabled()) return heuristic
  if (!getOptionalEnv('OPENAI_API_KEY')) return heuristic

  try {
    const prompt =
      `Here is a list of service categories: ${serviceCategories.join(', ')}.\n` +
      `Based on the following subject and description, select the most appropriate category.\n` +
      `Subject: ${subject}\nDescription: ${description}\n` +
      'Answer only with the service category.'
    const answer = await getAnswerAI(prompt)
    for (const category of serviceCategories) {
      const suffix = category.split('. ')[1] ?? category
      if (answer.toLowerCase().includes(suffix.toLowerCase())) return category
    }
  } catch (error) {
    console.error(`ServiceDesk category AI skipped: ${error instanceof Error ? error.message : String(error)}`)
  }

  return heuristic
}
