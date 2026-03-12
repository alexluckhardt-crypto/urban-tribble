import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const { fileName, fileType } = await req.json()
    if (!fileName) return NextResponse.json({ error: 'fileName required' }, { status: 400 })

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl) return NextResponse.json({ error: 'NEXT_PUBLIC_SUPABASE_URL not set' }, { status: 503 })
    if (!serviceKey) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' }, { status: 503 })

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `uploads/${Date.now()}_${safeName}`
    const bucket = 'raw-footage'

    const signRes = await fetch(
      `${supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${path}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    )

    if (!signRes.ok) {
      const errText = await signRes.text()
      return NextResponse.json({ error: `Supabase signed URL failed (${signRes.status}): ${errText}` }, { status: 502 })
    }

    const data = await signRes.json()
    // Supabase returns { signedURL: '/object/upload/sign/...' } — always a relative path
    const rawUrl = data.signedURL || data.url || data.signed_url || ''
    const signedUrl = rawUrl.startsWith('http') ? rawUrl : `${supabaseUrl}${rawUrl}`

    if (!signedUrl || signedUrl === supabaseUrl) {
      return NextResponse.json({ error: `No signed URL in response: ${JSON.stringify(data)}` }, { status: 502 })
    }

    return NextResponse.json({
      signedUrl,
      publicUrl: `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`,
      path,
    })

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
