declare module 'pdf-parse' {
  type PdfParseOptions = {
    max?: number
    pagerender?: unknown
    version?: string
  }

  type PdfParseResult = {
    numpages?: number
    numrender?: number
    info?: unknown
    metadata?: unknown
    text?: string
    version?: string
  }

  export default function pdfParse(dataBuffer: Buffer, options?: PdfParseOptions): Promise<PdfParseResult>
}

