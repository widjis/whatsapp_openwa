import pdfParse from 'pdf-parse'

export async function extractPdfFirstPageText(buffer: Buffer): Promise<string> {
  const parsed = await pdfParse(buffer, { max: 1 })
  return (parsed.text ?? '').trim()
}

