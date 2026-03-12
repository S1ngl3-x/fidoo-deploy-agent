export async function fetchSecret(
  vaultName: string,
  secretName: string,
  vaultToken: string,
): Promise<string> {
  const url = `https://${vaultName}.vault.azure.net/secrets/${secretName}?api-version=7.4`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${vaultToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Key Vault fetch failed for '${secretName}': ${res.status} ${body}`);
  }

  const data = (await res.json()) as { value?: string };
  if (data.value == null) {
    throw new Error(`Key Vault response missing value for '${secretName}'`);
  }

  return data.value;
}
