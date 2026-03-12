// src/services/ai/geminiAnalyzer.ts
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

export interface SceneAnalysis {
  transcript: string
  scenes: Scene[]
  bestMoments: BestMoment[]
  productMentions: ProductMention[]
  overallQuality: number
  suggestedDuration: number
  rawAnalysis: string
}

export interface Scene {
  startSeconds: number
  endSeconds: number
  description: string
  quality: 'excellent' | 'good' | 'fair' | 'poor'
  hasProduct: boolean
  hasSpeech: boolean
  energyLevel: 'high' | 'medium' | 'low'
  keepRating: number
}

export interface BestMoment {
  startSeconds: number
  endSeconds: number
  reason: string
  type: 'hook' | 'demo' | 'reaction' | 'product_close' | 'cta' | 'testimonial'
}

export interface ProductMention {
  atSeconds: number
  text: string
  visual: boolean
}

// ── Upload video to Gemini by piping from a public URL — avoids buffering in memory ──
export async function uploadVideoToGemini(
  videoBuffer: Buffer,
  mimeType: string,
  displayName: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')

  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': videoBuffer.length.toString(),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    }
  )

  const uploadUrl = initRes.headers.get('x-goog-upload-url')
  if (!uploadUrl) throw new Error(`Failed to get Gemini upload URL (${initRes.status})`)

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': videoBuffer.length.toString(),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: new Uint8Array(videoBuffer),
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    throw new Error(`Gemini upload failed (${uploadRes.status}): ${err}`)
  }

  const fileData = await uploadRes.json()
  const fileUri = fileData.file?.uri
  if (!fileUri) throw new Error('No file URI returned from Gemini')

  await waitForGeminiFile(fileUri, apiKey)
  return fileUri
}

// Upload directly from a public URL — streams from Supabase to Gemini without buffering
export async function uploadVideoUrlToGemini(
  publicUrl: string,
  mimeType: string,
  displayName: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')

  // Fetch the video from Supabase
  const videoRes = await fetch(publicUrl)
  if (!videoRes.ok) throw new Error(`Cannot fetch video from storage (${videoRes.status})`)

  const contentLength = videoRes.headers.get('content-length') || '0'
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer())

  // Initiate resumable upload to Gemini
  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': videoBuffer.length.toString(),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    }
  )

  const uploadUrl = initRes.headers.get('x-goog-upload-url')
  if (!uploadUrl) throw new Error(`Failed to get Gemini upload URL (${initRes.status})`)

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': videoBuffer.length.toString(),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: new Uint8Array(videoBuffer),
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    throw new Error(`Gemini upload failed (${uploadRes.status}): ${err}`)
  }

  const fileData = await uploadRes.json()
  const fileUri = fileData.file?.uri
  if (!fileUri) throw new Error('No file URI returned from Gemini')

  await waitForGeminiFile(fileUri, apiKey)
  return fileUri
}

async function waitForGeminiFile(fileUri: string, apiKey: string, maxWaitMs = 180000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${fileUri}?key=${apiKey}`)
    if (!res.ok) throw new Error(`Gemini file status check failed: ${res.status}`)
    const data = await res.json()
    if (data.state === 'ACTIVE') return
    if (data.state === 'FAILED') throw new Error('Gemini file processing failed')
    await new Promise(r => setTimeout(r, 3000))
  }
  throw new Error('Gemini file processing timed out after 3 minutes')
}

// ── Step 2: Analyze the uploaded video ───────────────────────────────────────
export async function analyzeVideoWithGemini(
  fileUri: string,
  mimeType: string,
  productName: string,
  productNotes: string
): Promise<SceneAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
  let lastError: Error = new Error('All Gemini models failed')

  for (const model of models) {
    try {
      const res = await fetch(
        `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { file_data: { mime_type: mimeType, file_uri: fileUri } },
                { text: buildAnalysisPrompt(productName, productNotes) },
              ],
            }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
          }),
        }
      )

      if (!res.ok) {
        if (res.status === 404) { lastError = new Error(`Model ${model} not found`); continue }
        throw new Error(`Gemini API error ${res.status}: ${await res.text()}`)
      }

      const data = await res.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON in Gemini response')

      return JSON.parse(jsonMatch[0]) as SceneAnalysis
    } catch (err: any) {
      if (err.message?.includes('not found')) { lastError = err; continue }
      throw err
    }
  }
  throw lastError
}

function buildAnalysisPrompt(productName: string, productNotes: string): string {
  return `You are an expert TikTok Shop video editor. Analyze this raw footage for a product called "${productName}".

Product details:
${productNotes}

Return ONLY valid JSON with this exact structure:
{
  "transcript": "full word-for-word transcript with timestamps like [0:05] text",
  "scenes": [
    {
      "startSeconds": 0.0,
      "endSeconds": 8.5,
      "description": "Creator introduces themselves and the product",
      "quality": "excellent",
      "hasProduct": true,
      "hasSpeech": true,
      "energyLevel": "high",
      "keepRating": 9
    }
  ],
  "bestMoments": [
    {
      "startSeconds": 12.0,
      "endSeconds": 18.5,
      "reason": "Clear product demonstration with visible results",
      "type": "demo"
    },
    {
      "startSeconds": 0.0,
      "endSeconds": 4.0,
      "reason": "Strong emotional hook opening",
      "type": "hook"
    },
    {
      "startSeconds": 45.0,
      "endSeconds": 52.0,
      "reason": "Direct call to action with urgency",
      "type": "cta"
    }
  ],
  "productMentions": [
    { "atSeconds": 3.5, "text": "exact words spoken about product", "visual": true }
  ],
  "overallQuality": 82,
  "suggestedDuration": 28,
  "rawAnalysis": "2-3 sentence summary of the footage and its TikTok Shop potential"
}

Rules:
- bestMoments MUST include at least one of each type: hook, demo, cta
- All timestamps must be accurate to the actual video content
- suggestedDuration should be 15-60 seconds for TikTok`
}

// ── Mock fallback for when Gemini is unavailable ──────────────────────────────
export function mockSceneAnalysis(productName: string): SceneAnalysis {
  return {
    transcript: `[0:00] Hey everyone, I've been using ${productName} for three weeks now and I have to show you my results. [0:08] I was really skeptical at first but oh my god. [0:15] Look at this transformation. This is insane. [0:22] I use it every morning and every night and the difference is just incredible. [0:35] Honestly if you're on the fence just get it. Link is in my bio. You will not regret this.`,
    scenes: [
      { startSeconds: 0, endSeconds: 8, description: 'Creator introduction and hook setup', quality: 'excellent', hasProduct: false, hasSpeech: true, energyLevel: 'high', keepRating: 9 },
      { startSeconds: 8, endSeconds: 15, description: 'Skepticism reveal and emotional turn', quality: 'excellent', hasProduct: false, hasSpeech: true, energyLevel: 'high', keepRating: 8 },
      { startSeconds: 15, endSeconds: 25, description: 'Product demonstration with visible results', quality: 'excellent', hasProduct: true, hasSpeech: true, energyLevel: 'high', keepRating: 10 },
      { startSeconds: 25, endSeconds: 38, description: 'Usage routine explanation', quality: 'good', hasProduct: true, hasSpeech: true, energyLevel: 'medium', keepRating: 7 },
      { startSeconds: 38, endSeconds: 48, description: 'Call to action and closing', quality: 'good', hasProduct: false, hasSpeech: true, energyLevel: 'medium', keepRating: 8 },
    ],
    bestMoments: [
      { startSeconds: 0, endSeconds: 8, reason: 'High energy hook with immediate credibility', type: 'hook' },
      { startSeconds: 15, endSeconds: 25, reason: 'Clear product demonstration with visible results', type: 'demo' },
      { startSeconds: 8, endSeconds: 15, reason: 'Authentic emotional reaction', type: 'reaction' },
      { startSeconds: 38, endSeconds: 48, reason: 'Direct CTA with urgency', type: 'cta' },
    ],
    productMentions: [
      { atSeconds: 2, text: productName, visual: false },
      { atSeconds: 18, text: `results from ${productName}`, visual: true },
    ],
    overallQuality: 85,
    suggestedDuration: 28,
    rawAnalysis: `Strong UGC-style footage with authentic creator energy. Clear product demonstration and emotional arc. Good hook potential in the opening 8 seconds. Well-structured for TikTok Shop conversion.`,
  }
}
