export async function onRequest(context) {
  // Replace GEMINI_API_KEY with whatever name you gave your secret in Cloudflare Pages
  const apiKey = context.env.GEMINI_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY is not defined in project settings." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Sample prompt to test connectivity
  const prompt = "Give me a one-sentence inspiring quote about programming.";

  // Using the Gemini Flash model
 const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`;

  try {
    const geminiResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
    });

    if (!geminiResponse.ok) {
      const errorDetails = await geminiResponse.text();
      return new Response(
        JSON.stringify({
          error: `Gemini API returned status ${geminiResponse.status}`,
          details: errorDetails,
        }),
        {
          status: geminiResponse.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const data = await geminiResponse.json();
    
    // Extract the generated text from Gemini's response payload
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "No text returned.";

    return new Response(
      JSON.stringify({
        prompt: prompt,
        reply: replyText,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to connect to Gemini API", details: err.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}