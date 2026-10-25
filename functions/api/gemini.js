// Pre-allocated Base64 helper (uses native V8 Uint8Array.toBase64 when available,
// falling back to 32KB chunked String.fromCharCode to avoid O(N^2) string concatenation)
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof bytes.toBase64 === "function") {
    return bytes.toBase64();
  }
  const CHUNK_SIZE = 0x8000;
  const chunks = [];
  for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
    chunks.push(
      String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE))
    );
  }
  return btoa(chunks.join(""));
}

// Rotating library of cat photo IDs on Unsplash
const CAT_PHOTO_IDS = [
  "photo-1514888286974-6c03e2ca1dba",
  "photo-1543852786-1cf6624b9987",
  "photo-1533738363-b7f9aef128ce",
  "photo-1573865526739-10659fec78a5",
  "photo-1518791841217-8f162f1e1131",
  "photo-1561948955-570b270e7c36",
  "photo-1495360010541-f48722b34f7d",
  "photo-1513360375582-619d49866d99",
  "photo-1574158622682-e40e69881006",
  "photo-1478098711619-5ab0b478d6e6",
  "photo-1535930891776-0c2dfb7fda1a",
  "photo-1519052537078-e6302a4968d4",
];

// Active Flash model hierarchy with each model's lowest-latency thinking_level
// Note: gemini-3.8-flash minimum supported thinking_level is "low" ("minimal" returns 400).
// gemini-3.6-flash, gemini-3.5-flash-lite, and gemini-3.1-flash-lite support "minimal".
const MODEL_HIERARCHY = [
  { id: "gemini-3.8-flash", thinkingLevel: "low" },
  { id: "gemini-3.6-flash", thinkingLevel: "minimal" },
  { id: "gemini-3.5-flash-lite", thinkingLevel: "minimal" },
  { id: "gemini-3.1-flash-lite", thinkingLevel: "minimal" },
];

const SYSTEM_INSTRUCTION =
  "You are a fast, precision geometric SVG illustrator. " +
  "Output ONLY raw, valid <svg>...</svg> markup. " +
  "Never output markdown code fences, explanations, or XML comments. " +
  "Keep the SVG concise (under 3500 characters) using integer coordinates, clean <defs> gradients, and 25 to 45 layered vector shapes (<polygon>, <path>, <ellipse>, <circle>, <rect>).";

const USER_PROMPT =
  'Recreate this cat photo as an expressive, standalone geometric SVG illustration with viewBox="0 0 400 400" width="100%" height="100%". ' +
  "Accurately capture the background palette/lighting, the cat's exact posture, fur markings, ears, eyes, nose, and whiskers.";

export async function onRequest(context) {
  const startTime = Date.now();
  const apiKey = context.env.GEMINI_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: "GEMINI_API_KEY is not defined in Cloudflare settings.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Allow client to request a specific index (for instant client-side preview) or pick randomly
  const url = new URL(context.request.url);
  const requestedIndex = parseInt(url.searchParams.get("index"), 10);
  const index =
    !Number.isNaN(requestedIndex) && requestedIndex >= 0
      ? requestedIndex % CAT_PHOTO_IDS.length
      : Math.floor(Math.random() * CAT_PHOTO_IDS.length);

  const photoId = CAT_PHOTO_IDS[index];
  // High-res URL for browser display
  const sourceImageUrl = `https://images.unsplash.com/${photoId}?auto=format&fit=crop&w=700&q=80`;
  // Compact <=384px URL for Gemini vision ingestion (single tile, ~18KB, cached at Cloudflare Edge)
  const visionImageUrl = `https://images.unsplash.com/${photoId}?auto=format&fit=crop&w=384&q=70`;

  try {
    // 1. Fetch compact image with Cloudflare Edge Caching enabled
    const imageResponse = await fetch(visionImageUrl, {
      cf: {
        cacheEverything: true,
        cacheTtl: 86400,
      },
      headers: {
        "User-Agent": "Cloudflare-Workers-Image-Ingest/1.0",
        Accept: "image/jpeg,image/*;q=0.8",
      },
    });

    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch source image: ${imageResponse.status}`);
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = arrayBufferToBase64(imageBuffer);

    const interactionsUrl =
      "https://generativelanguage.googleapis.com/v1beta/interactions";
    let lastErrorDetails = "";
    let lastStatus = 503;
    let interactionData = null;
    let successfulModel = null;

    // 2. Iterate through fallback models using the Interactions API (fail-fast on 429/503)
    for (const modelConfig of MODEL_HIERARCHY) {
      try {
        const geminiResponse = await fetch(interactionsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          signal: AbortSignal.timeout(14000), // Prevent hung connections from stalling the Worker
          body: JSON.stringify({
            model: modelConfig.id,
            store: false, // Stateless execution for single-turn Worker requests
            system_instruction: SYSTEM_INSTRUCTION,
            generation_config: {
              thinking_level: modelConfig.thinkingLevel,
              max_output_tokens: 4096,
            },
            // Best practice: place text prompt before image in the input array
            input: [
              {
                type: "text",
                text: USER_PROMPT,
              },
              {
                type: "image",
                mime_type: "image/jpeg",
                data: base64Image,
                resolution: "low", // 280 tokens (vs 1,120 default), cutting vision prefill latency by 4x
              },
            ],
          }),
        });

        lastStatus = geminiResponse.status;

        if (geminiResponse.ok) {
          const data = await geminiResponse.json();
          if (data.status !== "failed" && data.status !== "incomplete") {
            interactionData = data;
            successfulModel = modelConfig.id;
            break;
          }
          lastErrorDetails = JSON.stringify(data.errors || data);
        } else {
          lastErrorDetails = await geminiResponse.text();
        }
      } catch (fetchErr) {
        lastErrorDetails = fetchErr.message || "Model request timed out";
      }
    }

    if (!successfulModel || !interactionData) {
      return new Response(
        JSON.stringify({
          error: `All Gemini models in rotation (${MODEL_HIERARCHY.map((m) => m.id).join(", ")}) failed to generate content.`,
          details: lastErrorDetails,
        }),
        {
          status: lastStatus,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 3. Extract text from the Interactions API `steps` timeline
    let rawHtml =
      interactionData.steps
        ?.filter((step) => step.type === "model_output")
        .flatMap((step) => step.content || [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("") ||
      interactionData.output_text ||
      "";

    // Strip markdown fences if any and isolate the <svg> or <div> root element
    rawHtml = rawHtml
      .replace(/```(?:html|svg|xml)?/gi, "")
      .replace(/```/g, "")
      .trim();

    const svgMatch = rawHtml.match(/<svg[\s\S]*<\/svg>/i);
    if (svgMatch) {
      rawHtml = svgMatch[0];
    }

    if (!rawHtml) {
      rawHtml = "<p>No output generated</p>";
    }

    return new Response(
      JSON.stringify({
        sourceImageUrl,
        generatedHtml: rawHtml,
        modelUsed: successfulModel,
        latencyMs: Date.now() - startTime,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Failed to process image",
        details: err.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}