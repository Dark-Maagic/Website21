// functions/api/coingrader.js

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 request per 60 seconds per user
const ipCooldownMap = new Map();

const EXACT_SYSTEM_PROMPT =
  "Attached here are images of the obverse and reverse of the same coin. Grade both the obverse and reverse according to official standards, and generate a grading report for the obverse and reverse separately, as well as an overall composite grade.";

// Top existing Gemini models supported by the Interactions API
const CANDIDATE_MODELS = [
  "gemini-4-argon",
  "gemini-3.8-flash"
];

const GRADING_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    coinIdentification: {
      type: "string",
      description: "Country, denomination, year, mintmark, and variety if identifiable from the obverse and reverse."
    },
    obverseGrade: {
      type: "string",
      description: "Official Sheldon scale grade for the obverse (e.g., MS-64, AU-58, XF-45, VF-30)."
    },
    obverseReport: {
      type: "string",
      description: "Detailed grading report for the obverse evaluating strike sharpness, surface preservation, luster, wear, contact marks, and eye appeal."
    },
    reverseGrade: {
      type: "string",
      description: "Official Sheldon scale grade for the reverse (e.g., MS-65, AU-58, XF-40, VF-25)."
    },
    reverseReport: {
      type: "string",
      description: "Detailed grading report for the reverse evaluating strike sharpness, surface preservation, luster, wear, contact marks, and eye appeal."
    },
    compositeGrade: {
      type: "string",
      description: "Overall official composite grade on the Sheldon scale (e.g., MS-64, AU-58)."
    },
    compositeReport: {
      type: "string",
      description: "Comprehensive composite grading report synthesizing the obverse and reverse findings into the final overall grade."
    }
  },
  required: [
    "coinIdentification",
    "obverseGrade",
    "obverseReport",
    "reverseGrade",
    "reverseReport",
    "compositeGrade",
    "compositeReport"
  ]
};

/**
 * Checks and records a 1-request-per-minute rate limit per user IP
 * using both isolate memory and Cloudflare's Edge Cache API.
 */
async function checkRateLimit(request) {
  const clientIp =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "anonymous-client";

  const now = Date.now();

  // 1. Check in-memory isolate map
  const lastHit = ipCooldownMap.get(clientIp);
  if (lastHit && now - lastHit < RATE_LIMIT_WINDOW_MS) {
    const retryAfterSeconds = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - lastHit)) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  // 2. Check Cloudflare edge cache (persists across isolates on the same POP)
  const cache = caches.default;
  const cacheKey = new Request(`https://rate-limit.internal/coingrader/${encodeURIComponent(clientIp)}`);
  const cachedResp = await cache.match(cacheKey);

  if (cachedResp) {
    const cachedTs = parseInt(await cachedResp.text(), 10);
    if (!Number.isNaN(cachedTs) && now - cachedTs < RATE_LIMIT_WINDOW_MS) {
      const retryAfterSeconds = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - cachedTs)) / 1000);
      ipCooldownMap.set(clientIp, cachedTs);
      return { allowed: false, retryAfterSeconds };
    }
  }

  // Record timestamp for this IP
  ipCooldownMap.set(clientIp, now);
  await cache.put(
    cacheKey,
    new Response(String(now), {
      headers: { "Cache-Control": "max-age=60" }
    })
  );

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Extracts text output from the Gemini Interactions API response structure.
 */
function extractInteractionText(interactionData) {
  if (typeof interactionData?.output_text === "string" && interactionData.output_text.trim()) {
    return interactionData.output_text.trim();
  }

  // Standard Interactions API `steps` array (May 2026+ GA schema)
  if (Array.isArray(interactionData?.steps)) {
    const textChunks = [];
    for (const step of interactionData.steps) {
      if (step.type === "model_output" && Array.isArray(step.content)) {
        for (const item of step.content) {
          if (item.type === "text" && typeof item.text === "string") {
            textChunks.push(item.text);
          }
        }
      }
    }
    if (textChunks.length > 0) {
      return textChunks.join("\n").trim();
    }
  }

  // Fallback for legacy `outputs` array if returned
  if (Array.isArray(interactionData?.outputs)) {
    const legacyChunks = interactionData.outputs
      .filter((o) => o.type === "text" && typeof o.text === "string")
      .map((o) => o.text);
    if (legacyChunks.length > 0) {
      return legacyChunks.join("\n").trim();
    }
  }

  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Server configuration error: GEMINI_API_KEY is not set in Cloudflare environment variables." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Enforce 1 request per minute per user
  const rateCheck = await checkRateLimit(request);
  if (!rateCheck.allowed) {
    return new Response(
      JSON.stringify({
        error: `Rate limit active: Maximum 1 grading request per minute. Please wait ${rateCheck.retryAfterSeconds}s.`,
        retryAfterSeconds: rateCheck.retryAfterSeconds
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(rateCheck.retryAfterSeconds)
        }
      }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return new Response(
      JSON.stringify({ error: "Invalid JSON request body." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const obverse = body?.obverse;
  const reverse = body?.reverse;

  if (!obverse?.data || !reverse?.data) {
    return new Response(
      JSON.stringify({ error: "Both obverse and reverse coin images are required." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  let lastErrorDetails = null;

  // Call the Gemini Interactions API (https://generativelanguage.googleapis.com/v1beta/interactions)
  for (const model of CANDIDATE_MODELS) {
    try {
      const interactionPayload = {
        model,
        system_instruction: EXACT_SYSTEM_PROMPT,
        input: [
          {
            type: "text",
            text: "The first image below is the OBVERSE of the coin, and the second image is the REVERSE of the same coin."
          },
          {
            type: "image",
            data: obverse.data,
            mime_type: obverse.mimeType || "image/jpeg"
          },
          {
            type: "image",
            data: reverse.data,
            mime_type: reverse.mimeType || "image/jpeg"
          }
        ],
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: GRADING_RESPONSE_SCHEMA
        },
        store: false
      };

      const geminiResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
            "Api-Revision": "2026-05-20"
          },
          body: JSON.stringify(interactionPayload)
        }
      );

      const interactionData = await geminiResponse.json();

      if (!geminiResponse.ok) {
        lastErrorDetails = interactionData;
        continue; // Try fallback model if primary model is unavailable on this key tier
      }

      const rawText = extractInteractionText(interactionData);
      if (!rawText) {
        lastErrorDetails = { message: "Empty output from Interactions API", interactionData };
        continue;
      }

      const parsedReport = JSON.parse(rawText);

      return new Response(
        JSON.stringify({
          modelUsed: model,
          interactionId: interactionData.id || null,
          ...parsedReport
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    } catch (err) {
      lastErrorDetails = { message: err.message };
    }
  }

  return new Response(
    JSON.stringify({
      error: "Gemini Interactions API failed to grade the coin images.",
      details: lastErrorDetails
    }),
    { status: 502, headers: { "Content-Type": "application/json" } }
  );
}