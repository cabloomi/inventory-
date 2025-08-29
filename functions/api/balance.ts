export interface Env { SICKW_API_KEY: string; }

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const url = new URL("https://sickw.com/api.php");
  url.searchParams.set("action", "balance");
  url.searchParams.set("key", env.SICKW_API_KEY);

  const r = await fetch(url.toString());
  const text = await r.text();
  return new Response(JSON.stringify({ balance: text.trim() }), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
  });
};
