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

  try {
    // 1. Fetch an existing web image of a cat in nature (using a Wikimedia photo)
    const sourceImageUrl = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/320px-Cat03.jpg";
    const imageResponse = await fetch(sourceImageUrl);

    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch source image: ${imageResponse.status}`);
    }

    // Convert the image buffer to Base64
    const imageBuffer = await imageResponse.arrayBuffer();
    const bytes = new Uint8Array(imageBuffer);
    let binaryString = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binaryString += String.fromCharCode(bytes[i]);
    }
    const base64Image = btoa(binaryString);

    // 2. Send the image to Gemini with instructions to convert it into HTML/SVG
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`;

    const prompt = `Analyze this cat picture. Recreate the image as a standalone, visually detailed SVG/HTML snippet with shapes, gradients, and colors matching the cat and background. 
    Return ONLY valid, raw HTML/SVG markup (starting with <svg> or <div> and ending with </svg> or </div>). Do NOT include markdown formatting, backticks, or explanations.`;

    const geminiResponse = await fetch(url, {
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

    if (!geminiResponse.ok) {
      const errorDetails = await geminiResponse.text();
      return new Response(
        JSON.stringify({ error: `Gemini API returned status ${geminiResponse.status}`, details: errorDetails }),
        { status: geminiResponse.status, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await geminiResponse.json();
    let rawHtml = data.candidates?.[0]?.content?.parts?.[0]?.text || "<p>No output generated</p>";

    // Clean any markdown code blocks if returned
    rawHtml = rawHtml.replace(/```html/gi, "").replace(/```/g, "").trim();

    return new Response(
      JSON.stringify({
        sourceImageUrl: sourceImageUrl,
        generatedHtml: rawHtml,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to convert image to HTML", details: err.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}