import axios from 'axios';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pdfParse from 'pdf-parse';
import { JSDOM } from 'jsdom';
import FormData from 'form-data';
import OpenAI from 'openai';
import Tesseract from 'tesseract.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

type ServiceDeskCategory = {
  name: string;
};

type ServiceDeskDisplayTime = {
  display_value?: string;
};

type ServiceDeskRequester = {
  name?: string;
  email_id?: string;
  mobile?: string;
};

type ServiceDeskTechnician = {
  name?: string;
};

type ServiceDeskGroup = {
  name?: string;
};

type ServiceDeskOwner = {
  name?: string;
};

type ServiceDeskUdfFields = {
  udf_pick_601?: string;
};

type ServiceDeskAttachment = {
  name: string;
  content_type: string;
  content_url: string;
};

type ServiceDeskTemplate = {
  is_service_template?: boolean;
  name?: string;
  id?: string;
};

type ServiceDeskSite = {
  name?: string;
  id?: string;
};

export type ServiceDeskRequest = {
  id: string;
  subject?: string;
  description?: string;
  requester?: ServiceDeskRequester;
  service_category?: ServiceDeskCategory;
  template?: ServiceDeskTemplate;
  status?: ServiceDeskCategory;
  priority?: ServiceDeskCategory;
  group?: ServiceDeskGroup;
  site?: ServiceDeskSite;
  udf_fields?: ServiceDeskUdfFields;
  technician?: ServiceDeskTechnician;
  owner?: ServiceDeskOwner;
  attachments?: ServiceDeskAttachment[];
  created_time?: ServiceDeskDisplayTime;
};

type HandleAttachmentsOptions = {
  allowSrfApproval: boolean;
};

type ServiceDeskViewResponse = {
  request?: ServiceDeskRequest;
};

type ServiceDeskListRequest = {
  id: string;
  created_time?: ServiceDeskDisplayTime;
};

type ServiceDeskListResponse = {
  requests?: ServiceDeskListRequest[];
};

type UpdateRequestArgs = {
  templateId?: string;
  templateName?: string;
  isServiceTemplate?: boolean;
  serviceCategory?: string;
  status?: string;
  groupName?: string | null;
  technicianName?: string | null;
  ictTechnician?: string;
  resolution?: string;
  priority?: string;
};

type UpdateRequestResult = {
  success: boolean;
  message: string;
};

type CreateTicketArgs = {
  subject: string;
  description: string;
  email_id: string;
  service_category?: string | null;
};

type TicketReportArgs = {
  days?: number;
  technicianName?: string;
};

type AnalyzedAttachmentResult = {
  name: string;
  analysis: string;
  pdfPath?: string;
};

type ServiceDeskUrls = {
  apiBaseUrl: string;
  hostBaseUrl: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in environment`);
  return value;
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isServiceCategoryAiEnabled(): boolean {
  const raw = getOptionalEnv('SERVICE_CATEGORY_AI_ENABLED');
  if (!raw) return true;
  return raw.toLowerCase() !== 'false';
}

function getServiceDeskUrls(): ServiceDeskUrls {
  const rawApiBase = requireEnv('SD_BASE_URL');
  const apiBaseUrl = rawApiBase.endsWith('/') ? rawApiBase.slice(0, -1) : rawApiBase;
  const hostBaseUrl = apiBaseUrl.endsWith('/api/v3') ? apiBaseUrl.slice(0, -'/api/v3'.length) : apiBaseUrl;
  return { apiBaseUrl, hostBaseUrl };
}

function getServiceDeskHeaders(): Record<string, string> {
  const token = requireEnv('SERVICE_DESK_TOKEN');
  return {
    authtoken: token,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

const agent = new https.Agent({ rejectUnauthorized: false });

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
];

export async function viewRequest(requestId: string): Promise<ServiceDeskRequest | null> {
  const { apiBaseUrl } = getServiceDeskUrls();
  const headers = getServiceDeskHeaders();
  const viewUrl = `${apiBaseUrl}/requests/${requestId}`;

  try {
    const response = await axios.get<ServiceDeskViewResponse>(viewUrl, { headers, httpsAgent: agent });
    return response.data.request ?? null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = error.message;
      console.error(`HTTP error occurred: ${message}${status ? ` (status ${status})` : ''}`);
      if (error.response?.data) console.error(error.response.data);
      return null;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`Request exception occurred: ${message}`);
    return null;
  }
}

export async function updateRequest(changeId: string, args: UpdateRequestArgs = {}): Promise<UpdateRequestResult> {
  if (!changeId) {
    return { success: false, message: 'Invalid input parameters. Please provide changeId.' };
  }

  const { apiBaseUrl } = getServiceDeskUrls();
  const headers = getServiceDeskHeaders();
  const updateUrl = `${apiBaseUrl}/requests/${changeId}`;
  const addResolutionUrl = `${updateUrl}/resolutions`;

  const {
    templateId,
    templateName,
    isServiceTemplate = false,
    serviceCategory,
    status,
    technicianName,
    ictTechnician,
    resolution,
    priority,
  } = args;

  const updateData: {
    request: {
      template?: {
        is_service_template: boolean;
        service_category: { name: string } | null;
        name: string;
        id: string;
      };
      group?: { name: string } | null;
      status?: { name: string };
      service_category?: { name: string };
      technician?: { name: string } | null;
      udf_fields?: { udf_pick_601: string };
      priority?: { name: string };
    };
  } = {
    request: {},
  };

  if (typeof priority === 'string' && priority.trim().length > 0) {
    updateData.request.priority = { name: priority };
  }

  if (templateId && templateName) {
    updateData.request.template = {
      is_service_template: isServiceTemplate,
      service_category: serviceCategory ? { name: serviceCategory } : null,
      name: templateName,
      id: templateId,
    };
  }

  if (status) updateData.request.status = { name: status };
  if (serviceCategory) updateData.request.service_category = { name: serviceCategory };
  if (args.groupName === null) updateData.request.group = null;
  else if (typeof args.groupName === 'string' && args.groupName.trim().length > 0) updateData.request.group = { name: args.groupName };
  if (technicianName === null) updateData.request.technician = null;
  else if (technicianName) updateData.request.technician = { name: technicianName };
  if (ictTechnician) updateData.request.udf_fields = { udf_pick_601: ictTechnician };

  if (Object.keys(updateData.request).length === 0) {
    return { success: false, message: 'No fields to update.' };
  }

  const data = `input_data=${encodeURIComponent(JSON.stringify(updateData))}`;

  try {
    await axios.put(updateUrl, data, { headers, httpsAgent: agent });

    if (!resolution) {
      return { success: true, message: `Request with changeId: ${changeId} has been updated successfully.` };
    }

    const resolutionData = { resolution: { content: resolution } };
    const resolutionPayload = `input_data=${encodeURIComponent(JSON.stringify(resolutionData))}`;

    try {
      await axios.post(addResolutionUrl, resolutionPayload, { headers, httpsAgent: agent });
      return {
        success: true,
        message: `Request and resolution for changeId: ${changeId} have been updated successfully.`,
      };
    } catch (resolutionError) {
      if (axios.isAxiosError(resolutionError)) {
        const msg = resolutionError.message;
        const dataText = resolutionError.response?.data ? JSON.stringify(resolutionError.response.data) : msg;
        return { success: false, message: `Request updated but failed to add resolution: ${dataText}` };
      }

      const msg = resolutionError instanceof Error ? resolutionError.message : String(resolutionError);
      return { success: false, message: `Request updated but failed to add resolution: ${msg}` };
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const statusCode = error.response?.status;
      const payload = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      return {
        success: false,
        message: `HTTP error occurred${statusCode ? ` (status ${statusCode})` : ''}: ${payload}`,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `An error occurred: ${message}` };
  }
}

export type AssignTechnicianArgs = {
  requestId: string;
  groupName: string;
  technicianName: string;
};

export async function assignGroupToRequest(args: { requestId: string; groupName: string }): Promise<UpdateRequestResult> {
  const { requestId, groupName } = args;
  if (!requestId || !groupName) {
    return { success: false, message: 'Invalid input parameters. Please provide requestId and groupName.' };
  }

  const { apiBaseUrl } = getServiceDeskUrls();
  const headers = getServiceDeskHeaders();
  const assignUrl = `${apiBaseUrl}/requests/${requestId}/assign`;

  const assignData = {
    request: {
      group: { name: groupName },
    },
  };

  const data = `input_data=${encodeURIComponent(JSON.stringify(assignData))}`;

  try {
    await axios.put(assignUrl, data, { headers, httpsAgent: agent });
    return { success: true, message: `Request with id: ${requestId} group assigned successfully.` };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const payload = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      return { success: false, message: `HTTP error occurred${status ? ` (status ${status})` : ''}: ${payload}` };
    }

    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Request exception occurred: ${message}` };
  }
}

export async function assignTechnicianToRequest(args: AssignTechnicianArgs): Promise<UpdateRequestResult> {
  const { requestId, groupName, technicianName } = args;
  if (!requestId || !groupName || !technicianName) {
    return { success: false, message: 'Invalid input parameters. Please provide requestId, groupName, technicianName.' };
  }

  const { apiBaseUrl } = getServiceDeskUrls();
  const headers = getServiceDeskHeaders();
  const assignUrl = `${apiBaseUrl}/requests/${requestId}/assign`;

  const assignData = {
    request: {
      group: { name: groupName },
      technician: { name: technicianName },
    },
  };

  const data = `input_data=${encodeURIComponent(JSON.stringify(assignData))}`;

  try {
    await axios.put(assignUrl, data, { headers, httpsAgent: agent });
    return { success: true, message: `Request with id: ${requestId} has been assigned successfully.` };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = error.message;
      return { success: false, message: `HTTP error occurred: ${message}${status ? ` (status ${status})` : ''}` };
    }

    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Request exception occurred: ${message}` };
  }
}

export async function getAllRequests(days = 7): Promise<string[]> {
  const { apiBaseUrl } = getServiceDeskUrls();
  const headers = getServiceDeskHeaders();
  const allUrl = `${apiBaseUrl}/requests`;
  const maxRows = 100;
  const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let startIndex = 1;
  const filteredRequests: string[] = [];
  let continueFetching = true;

  while (continueFetching) {
    const params = {
      list_info: {
        row_count: maxRows,
        start_index: startIndex,
        sort_field: 'created_time',
        sort_order: 'desc',
        get_total_count: true,
      },
    };

    try {
      const response = await axios.get<ServiceDeskListResponse>(allUrl, {
        headers,
        params: { input_data: JSON.stringify(params) },
        httpsAgent: agent,
      });

      const requests = response.data.requests ?? [];

      for (const request of requests) {
        const requestId = request.id;
        const createdTimeStr = request.created_time?.display_value;

        if (!createdTimeStr) continue;
        const createdTime = new Date(createdTimeStr);
        if (createdTime >= threshold) {
          filteredRequests.push(requestId);
          continue;
        }

        continueFetching = false;
        break;
      }

      if (requests.length < maxRows) break;
      startIndex += maxRows;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error fetching requests: ${message}`);
      return filteredRequests;
    }
  }

  return filteredRequests;
}

export async function handleCreateTicket(args: CreateTicketArgs): Promise<string> {
  const { apiBaseUrl } = getServiceDeskUrls();
  const headers = getServiceDeskHeaders();
  const createUrl = `${apiBaseUrl}/requests`;

  const { subject, description, email_id, service_category = null } = args;

  const inputData: {
    request: {
      subject: string;
      description: string;
      requester: { email_id: string };
      status: { name: string };
      priority: { name: string };
      template: { is_service_template: boolean; name: string; id: string };
      service_category?: { name: string };
    };
  } = {
    request: {
      subject,
      description,
      requester: { email_id },
      status: { name: 'Open' },
      priority: { name: 'Low' },
      template: {
        is_service_template: false,
        name: 'Submit a New Request',
        id: '305',
      },
    },
  };

  if (service_category) inputData.request.service_category = { name: service_category };

  const data = `input_data=${encodeURIComponent(JSON.stringify(inputData))}`;

  try {
    const response = await axios.post<{ request: { id: string } }>(createUrl, data, { headers, httpsAgent: agent });
    const requestId = response.data.request.id;
    return `Ticket created successfully with ID: ${requestId}, Summary: "${description}", Requester Email: ${email_id}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 'Could not create the ticket. Please try again later.';
  }
}

function getOpenAiClient(): OpenAI {
  const apiKey = getOptionalEnv('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY must be set in environment');
  return new OpenAI({ apiKey });
}

async function getAnswerAI(prompt: string): Promise<string> {
  try {
    const openai = getOpenAiClient();
    const chatCompletion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-4o-mini',
    });

    return chatCompletion.choices[0]?.message?.content ?? '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Error processing AI chat completion: ${message}`);
  }
}

async function analyzeImageGemini(base64Image: string, prompt: string): Promise<string> {
  try {
    const apiKey = requireEnv('GOOGLE_GEMINI_API_KEY');
    const genAI = new GoogleGenerativeAI(apiKey);
    const mimeType = base64Image.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType,
      },
    };
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    const result = await model.generateContent([imagePart, prompt]);
    return result.response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${message}`;
  }
}

async function analyzeImageWithPrompt(base64Image: string, prompt: string): Promise<string> {
  const openai = getOpenAiClient();

  const messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${base64Image}` },
        },
      ],
    },
  ];

  const chatCompletion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
    max_tokens: 300,
    temperature: 0.7,
  });

  return chatCompletion.choices[0]?.message?.content ?? '';
}

function stripHtmlTags(input: string): string {
  if (!input) return '';
  return input.replace(/<[^>]*>/g, ' ');
}

function normalizeCategoryText(subject: string, description: string): string {
  const combined = `${subject} ${stripHtmlTags(description)}`.toLowerCase();
  return combined.replace(/[^a-z0-9]+/g, ' ').trim();
}

function guessServiceCategoryFromText(subject: string, description: string): string {
  const text = ` ${normalizeCategoryText(subject, description)} `;

  const rules: Array<{ category: string; keywords: string[] }> = [
    { category: '14. IT Service Request Form', keywords: ['service request form', 'srf', 'form'] },
    { category: '03. Printer&Scanner', keywords: ['printer', 'scanner', 'scan'] },
    { category: '09. Network', keywords: ['lan', 'wifi', 'network', 'internet', 'kabel', 'cable', 'switch', 'router', 'vpn', 'ip'] },
    { category: '08. File Server', keywords: ['file server', 'fileserver', 'shared folder', 'share folder', 'shared', 'folder', 'nas'] },
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
    { category: '20. Preventive Maintenance Network', keywords: ['preventive maintenance', 'pm network'] },
    { category: '19. Preventive Maintenance Support', keywords: ['preventive maintenance', 'pm support'] },
    { category: '18. IT Project Related to Network', keywords: ['project network', 'network project'] },
    { category: '17. IT Project Related to System', keywords: ['project system', 'system project'] },
    { category: '15. Other', keywords: [] },
  ];

  let bestCategory = '15. Other';
  let bestScore = 0;

  for (const rule of rules) {
    if (rule.keywords.length === 0) continue;

    let score = 0;
    for (const keyword of rule.keywords) {
      const kw = ` ${keyword.replace(/[^a-z0-9]+/g, ' ').trim()} `;
      if (kw.trim().length === 0) continue;
      if (text.includes(kw)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.category;
    }
  }

  return bestCategory;
}

export async function defineServiceCategory(changeId: string): Promise<string | null> {
  const requestData = await viewRequest(changeId);
  if (!requestData) return null;

  const subject = requestData.subject ?? '';
  const description = requestData.description ?? '';
  if (!subject && !description) return null;

  const heuristicCategory = guessServiceCategoryFromText(subject, description);

  if (!isServiceCategoryAiEnabled()) return heuristicCategory;
  if (!getOptionalEnv('OPENAI_API_KEY')) return heuristicCategory;

  const input = `Here is a list of service categories: ${serviceCategories.join(', ')}.\nBased on the following subject and description, select the most appropriate category:\n\nSubject: ${subject}\nDescription: ${description}, answer only with the service category`;

  let aiResponse = '';
  try {
    aiResponse = await getAnswerAI(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Service category AI skipped: ${message}`);
    return heuristicCategory;
  }

  for (const category of serviceCategories) {
    const suffix = category.split('. ')[1] ?? category;
    if (aiResponse.toLowerCase().includes(suffix.toLowerCase())) return category;
  }

  return '15. Other';
}

export async function ticketReport(args: TicketReportArgs = {}): Promise<string> {
  const { days = 7, technicianName = '' } = args;

  const requestIds = await getAllRequests(days);
  const reportData: Array<{
    request_id: string;
    requester_name: string;
    created_time: string;
    service_category: string;
    status: string;
    ict_technician: string;
    technician_name: string;
  }> = [];

  for (const requestId of requestIds) {
    const requestDetails = await viewRequest(requestId);
    if (!requestDetails) continue;

    const requesterName = requestDetails.requester?.name ?? 'N/A';
    const serviceCategory = requestDetails.service_category?.name ?? 'N/A';
    const status = requestDetails.status?.name ?? 'N/A';
    const ictTechnician = requestDetails.udf_fields?.udf_pick_601 ?? 'N/A';
    const technician = requestDetails.technician?.name ?? 'N/A';

    if (technicianName && !ictTechnician.toLowerCase().includes(technicianName.toLowerCase())) {
      continue;
    }

    reportData.push({
      request_id: requestId,
      requester_name: requesterName,
      created_time: requestDetails.created_time?.display_value ?? 'N/A',
      service_category: serviceCategory,
      status,
      ict_technician: ictTechnician,
      technician_name: technician,
    });
  }

  const technicianData: Record<
    string,
    { status: Record<string, number>; service_category: Record<string, number>; total_tickets: number }
  > = {};

  for (const data of reportData) {
    const tech = data.ict_technician;
    technicianData[tech] ??= { status: {}, service_category: {}, total_tickets: 0 };

    technicianData[tech].status[data.status] = (technicianData[tech].status[data.status] ?? 0) + 1;
    technicianData[tech].service_category[data.service_category] =
      (technicianData[tech].service_category[data.service_category] ?? 0) + 1;
    technicianData[tech].total_tickets += 1;
  }

  let reportText = `*Ticket Report for Last ${days} Days*\n\n`;
  if (technicianName) reportText += `Filtered by Technician: ${technicianName}\n\n`;

  for (const tech of Object.keys(technicianData)) {
    const details = technicianData[tech];
    reportText += `### ${tech} (Total: ${details.total_tickets} Tickets)\n`;
    reportText += `- Status:\n`;
    for (const status of Object.keys(details.status)) {
      reportText += `  - ${status}: ${details.status[status]} Tiket\n`;
    }
    reportText += `- Service Category:\n`;
    for (const category of Object.keys(details.service_category)) {
      reportText += `  - ${category}: ${details.service_category[category]} Tiket\n`;
    }
    reportText += `\n`;
  }

  reportText += `*Total Tickets in Last ${days} Days: ${reportData.length}*`;
  return reportText;
}

async function downloadPdf(downloadUrl: string, attachmentName: string): Promise<string> {
  const outputDir = path.join(currentDir, 'temp_pdf_files');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const pdfPath = path.join(outputDir, attachmentName);

  const headers = getServiceDeskHeaders();
  const response = await axios.get<ArrayBuffer>(downloadUrl, {
    headers,
    httpsAgent: agent,
    responseType: 'arraybuffer',
  });

  const contentTypeHeader = response.headers['content-type'];
  if (contentTypeHeader !== 'application/pdf') {
    const text = Buffer.from(response.data).toString('utf-8');
    throw new Error(`Response is not a PDF. content-type=${String(contentTypeHeader)} body=${text}`);
  }

  const buf = Buffer.from(response.data);
  fs.writeFileSync(pdfPath, buf);
  return pdfPath;
}

async function extractTextFromImage(imagePath: string): Promise<string> {
  const result = await Tesseract.recognize(imagePath, 'eng+chi_sim+ind');
  return result.data.text;
}

async function extractTextFromPdfFirstPage(pdfPath: string): Promise<string> {
  const dataBuffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(dataBuffer, { max: 1 });
  return data.text;
}

async function isSrfRequest(requestDetails: {
  requestId?: string;
  scope?: 'ticket' | 'attachment';
  subject?: string;
  description?: string;
  attachments?: ServiceDeskAttachment[];
}): Promise<boolean> {
  const { hostBaseUrl } = getServiceDeskUrls();

  const srfKeywords: Array<{ label: string; regex: RegExp }> = [
    { label: 'service request form', regex: /service request form/i },
    { label: 'srf', regex: /\bsrf\b/i },
    { label: 'service request', regex: /service request/i },
    { label: 'request', regex: /request/i },
  ];

  const findKeywordMatch = (text: unknown): string | null => {
    if (typeof text !== 'string') return null;
    for (const k of srfKeywords) {
      if (k.regex.test(text)) return k.label;
    }
    return null;
  };

  const scope = requestDetails.scope ?? 'ticket';
  const prefix = `[SRF_DETECTION]${requestDetails.requestId ? `[ticket:${requestDetails.requestId}]` : ''}[scope:${scope}]`;

  const subjectMatch = findKeywordMatch(requestDetails.subject ?? '');
  const descriptionMatch = findKeywordMatch(requestDetails.description ?? '');
  const reasons: string[] = [];
  if (scope === 'ticket') {
    if (subjectMatch) reasons.push(`subject:${subjectMatch}`);
    if (descriptionMatch) reasons.push(`description:${descriptionMatch}`);
  }
  console.log(
    `${prefix} subject=${subjectMatch ? `match:${subjectMatch}` : 'no-match'} description=${
      descriptionMatch ? `match:${descriptionMatch}` : 'no-match'
    }`
  );

  let attachmentsContainKeyword = false;
  if (Array.isArray(requestDetails.attachments)) {
    for (const attachment of requestDetails.attachments) {
      const attachmentNameMatch = findKeywordMatch(attachment.name);
      if (attachmentNameMatch) {
        reasons.push(`attachmentName:${attachmentNameMatch}`);
        console.log(`${prefix} attachment="${attachment.name}" name=match:${attachmentNameMatch}`);
        attachmentsContainKeyword = true;
        break;
      }

      console.log(`${prefix} attachment="${attachment.name}" name=no-match`);

      if (attachment.name.endsWith('.pdf')) {
        const downloadUrl = `${hostBaseUrl}${attachment.content_url}`;
        try {
          const pdfPath = await downloadPdf(downloadUrl, attachment.name);
          try {
            const firstPageText = await extractTextFromPdfFirstPage(pdfPath);
            const pdfTextMatch = findKeywordMatch(firstPageText);
            if (pdfTextMatch) reasons.push(`pdfFirstPage:${pdfTextMatch}`);
            console.log(
              `${prefix} attachment="${attachment.name}" pdfFirstPage=${pdfTextMatch ? `match:${pdfTextMatch}` : 'no-match'}`
            );
            if (pdfTextMatch) {
              attachmentsContainKeyword = true;
              break;
            }
          } finally {
            await fs.promises.unlink(pdfPath).catch(() => undefined);
          }
        } catch (error) {
          console.error(`${prefix} attachment="${attachment.name}" pdfFirstPage=error`, error);
        }
      } else if (attachment.name.toLowerCase().endsWith('.pdf')) {
        reasons.push('pdfFirstPage:skipped-case-sensitive-extension');
        console.log(`${prefix} attachment="${attachment.name}" pdfFirstPage=skipped-case-sensitive-extension`);
      }
    }
  }

  const isSrf = scope === 'attachment' ? attachmentsContainKeyword : Boolean(subjectMatch || descriptionMatch || attachmentsContainKeyword);
  const ignored: string[] = [];
  if (scope === 'attachment') {
    if (subjectMatch) ignored.push(`subject:${subjectMatch}`);
    if (descriptionMatch) ignored.push(`description:${descriptionMatch}`);
  }
  console.log(
    `${prefix} result=${isSrf ? 'SRF' : 'NOT_SRF'} reasons=${reasons.length > 0 ? reasons.join(',') : 'none'} ignored=${
      ignored.length > 0 ? ignored.join(',') : 'none'
    }`
  );
  return isSrf;
}

function extractContent(html: string): string[] {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const nodes = document.querySelectorAll('p');
  const paragraphs: string[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes.item(i);
    const text = (node.textContent ?? '').trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

async function convertPdfToImages(pdfPath: string): Promise<string[]> {
  const dataBuffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(dataBuffer);
  return data.text
    .split('\f')
    .map((p) => p.trim())
    .filter(Boolean);
}

const isTestEnvironment =false;
const chatId = isTestEnvironment ? '120363123402010871@g.us' : '120363162455880145@g.us';

const srfApprovalDedup = new Map<string, number>();
const srfApprovalDedupTtlMs = 10 * 60 * 1000;

function shouldSendSrfApproval(args: { ticketId: string; attachmentContentUrl: string }): boolean {
  const now = Date.now();
  for (const [key, expiresAt] of srfApprovalDedup.entries()) {
    if (expiresAt <= now) srfApprovalDedup.delete(key);
  }

  const key = `srf:${args.ticketId}:${args.attachmentContentUrl}`;
  const existing = srfApprovalDedup.get(key);
  if (existing && existing > now) return false;

  srfApprovalDedup.set(key, now + srfApprovalDedupTtlMs);
  return true;
}

async function sendGroupMessage(args: {
  chatId: string;
  message: string;
  mentions?: string[];
  documentPath?: string | null;
  imagePath?: string | null;
}): Promise<unknown> {
  const { chatId, message, mentions = [], documentPath = null, imagePath = null } = args;
  const url = 'http://localhost:8192/send-group-message';
  const formData = new FormData();

  formData.append('id', chatId);
  formData.append('message', message);

  if (mentions.length > 0) {
    formData.append('mention', JSON.stringify(mentions));
  }

  if (documentPath) {
    const extension = path.extname(documentPath).toLowerCase();
    let contentType: string | undefined;
    if (extension === '.xls' || extension === '.xlsx') {
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else if (extension === '.pdf') {
      contentType = 'application/pdf';
    }

    if (contentType) {
      formData.append('document', fs.createReadStream(documentPath), {
        filename: path.basename(documentPath),
        contentType,
      });
    }
  }

  if (imagePath) {
    formData.append('image', fs.createReadStream(imagePath), {
      filename: path.basename(imagePath),
      contentType: 'image/png',
    });
  }

  let shouldCleanup = false;
  try {
    const response = await axios.post(url, formData, { headers: { ...formData.getHeaders() } });
    if (response.status === 200) {
      shouldCleanup = true;
      return response.data;
    }
    throw new Error('Failed to send message');
  } finally {
    if (!shouldCleanup) return;
    if (documentPath) await fs.promises.unlink(documentPath).catch(() => undefined);
    if (imagePath) await fs.promises.unlink(imagePath).catch(() => undefined);
  }
}

export async function handleAndAnalyzeAttachments(
  requestDetails: ServiceDeskRequest,
  options: HandleAttachmentsOptions = { allowSrfApproval: true }
): Promise<AnalyzedAttachmentResult[]> {
  const { hostBaseUrl } = getServiceDeskUrls();
  const headers = getServiceDeskHeaders();

  const descriptionParts = extractContent(requestDetails.description ?? '');
  const prompt = `Analyze the following ticket details:\n\nTicket ID: ${requestDetails.id}\nSubject: ${requestDetails.subject ?? ''}\nDescription: ${descriptionParts.join('\n') || 'No description provided.'}\n`;
  const analyzedResults: AnalyzedAttachmentResult[] = [];

  const attachments = requestDetails.attachments ?? [];
  await Promise.all(
    attachments.map(async (attachment) => {
      try {
        const attachmentName = attachment.name;
        const contentType = attachment.content_type;
        const downloadUrl = `${hostBaseUrl}${attachment.content_url}`;

        const response = await axios.get<ArrayBuffer>(downloadUrl, {
          headers,
          httpsAgent: agent,
          responseType: 'arraybuffer',
        });

        if (contentType.startsWith('image/')) {
          const base64Image = Buffer.from(response.data).toString('base64');
          const analysis = await analyzeImageWithPrompt(base64Image, prompt);
          analyzedResults.push({ name: attachmentName, analysis });
          return;
        }

        if (contentType.startsWith('application/pdf')) {
          const isSrf = await isSrfRequest({
            requestId: requestDetails.id,
            scope: 'attachment',
            subject: requestDetails.subject,
            description: descriptionParts.join('\n'),
            attachments: [attachment],
          });

          if (!isSrf) return;

          if (!options.allowSrfApproval) {
            analyzedResults.push({ name: attachmentName, analysis: 'Skipped SRF approval send (not new event)' });
            return;
          }

          if (!shouldSendSrfApproval({ ticketId: requestDetails.id, attachmentContentUrl: attachment.content_url })) {
            console.log(
              `[SRF_DETECTION][ticket:${requestDetails.id}][scope:attachment] duplicateSend=skipped attachment="${attachmentName}"`
            );
            analyzedResults.push({ name: attachmentName, analysis: 'Skipped duplicate SRF send' });
            return;
          }

          const pdfPath = await downloadPdf(downloadUrl, attachmentName);
          const pagesText = await convertPdfToImages(pdfPath);

          const mentions = isTestEnvironment ? ['6285712612218', '6281130569787'] : ['6282323336511', '6285712612218','6289524548777','6281132041331'];
          const combinedResult = pagesText.join('\n');

          const updatedPrompt = `Kamu adalah MTI ICT Helpdesk. Berdasarkan data yang akan saya berikan, kirimkan pesan dengan format:\nPak ${mentions
            .map((mention) => `@${mention}`)
            .join(', ')} , terlampir SRF ${attachmentName}, dengan ticket ID ${requestDetails.id} dari (requester), terkait (jelaskan isi requestnya). Silahkan direview untuk approvalnya.\nData:\n\n ${prompt} ${combinedResult}`;

          const finalAnalysis = await getAnswerAI(updatedPrompt);

          await sendGroupMessage({
            chatId,
            message: finalAnalysis,
            mentions,
            documentPath: pdfPath,
          });

          analyzedResults.push({ name: attachmentName, analysis: finalAnalysis });
          return;
        }

        analyzedResults.push({ name: attachmentName, analysis: 'Skipping unsupported attachment' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        analyzedResults.push({ name: attachment.name, analysis: `Error handling attachment: ${message}` });
      }
    })
  );

  return analyzedResults;
}
