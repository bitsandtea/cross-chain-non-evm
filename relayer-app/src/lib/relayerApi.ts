export async function callRelayerApi(
  endpoint: string,
  method: string,
  body?: object
) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const response = await fetch(`${baseUrl}/api/relayer${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(
      `Relayer API call failed with status ${response.status}: ${errorData}`
    );
  }
  return response.json();
}
