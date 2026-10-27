// Test preload (node --import) for subprocesses that reach jev-client: answers
// the Jev endpoint locally so a suite never calls the provider. Every question
// passes except `duplicate`, which answers "not a duplicate".
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://api.typesafe.ai/')) return realFetch(url, init);
  const { questions } = JSON.parse(init.body);
  const answers = Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: key === 'duplicate' ? 0.05 : 0.95 }]));
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
