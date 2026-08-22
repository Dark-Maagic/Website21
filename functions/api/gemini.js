export async function onRequest(context) {
  const apiKey = context.env.GEMINI_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY is not defined in Cloudflare settings." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // 1. Rotating library of high-quality cat photos in nature
  const catImages = [
    "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1543852786-1cf6624b9987?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1533738363-b7f9aef128ce?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1573865526739-10659fec78a5?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1518791841217-8f162f1e1131?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1561948955-570b270e7c36?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1495360010541-f48722b34f7d?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1513360375582-619d49866d99?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1574158622682-e40e69881006?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1478098711619-5ab0b478d6e6?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1535930891776-0c2dfb7fda1a?auto=format&fit=crop&w=700&q=80",
    "https://images.unsplash.com/photo-1519052537078-e6302a4968d4?auto=format&fit=crop&w=700&q=80"
  ];

  const randomIndex = Math.floor(Math.random() * catImages.length);
  const sourceImageUrl = catImages[randomIndex];

  try {
    // 2. Fetch the chosen image and convert to Base64
    const imageResponse = await fetch(sourceImageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch source image: ${imageResponse.status}`);
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const bytes = new Uint8Array(imageBuffer);
    let binaryString = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binaryString += String.fromCharCode(bytes[i]);
    }
    const base64Image = btoa(binaryString);

    const prompt = `Analyze this cat picture. Recreate the image as a standalone, visually detailed SVG/HTML snippet with shapes, gradients, and colors matching the cat and background. 
Return ONLY valid, raw HTML/SVG markup (starting with <svg> or <div> and ending with </svg> or </div>). Do NOT include markdown formatting, backticks, or explanations.`;

    // Exact model priority hierarchy
    const modelHierarchy = [
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite"
    ];

    let lastErrorDetails = "";
    let geminiResponse = null;
    let successfulModel = null;

    // 3. Iterate through fallback models
    for (const model of modelHierarchy) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      for (let attempt = 0; attempt < 2; attempt++) {
        geminiResponse = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    inline_data: {
                      mime_type: "image/jpeg",
                      data: base64Image,
                    },
                  },
                  {
                    text: prompt,
                  },
                ],
              },
            ],
          }),
        });

        if (geminiResponse.ok) {
          successfulModel = model;
          break;
        }

        lastErrorDetails = await geminiResponse.text();

        // Retry if 503 (high demand) or 429 (rate-limit)
        if (geminiResponse.status === 503 || geminiResponse.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        } else {
          break;
        }
      }

      if (geminiResponse && geminiResponse.ok) {
        break;
      }
    }

    if (!geminiResponse || !geminiResponse.ok) {
      return new Response(
        JSON.stringify({
          error: "Gemini 3.5 Flash Lite (and all preceding models: 3.7 Flash, 3.6 Flash, 3.5 Flash) failed to generate content.",
          details: lastErrorDetails,
        }),
        {
          status: geminiResponse ? geminiResponse.status : 503,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const data = await geminiResponse.json();
    let rawHtml = data.candidates?.[0]?.content?.parts?.[0]?.text || "<p>No output generated</p>";

    // Remove markdown code fences
    rawHtml = rawHtml.replace(/```html/gi, "").replace(/```/g, "").trim();

    return new Response(
      JSON.stringify({
        sourceImageUrl: sourceImageUrl,
        generatedHtml: rawHtml,
        modelUsed: successfulModel,
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
      JSON.stringify({ error: "Failed to process image", details: err.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}