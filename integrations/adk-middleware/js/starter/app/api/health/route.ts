import { NextResponse } from "next/server";

export const runtime = "nodejs";

// The ADK agent runs in-process inside this Next.js server, so a responding
// server is a healthy agent. Deploy targets (Docker, Railway, etc.) can probe
// this endpoint directly.
export function GET() {
  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}
