// Minimal text extraction for uploaded resumes.
//
// Most resumes are either a text-based PDF or a pasted block of text. A full PDF
// parser is a heavy dependency for a step whose output the user edits anyway, so
// this pulls readable text out of a PDF's content streams and falls back to
// asking the user to paste when a scanned or image-only PDF yields nothing.

export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/**
 * Extracts text from a PDF's uncompressed text-showing operators. Returns an
 * empty-ish string for image-only PDFs, which the caller treats as "please paste".
 */
export function extractPdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const chunks: string[] = [];

  const blocks = raw.match(/BT[\s\S]*?ET/g) ?? [];
  for (const block of blocks) {
    for (const match of block.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
      chunks.push(decodePdfString(match[1]));
    }
    for (const match of block.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
      for (const piece of match[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) {
        chunks.push(decodePdfString(piece[1]));
      }
    }
  }

  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function decodePdfString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/** Accepts a PDF or plain text upload and returns extracted text. */
export async function resumeTextFromUpload(file: File): Promise<{ text: string; needsPaste: boolean }> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (looksLikePdf(bytes)) {
    const text = extractPdfText(bytes);
    return { text, needsPaste: text.length < 200 };
  }

  const text = Buffer.from(bytes).toString("utf8").replace(/\s+/g, " ").trim();
  return { text, needsPaste: text.length < 200 };
}
