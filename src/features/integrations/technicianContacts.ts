import fs from 'node:fs'
import path from 'node:path'

export type TechnicianContact = {
  id: number
  name: string
  ict_name: string
  leave_schedule_name?: string | null
  phone: string
  email: string | null
  technician: string
  gender?: string | null
  laps_access?: boolean
}

export type TechnicianContactInput = Omit<TechnicianContact, 'id'>

export type TechnicianContactUpdateField =
  | 'name'
  | 'ict_name'
  | 'leave_schedule_name'
  | 'phone'
  | 'email'
  | 'technician'
  | 'gender'
  | 'laps_access'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function resolveDataDir(): string {
  const envDir = process.env.DATA_DIR?.trim()
  if (envDir) return envDir
  return path.resolve(process.cwd(), 'data')
}

function resolveContactsPath(): string {
  return path.join(resolveDataDir(), 'technicianContacts.json')
}

export function getTechnicianContactsPath(): string {
  return resolveContactsPath()
}

export function normalizeTechnicianPhoneNumber(number: string): string {
  let formatted = number.replace(/\D/g, '')
  if (formatted.startsWith('0')) {
    formatted = `62${formatted.slice(1)}`
  }
  return formatted
}

function parseContact(raw: unknown, fallbackId: number): TechnicianContact | null {
  if (!isRecord(raw)) return null

  const idRaw = raw.id
  const id = typeof idRaw === 'number' && Number.isFinite(idRaw) ? idRaw : fallbackId

  const name = typeof raw.name === 'string' ? raw.name : ''
  const ictName = typeof raw.ict_name === 'string' ? raw.ict_name : ''
  const leaveScheduleNameRaw = raw.leave_schedule_name
  const leaveScheduleName =
    typeof leaveScheduleNameRaw === 'string' ? leaveScheduleNameRaw : leaveScheduleNameRaw === null ? null : undefined
  const phoneRaw = typeof raw.phone === 'string' ? raw.phone : ''
  const phone = normalizeTechnicianPhoneNumber(phoneRaw)

  const emailRaw = raw.email
  const email = typeof emailRaw === 'string' ? emailRaw : emailRaw === null ? null : null

  const technician = typeof raw.technician === 'string' ? raw.technician : ''
  const genderRaw = raw.gender
  const gender = typeof genderRaw === 'string' ? genderRaw : genderRaw === null ? null : undefined

  if (!name || !ictName || !phone || !technician) return null

  const lapsAccessRaw = raw.laps_access
  const laps_access = typeof lapsAccessRaw === 'boolean' ? lapsAccessRaw : false

  return {
    id,
    name,
    ict_name: ictName,
    leave_schedule_name: leaveScheduleName,
    phone,
    email,
    technician,
    gender,
    laps_access,
  }
}

export function loadTechnicianContacts(): TechnicianContact[] {
  const contactsPath = resolveContactsPath()
  if (!fs.existsSync(contactsPath)) return []

  try {
    const rawText = fs.readFileSync(contactsPath, 'utf-8')
    const parsed: unknown = JSON.parse(rawText)
    if (!Array.isArray(parsed)) return []

    const contacts: TechnicianContact[] = []
    for (let index = 0; index < parsed.length; index += 1) {
      const contact = parseContact(parsed[index], index + 1)
      if (contact) contacts.push(contact)
    }

    const usedIds = new Set<number>()
    const normalized: TechnicianContact[] = []
    let nextId = 1

    for (const contact of contacts) {
      while (usedIds.has(nextId)) nextId += 1
      const id = usedIds.has(contact.id) ? nextId : contact.id
      usedIds.add(id)
      normalized.push({ ...contact, id })
      if (id === nextId) nextId += 1
    }

    return normalized
  } catch {
    return []
  }
}

export function saveTechnicianContacts(contacts: TechnicianContact[]): void {
  const contactsPath = resolveContactsPath()
  const dir = path.dirname(contactsPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(contactsPath, JSON.stringify(contacts, null, 2))
}

export function listTechnicianContacts(): TechnicianContact[] {
  return loadTechnicianContacts().sort((a, b) => a.id - b.id)
}

export function searchTechnicianContacts(query: string): TechnicianContact[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []

  return listTechnicianContacts().filter((contact) => {
    const haystack = [
      contact.name,
      contact.ict_name,
      contact.leave_schedule_name ?? '',
      contact.phone,
      contact.email ?? '',
      contact.technician,
      contact.gender ?? '',
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(normalizedQuery)
  })
}

export function getTechnicianContactById(id: number): TechnicianContact | undefined {
  return listTechnicianContacts().find((contact) => contact.id === id)
}

export function getContactByPhone(phone: string): TechnicianContact | undefined {
  const normalizedPhone = normalizeTechnicianPhoneNumber(phone)
  if (!normalizedPhone) return undefined
  return listTechnicianContacts().find((contact) => contact.phone === normalizedPhone)
}

export function getContactByIctTechnicianName(name: string): TechnicianContact | undefined {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return undefined

  return listTechnicianContacts().find((contact) => {
    return (
      contact.ict_name.trim().toLowerCase() === normalized ||
      contact.name.trim().toLowerCase() === normalized
    )
  })
}

export function addTechnicianContact(input: TechnicianContactInput): TechnicianContact {
  const contacts = listTechnicianContacts()
  const maxId = contacts.reduce((max, contact) => Math.max(max, contact.id), 0)
  const created: TechnicianContact = {
    id: maxId + 1,
    name: input.name,
    ict_name: input.ict_name,
    leave_schedule_name: input.leave_schedule_name,
    phone: normalizeTechnicianPhoneNumber(input.phone),
    email: input.email,
    technician: input.technician,
    gender: input.gender,
    laps_access: input.laps_access ?? false,
  }

  saveTechnicianContacts([...contacts, created])
  return created
}

export function updateTechnicianContact(
  id: number,
  field: TechnicianContactUpdateField,
  value: string
): TechnicianContact | null {
  const contacts = listTechnicianContacts()
  const index = contacts.findIndex((contact) => contact.id === id)
  if (index === -1) return null

  const next: TechnicianContact = { ...contacts[index] }

  if (field === 'name') {
    next.name = value
  } else if (field === 'ict_name') {
    next.ict_name = value
  } else if (field === 'leave_schedule_name') {
    const trimmed = value.trim()
    next.leave_schedule_name = trimmed.toLowerCase() === 'null' || trimmed === '-' || trimmed === '' ? null : trimmed
  } else if (field === 'phone') {
    next.phone = normalizeTechnicianPhoneNumber(value)
  } else if (field === 'email') {
    const trimmed = value.trim()
    next.email = trimmed.toLowerCase() === 'null' || trimmed === '-' || trimmed === '' ? null : trimmed
  } else if (field === 'technician') {
    next.technician = value
  } else if (field === 'gender') {
    const trimmed = value.trim()
    next.gender = trimmed.toLowerCase() === 'null' || trimmed === '-' || trimmed === '' ? null : trimmed
  } else if (field === 'laps_access') {
    const trimmed = value.trim().toLowerCase()
    if (trimmed === 'true' || trimmed === 'yes' || trimmed === '1' || trimmed === 'allow' || trimmed === 'allowed') {
      next.laps_access = true
    } else if (
      trimmed === 'false' ||
      trimmed === 'no' ||
      trimmed === '0' ||
      trimmed === 'deny' ||
      trimmed === 'denied'
    ) {
      next.laps_access = false
    } else {
      return null
    }
  }

  if (!next.name || !next.ict_name || !next.phone || !next.technician) return null

  const updated = contacts.slice()
  updated[index] = next
  saveTechnicianContacts(updated)
  return next
}

export function deleteTechnicianContact(id: number): boolean {
  const contacts = listTechnicianContacts()
  const updated = contacts.filter((contact) => contact.id !== id)
  if (updated.length === contacts.length) return false
  saveTechnicianContacts(updated)
  return true
}
