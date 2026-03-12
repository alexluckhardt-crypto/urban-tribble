import { NextRequest } from 'next/server'
import { uploadVideoUrlToGemini, analyzeVideoWithGemini, mockSceneAnalysis } from '@/services/ai/geminiAnalyzer'
import { generateEditPlans } from '@/services/ai/editPlanGenerator'
import { buildCreatomateRender, submitCreatomateRender, pollCreatomateRender } from '@/services/video/creatomate'
import { MOCK_STYLE_PACKS } from '@/lib/mockData'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      function send(step: number, message: string, done = false, payload: any = null) {
        try {
          controller.enqueue(encoder.encode(JSON.stringify({ step, message, done, payload }) + '\n'))
        } catch {}
      }

      try {
        const formData = await req.formData()
        const videoUrl = formData.get('videoUrl') as string | null
        const videoName = formData.get('videoName') as string || 'video.mp4'
        const videoType = formData.get('videoType') as string || 'video/mp4'
        const productName = formData.get('productName') as string || 'Product'
        const productNotes = formData.get('productNotes') as string || ''
        const stylePackId = formData.get('stylePackId') as string || 'sp_1'
        const salesIntensity = parseInt(formData.get('salesIntensity') as string || '3')
        const variantKey = (formData.get('variantKey') as string || 'A') as 'A' | 'B' | 'C' | 'D'
        let editOptions: Record<string, any> = {}
        try { editOptions = JSON.parse(formData.get('editOptions') as string || '{}') } catch {}

        if (!videoUrl) {
          send(-1, 'No video URL — Supabase upload failed. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.', true)
          controller.close()
          return
        }

        const stylePack = MOCK_STYLE_PACKS.find(s => s.id === stylePackId) || MOCK_STYLE_PACKS[0]

        // ── Step 1: Gemini analysis ──────────────────────────────────────────
        send(0, '📤 Uploading footage to Gemini...')
        let sceneAnalysis

        if (process.env.GEMINI_API_KEY) {
          try {
            const fileUri = await Promise.race([
              uploadVideoUrlToGemini(videoUrl, videoType, videoName),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('TIMEOUT')), 240000) // 4min
              ),
            ])
            send(1, '🤖 Gemini analyzing scenes...')
            sceneAnalysis = await Promise.race([
              analyzeVideoWithGemini(fileUri, videoType, productName, productNotes),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('TIMEOUT')), 60000) // 1min
              ),
            ])
          } catch (err: any) {
            const reason = err.message?.includes('TIMEOUT') ? 'timed out' : err.message?.slice(0, 80)
            send(1, `🤖 Gemini ${reason} — using smart mock analysis instead`)
            sceneAnalysis = mockSceneAnalysis(productName)
          }
        } else {
          send(1, '🤖 No GEMINI_API_KEY set — using mock scene analysis')
          sceneAnalysis = mockSceneAnalysis(productName)
        }

        // ── Step 2: Claude edit plans ─────────────────────────────────────────
        send(2, '✍️ Claude generating 4 edit variants...')
        let allVariants
        try {
          allVariants = await generateEditPlans(sceneAnalysis, stylePack, productName, productNotes, salesIntensity, editOptions)
        } catch (err: any) {
          send(2, `✍️ Claude error (${err.message?.slice(0, 60)}) — using mock variants`)
          const { generateMockEditPlans } = await import('@/services/ai/editPlanGenerator')
          allVariants = generateMockEditPlans(sceneAnalysis, productName, editOptions)
        }
        const variant = allVariants[variantKey]

        // ── Step 3: Creatomate render ─────────────────────────────────────────
        let renderResult: { url?: string; error?: string; rendered: boolean } = {
          rendered: false,
          error: 'CREATOMATE_API_KEY not configured — add it to Vercel env vars to enable video rendering',
        }

        if (process.env.CREATOMATE_API_KEY) {
          try {
            send(3, '🎬 Creatomate rendering your video...')
            const renderPayload = buildCreatomateRender(
              videoUrl, variant.cuts, variant.captions,
              variant.hookText, variant.ctaText, productName, editOptions
            )
            const renderId = await submitCreatomateRender(renderPayload)
            const result = await pollCreatomateRender(renderId)
            renderResult = { rendered: result.status === 'succeeded', url: result.url, error: result.error }
          } catch (err: any) {
            renderResult = { rendered: false, error: `Render failed: ${err.message}` }
          }
        } else {
          send(3, '⚠️ Skipping render — no CREATOMATE_API_KEY')
        }

        // ── Done ──────────────────────────────────────────────────────────────
        send(4, '✅ Done!', true, {
          success: true,
          sceneAnalysis,
          variants: allVariants,
          selectedVariant: { key: variantKey, ...variant },
          render: renderResult,
          editOptions,
        })
      } catch (err: any) {
        send(-1, `Error: ${err.message}`, true)
      } finally {
        try { controller.close() } catch {}
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
