import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { MessagingService } from '../src/features/channel/messagingService.ts';
import { handleAndSendAttachments, isSrfPdfAttachmentHeuristic, buildSrfDocumentCaption } from '../src/features/http/routes/messages.ts';
import { loadPreviousTicketState } from '../src/features/tickets/ticketStateStore.ts';
import { extractPdfFirstPageText } from '../src/utils/pdf.ts';

function pdf(text) {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i+1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10,'0')} 00000 n \n`).join('');
  return Buffer.from(data + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}

test('media payload follows OpenWA SendMediaMessageDto', async () => {
  const calls = [];
  const messaging = new MessagingService({ resolveSessionId: async () => 'test', post: async (url, body) => {
    calls.push({ url, body });
    const allowed = new Set(['chatId','url','base64','mimetype','filename','caption','mentions']);
    assert.deepEqual(Object.keys(body).filter(key => !allowed.has(key)), []);
    return { messageId: 'sent' };
  }});
  const document = pdf('Service Request Form');
  await messaging.sendDocument({ chatId: 'test@g.us', document, mimetype: 'application/pdf', fileName: 'SRF.pdf', caption: 'Review', mentions: ['628111@c.us'] });
  assert.equal(calls[0].body.filename, 'SRF.pdf');
  assert.deepEqual(Buffer.from(calls[0].body.base64, 'base64'), document);
  await messaging.sendImage({ chatId:'test@g.us', source: { kind:'url', url:'https://example.com/image.png' } });
  assert.equal(calls[1].body.url, 'https://example.com/image.png');
});

test('SRF detection uses attachment evidence rather than ticket context', () => {
  const request = { id:'TEST', subject:'SRF VPN request', description:'approval', service_category:{name:'14. IT Service Request Form'} };
  const attachment = { name:'network.pdf',content_url:'/a',content_type:'application/pdf' };
  assert.equal(isSrfPdfAttachmentHeuristic({request,attachment,pdfFirstPageText:'Network diagnostic report'}),false);
  assert.equal(isSrfPdfAttachmentHeuristic({request,attachment:{...attachment,name:'SRF employee.PDF'}}),true);
  assert.equal(isSrfPdfAttachmentHeuristic({request,attachment,pdfFirstPageText:'Service Request Form'}),true);
  assert.equal(isSrfPdfAttachmentHeuristic({request,attachment:{...attachment,content_type:'image/png'}}),false);
});

test('caption retains mentions and respects provider length', () => {
  const caption = buildSrfDocumentCaption('Long explanation '.repeat(200),['628111@c.us','628222@c.us']);
  assert.ok(caption.startsWith('@628111 @628222\n'));
  assert.equal(caption.length,1024);
});

test('SRF delivery is one document with caption; failed sends remain retryable', async () => {
  const env = {...process.env};
  const previousAdapter = axios.defaults.adapter;
  delete process.env.REDIS_HOST; delete process.env.REDIS_PORT; delete process.env.OPENAI_API_KEY;
  process.env.SD_BASE_URL = 'https://servicedesk.invalid/api/v3';
  process.env.SERVICE_DESK_TOKEN = 'test-only';
  process.env.SRF_APPROVER_PHONES = '628111';
  const document = pdf('Service Request Form');
  const calls = [];
  let fail = true;
  axios.defaults.adapter = async config => {
    assert.equal(config.method,'get');
    return {data:document,status:200,statusText:'OK',headers:{},config};
  };
  const request = {id:'SRF-TEST',subject:'VPN',attachments:[{name:'SRF.pdf',content_url:'/attachment/test',content_type:'application/pdf'}]};
  const args = {request,receiverJid:'test@g.us',allowSrfApproval:true,requesterLabel:'Test Requester',messaging:{
    sendDocument: async input => { calls.push({kind:'document',input}); if(fail) throw new Error('simulated provider rejection'); return {messageId:'sent'}; },
    sendText: async input => { calls.push({kind:'text',input}); },
    sendImage: async () => { throw new Error('unexpected image'); }
  }};
  try {
    assert.match(await extractPdfFirstPageText(document),/Service Request Form/);
    await handleAndSendAttachments(args);
    assert.equal(calls[0].kind,'document');
    assert.equal(calls.filter(c=>c.kind==='text').length,1);
    assert.match(calls.at(-1).input.text,/simulated provider rejection/);
    assert.equal((await loadPreviousTicketState(request.id))?.srfSentAttachmentUrls?.length ?? 0,0);
    fail=false; calls.length=0;
    await handleAndSendAttachments(args);
    assert.deepEqual(calls.map(c=>c.kind),['document']);
    assert.match(calls[0].input.caption,/@628111/);
    assert.deepEqual(calls[0].input.mentions,['628111@c.us']);
    assert.deepEqual((await loadPreviousTicketState(request.id)).srfSentAttachmentUrls,['/attachment/test']);
    calls.length=0;
    await handleAndSendAttachments(args);
    assert.equal(calls.filter(c=>c.kind==='document').length,0);
    calls.length=0;
    await handleAndSendAttachments({...args,request:{...request,id:'UPDATED'},allowSrfApproval:false});
    assert.equal(calls[0].kind,'document');
    assert.equal(calls[0].input.caption,'Attachment: SRF.pdf');
    assert.equal(calls[0].input.mentions,undefined);
  } finally {
    axios.defaults.adapter=previousAdapter;
    for(const key of Object.keys(process.env)) if(!(key in env)) delete process.env[key];
    Object.assign(process.env,env);
  }
});
