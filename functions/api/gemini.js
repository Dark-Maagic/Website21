export async function onRequest(context) {
  // Pool of high-quality photos of cats outdoors in nature
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

  // Randomly select one image from the rotation
  const randomIndex = Math.floor(Math.random() * catImages.length);
  const selectedImageUrl = catImages[randomIndex];

  return new Response(
    JSON.stringify({
      sourceImageUrl: selectedImageUrl,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        // Prevent browser caching so every button click fetches a new random image
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    }
  );
}