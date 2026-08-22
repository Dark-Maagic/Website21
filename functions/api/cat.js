export async function onRequest(context) {
  // We use double backslashes to properly escape the backslash in Javascript
  const asciiCat = `
 /\\_/\\
( o.o )
 > ^ <
  `;

  return new Response(asciiCat, {
    headers: {
      "content-type": "text/plain;charset=UTF-8",
    },
  });
}