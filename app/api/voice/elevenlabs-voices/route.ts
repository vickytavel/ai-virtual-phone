import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 15;

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

/** 与前端 tts-service 的 elevenLabsApiBase 保持一致：末尾缺 /v{N} 时补 /v1。 */
function normalizeBaseUrl(value: unknown): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ELEVENLABS_BASE_URL;
    const stripped = raw.replace(/\/+$/, "");
    return /\/v\d+$/.test(stripped) ? stripped : `${stripped}/v1`;
}

type ElevenVoicesPayload = {
    voices?: Array<Record<string, unknown>>;
};

function extractVoices(payload: ElevenVoicesPayload): { id: string; name: string }[] {
    if (!Array.isArray(payload.voices)) return [];
    return payload.voices.flatMap(voice => {
        const voiceId = typeof voice.voice_id === "string" ? voice.voice_id.trim() : "";
        if (!voiceId) return [];
        const name = typeof voice.name === "string" && voice.name.trim() ? voice.name.trim() : voiceId;
        return [{ id: voiceId, name }];
    });
}

function readErrorMessage(payload: unknown, fallback: string): string {
    if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        const detail = record.detail;
        if (typeof detail === "string" && detail.trim()) return detail;
        if (detail && typeof detail === "object") {
            const d = detail as Record<string, unknown>;
            const message = String(d.message || d.status || "");
            if (message.trim()) return message;
        }
        const message = String(record.message || "");
        if (message.trim()) return message;
    }
    return fallback;
}

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const baseUrl = normalizeBaseUrl(body.baseUrl);

        if (!apiKey) return NextResponse.json({ error: "missing_api_key" }, { status: 400 });

        const response = await proxyFetch(`${baseUrl}/voices`, {
            method: "GET",
            headers: {
                "xi-api-key": apiKey,
                Accept: "application/json",
            },
        });

        const text = await response.text();
        let data: unknown = null;
        try {
            data = JSON.parse(text);
        } catch {
            return NextResponse.json({ error: "upstream_not_json", message: text.slice(0, 500) }, { status: 502 });
        }

        if (!response.ok) {
            return NextResponse.json(
                { error: "get_voice_failed", message: readErrorMessage(data, `HTTP ${response.status}`).slice(0, 500) },
                { status: 502 },
            );
        }

        return NextResponse.json({ ok: true, voices: extractVoices(data as ElevenVoicesPayload) });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: "get_voice_failed", message: message.slice(0, 500) }, { status: 502 });
    }
}
