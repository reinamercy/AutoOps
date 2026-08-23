import { NextRequest, NextResponse } from "next/server";

// Server-side proxy for the human-approval decision endpoint. This exists
// specifically so the AUTOOPS_API_KEY secret never reaches the browser: the
// Fastify backend's /api/v1/approvals/:id/decision route requires an
// X-AutoOps-Key header when AUTOOPS_API_KEY is set (see
// autoops_ai/src/api/approvals.router.ts). A NEXT_PUBLIC_* env var would get
// bundled into client JS and be readable by anyone via view-source — so this
// key is read from a plain (server-only) env var and attached here instead,
// server-side, where the browser can't see it.
const API_BASE = process.env.AUTOOPS_BACKEND_URL || "http://localhost:3000";
const API_KEY = process.env.AUTOOPS_API_KEY || "";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.text();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/approvals/${params.id}/decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "X-AutoOps-Key": API_KEY } : {}),
      },
      body,
    });
  } catch {
    return NextResponse.json(
      { error: `Could not reach AutoOps AI backend at ${API_BASE}` },
      { status: 502 }
    );
  }

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
